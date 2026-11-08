import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BotService, PendingMessageType } from '../../bot/services/bot.service';
import { PowerScheduleConfigService } from './power-schedule-config.service';
import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';
import {
  INormalizedSchedule,
  IScheduleItemHours,
  PowerScheduleProviderId,
} from '../interfaces/schedule.interface';
import { ProcessedScheduleInfo } from '../schemas/processed-schedule-info.schema';
import { ProcessedEmergencyShutdowns } from '../schemas/processed-emergency-shutdowns.schema';
import {
  buildDayScheduleMessage,
  buildEmergencyShutdownsMessage,
  buildScheduleSourceLine,
  buildScheduleTitleLine,
} from '../helpers/schedule-message.helper';
import { normalizeScheduleDate } from '../helpers/normalize-schedule-date.helper';

const SEND_TO_GROUPS_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const SEND_TO_GROUPS_COOLDOWN_MINUTES = SEND_TO_GROUPS_COOLDOWN_MS / 60_000;
const EMERGENCY_SHUTDOWNS_MUTEX_KEY = 'emergency-shutdowns';

@Injectable()
export class PowerScheduleOrchestratorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PowerScheduleOrchestratorService.name);
  private readonly dateMutexes = new Map<string, Promise<unknown>>();
  private readonly lastSentToGroupsAtByDate = new Map<string, Date>();
  private lastEmergencyShutdownsSentAt?: Date;

  constructor(
    @InjectModel(ProcessedScheduleInfo.name) private processedScheduleInfoModel: Model<ProcessedScheduleInfo>,
    @InjectModel(ProcessedEmergencyShutdowns.name)
    private processedEmergencyShutdownsModel: Model<ProcessedEmergencyShutdowns>,
    private readonly botService: BotService,
    private readonly powerScheduleConfigService: PowerScheduleConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.botService.events.on(
      PendingMessageType.GetSchedule,
      (options: { day: 'today' | 'tomorrow'; chatId: number }) => {
        this.sendScheduleToChat(options.day, options.chatId).then();
      },
    );
    this.botService.events.on(
      PendingMessageType.SendScheduleToAll,
      (options: { day: 'today' | 'tomorrow' }) => {
        this.sendScheduleToChat(options.day, undefined, true).then();
      },
    );
    this.botService.events.on(
      PendingMessageType.GetEmergencyShutdowns,
      (options: { chatId: number }) => {
        this.sendEmergencyShutdownsToChat(options.chatId).then();
      },
    );
    this.botService.events.on(
      PendingMessageType.SendEmergencyShutdownsToAll,
      () => {
        this.sendEmergencyShutdownsToChat(undefined, true).then();
      },
    );
  }

  /**
   * Called by a provider when it detects a new or changed schedule for a date.
   * Orchestrator decides whether to send (most recent wins) and persists.
   * Serialized per dateIso to avoid race where two providers both send before either persists.
   */
  async onScheduleChange(
    providerId: PowerScheduleProviderId,
    date: Date,
    normalizedSchedule: INormalizedSchedule,
  ): Promise<void> {
    const normalizedDate = normalizeScheduleDate(date);
    const dateIso = normalizedDate.toISOString();

    await this.withDateMutex(
      dateIso,
      () => this.handleScheduleChange(providerId, dateIso, normalizedDate, normalizedSchedule),
    );
  }

  /**
   * Called by a provider when it sees emergency shutdowns start or end. The state is shared by all
   * providers: a state already sent is skipped, and when providers disagree the more recently
   * updated report wins. Serialized like schedules, so two providers reporting at once don't both send.
   */
  async onEmergencyShutdownsChange(
    providerId: PowerScheduleProviderId,
    isActive: boolean,
    updatedAt: Date,
    groupKey?: string,
  ): Promise<void> {
    await this.withDateMutex(
      EMERGENCY_SHUTDOWNS_MUTEX_KEY,
      () => this.handleEmergencyShutdownsChange(providerId, isActive, updatedAt, groupKey),
    );
  }

  private async handleEmergencyShutdownsChange(
    providerId: PowerScheduleProviderId,
    isActive: boolean,
    updatedAt: Date,
    groupKey?: string,
  ): Promise<void> {
    const prevProcessed = await this.processedEmergencyShutdownsModel.findOne().lean().exec();
    const messageText = buildEmergencyShutdownsMessage(providerId, isActive, groupKey);
    const processed: ProcessedEmergencyShutdowns = { providerId, isActive, groupKey, updatedAt };
    const logParams = `providerId=${providerId}, isActive=${isActive}, updatedAt=${updatedAt.toISOString()}`;

    if (prevProcessed?.isActive === isActive) {
      this.logger.debug(`Emergency shutdowns change ignored (not changed): ${logParams}`);
      void this.botService.sendMessageToOwner(
        new BotMessageText().addLine(`Skipped (${providerId}): `).newLine().merge(messageText),
      );
      if (updatedAt.getTime() > prevProcessed.updatedAt.getTime()) {
        await this.persistEmergencyShutdowns(processed);
      }
      return;
    }

    if (prevProcessed && updatedAt.getTime() < prevProcessed.updatedAt.getTime()) {
      const prevParams = `${prevProcessed.providerId} at ${prevProcessed.updatedAt.toISOString()}`;
      this.logger.debug(`Emergency shutdowns change ignored (older than ${prevParams}): ${logParams}`);
      void this.botService.sendMessageToOwner(
        new BotMessageText()
          .addLine(`Skipped (${providerId}, updated ${updatedAt.toISOString()}, older than ${prevParams}): `)
          .newLine()
          .merge(messageText),
      );
      return;
    }

    const now = new Date();
    const withinCooldown = this.lastEmergencyShutdownsSentAt
      && (now.getTime() - this.lastEmergencyShutdownsSentAt.getTime()) < SEND_TO_GROUPS_COOLDOWN_MS;

    if (!prevProcessed && !isActive) {
      this.logger.debug(`Emergency shutdowns not active, nothing to send: ${logParams}`);
    } else if (withinCooldown) {
      this.logger.debug(`Emergency shutdowns change skipped (cooldown): ${logParams}`);
      void this.botService.sendMessageToOwner(
        new BotMessageText()
          .addLine(`ATTENTION! Skipped (sent in last ${SEND_TO_GROUPS_COOLDOWN_MINUTES} mins): ${providerId}`)
          .newLine()
          .merge(messageText),
      );
    } else {
      this.lastEmergencyShutdownsSentAt = now;
      // Owner only while the detection is being verified, then all enabled groups
      void this.botService.sendMessageToOwner(messageText);
      this.logger.debug(`Emergency shutdowns change sent: ${logParams}`);
    }
    await this.persistEmergencyShutdowns(processed);
  }

  private async persistEmergencyShutdowns(processed: ProcessedEmergencyShutdowns): Promise<void> {
    await this.processedEmergencyShutdownsModel.findOneAndReplace({}, processed, { upsert: true });
  }

  private async withDateMutex<T>(dateIso: string, fn: () => Promise<T>): Promise<T> {
    const hasPrevious = this.dateMutexes.has(dateIso);
    if (hasPrevious) {
      this.logger.debug(`Waiting for previous onScheduleChange to finish: dateIso=${dateIso}`);
    }
    const prev = this.dateMutexes.get(dateIso) ?? Promise.resolve();
    const current = prev
      .then(() => fn())
      .finally(() => {
        if (this.dateMutexes.get(dateIso) === current) {
          this.dateMutexes.delete(dateIso);
        }
      });
    this.dateMutexes.set(dateIso, current);
    return current;
  }

  private async handleScheduleChange(
    providerId: PowerScheduleProviderId,
    dateIso: string,
    normalizedDate: Date,
    normalizedSchedule: INormalizedSchedule,
  ): Promise<void> {
    const dateIsoKey: keyof ProcessedScheduleInfo = 'dateIso';
    const prevProcessed = await this.processedScheduleInfoModel.findOne({ [dateIsoKey]: dateIso }).lean().exec();

    if (prevProcessed) {
      const isScheduleChanged = Object.entries(prevProcessed.scheduleItemHours).some(([halfHour, processedPowerState]) => {
        return normalizedSchedule.hours[halfHour] !== processedPowerState;
      });
      if (!isScheduleChanged) {
        await this.handleUnchangedSchedule(providerId, dateIso, normalizedDate, normalizedSchedule);
        return;
      }
    }

    const messageText = this.buildScheduleMessageText(
      providerId,
      normalizedDate,
      !prevProcessed,
      normalizedSchedule.hours,
      normalizedSchedule.groupKey,
    );
    await this.deliverScheduleToGroups(providerId, dateIso, messageText, normalizedSchedule);
    this.logger.debug(`Schedule sent: dateIso=${dateIso}, providerId=${providerId}`);
  }

  private async handleUnchangedSchedule(
    providerId: PowerScheduleProviderId,
    dateIso: string,
    normalizedDate: Date,
    normalizedSchedule: INormalizedSchedule,
  ): Promise<void> {
    this.logger.debug(`Schedule change ignored (not changed): dateIso=${dateIso}, providerId=${providerId}`);
    const messageText = new BotMessageText()
      .addLine(`Skipped (${providerId}, ${dateIso}): `)
      .newLine()
      .merge(
        this.buildScheduleMessageText(
          providerId,
          normalizedDate,
          false,
          normalizedSchedule.hours,
          normalizedSchedule.groupKey,
        ),
      )
    void this.botService.sendMessageToOwner(messageText);
  }

  private buildScheduleMessageText(
    providerId: PowerScheduleProviderId,
    normalizedDate: Date,
    isFirstScheduleForDay: boolean,
    scheduleItemHours: IScheduleItemHours,
    groupKey?: string,
  ): BotMessageText {
    return new BotMessageText()
      .addLine(BotMessageText.bold(buildScheduleTitleLine(normalizedDate, isFirstScheduleForDay)))
      .newLine()
      .merge(buildDayScheduleMessage(scheduleItemHours))
      .newLine()
      .add(BotMessageText.italic(buildScheduleSourceLine(providerId, groupKey)));
  }

  private async deliverScheduleToGroups(
    providerId: PowerScheduleProviderId,
    dateIso: string,
    messageText: BotMessageText,
    normalizedSchedule: INormalizedSchedule,
  ): Promise<void> {
    if (!this.powerScheduleConfigService.isScheduleSendingEnabled()) {
      void this.botService.sendMessageToOwner(
        new BotMessageText(`Tried to send schedule, but sending is disabled (${providerId}, ${dateIso}) text:\n\n${messageText.toString()}`),
      );
      await this.persistProcessed(providerId, dateIso, new Date(), normalizedSchedule);
      return;
    }

    const now = new Date();
    const lastSentForDate = this.lastSentToGroupsAtByDate.get(dateIso);
    const withinCooldown = lastSentForDate
      && (now.getTime() - lastSentForDate.getTime()) < SEND_TO_GROUPS_COOLDOWN_MS;

    if (withinCooldown) {
      this.logger.debug(`Schedule change skipped (cooldown): dateIso=${dateIso}, providerId=${providerId}`);
      const ownerMessageText = new BotMessageText()
        .addLine(`ATTENTION! Skipped (sent to groups in last ${SEND_TO_GROUPS_COOLDOWN_MINUTES} mins): ${providerId}, ${dateIso}`)
        .newLine()
        .merge(messageText);
      void this.botService.sendMessageToOwner(ownerMessageText);
    } else {
      this.lastSentToGroupsAtByDate.set(dateIso, now);
      await this.botService.sendMessageToAllEnabledGroups(messageText);
      const ownerMessageText = new BotMessageText()
        .addLine(`Sent (${providerId}, ${dateIso})`)
        .newLine()
        .merge(messageText);
      void this.botService.sendMessageToOwner(ownerMessageText);
    }
    await this.persistProcessed(providerId, dateIso, new Date(), normalizedSchedule);
  }

  private async persistProcessed(
    providerId: PowerScheduleProviderId,
    dateIso: string,
    updatedAt: Date,
    normalizedSchedule: INormalizedSchedule,
  ): Promise<void> {
    const scheduleInfo: ProcessedScheduleInfo = {
      dateIso,
      providerId,
      updatedAt,
      scheduleItemHours: normalizedSchedule.hours,
      groupKey: normalizedSchedule.groupKey,
    };
    const dateInfoKey: keyof ProcessedScheduleInfo = 'dateIso';

    await this.processedScheduleInfoModel.findOneAndReplace(
      { [dateInfoKey]: dateIso },
      scheduleInfo,
      { upsert: true },
    );
  }

  private async sendScheduleToChat(
    day: 'today' | 'tomorrow',
    chatId?: number,
    sendToGroups = false,
  ): Promise<void> {
    this.logger.debug(`Sending schedule to chat... (day=${day}, chatId=${chatId}, sendToGroups=${sendToGroups})`);

    const date = normalizeScheduleDate(new Date());
    if (day === 'tomorrow') {
      date.setDate(date.getDate() + 1);
    }
    const dateIso = date.toISOString();

    const dateIsoKey: keyof ProcessedScheduleInfo = 'dateIso';
    const prevProcessed: ProcessedScheduleInfo = await this.processedScheduleInfoModel
      .findOne({ [dateIsoKey]: dateIso })
      .lean()
      .exec();

    if (!prevProcessed) {
      const message = `Sending schedule to chat: Failed: No schedule available for ${day} (dateIso=${dateIso}, chatId=${chatId}, sendToGroups=${sendToGroups})`;
      this.logger.warn(message);
      void this.botService.sendMessageToOwner(new BotMessageText(message));
      return;
    }

    const messageText = this.buildScheduleMessageText(
      prevProcessed.providerId,
      date,
      true,
      prevProcessed.scheduleItemHours,
      prevProcessed.groupKey,
    );

    if (chatId !== undefined) {
      await this.botService.sendMessage(chatId, messageText);
    } else if (sendToGroups) {
      if (this.powerScheduleConfigService.isScheduleSendingEnabled()) {
        await this.botService.sendMessageToAllEnabledGroups(messageText);

        const ownerMessageText = new BotMessageText()
          .addLine(`Sent (${prevProcessed.providerId}, ${dateIso})`)
          .newLine()
          .merge(messageText);
        void this.botService.sendMessageToOwner(ownerMessageText);
      } else {
        void this.botService.sendMessageToOwner(new BotMessageText(`Tried to send schedule to groups, but sending is disabled (${prevProcessed.providerId}, ${dateIso}) text:\n\n${messageText.toString()}`));
      }
    }
  }

  private async sendEmergencyShutdownsToChat(chatId?: number, sendToGroups = false): Promise<void> {
    this.logger.debug(`Sending emergency shutdowns to chat... (chatId=${chatId}, sendToGroups=${sendToGroups})`);

    try {
      const prevProcessed = await this.processedEmergencyShutdownsModel.findOne().lean().exec();
      if (!prevProcessed) {
        const message = `Sending emergency shutdowns to chat: Failed: No emergency shutdowns state available (chatId=${chatId}, sendToGroups=${sendToGroups})`;
        this.logger.warn(message);
        void this.botService.sendMessageToOwner(new BotMessageText(message));
        return;
      }

      const { providerId, isActive, groupKey, updatedAt } = prevProcessed;
      const messageText = buildEmergencyShutdownsMessage(providerId, isActive, groupKey);

      if (chatId !== undefined) {
        await this.botService.sendMessage(chatId, messageText);
      } else if (sendToGroups) {
        if (this.powerScheduleConfigService.isEmergencyShutdownsSendingEnabled()) {
          await this.botService.sendMessageToAllEnabledGroups(messageText);

          const ownerMessageText = new BotMessageText()
            .addLine(`Sent (${providerId}, updated ${updatedAt.toISOString()})`)
            .newLine()
            .merge(messageText);
          void this.botService.sendMessageToOwner(ownerMessageText);
        } else {
          void this.botService.sendMessageToOwner(new BotMessageText(`Tried to send emergency shutdowns to groups, but emergency shutdowns sending is disabled (${providerId}) text:\n\n${messageText.toString()}`));
        }
      }
    } catch (e) {
      const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
      this.logger.error(`Sending emergency shutdowns to chat: Failed: ${errorMessage}`);
      void this.botService.sendMessageToOwner(new BotMessageText(`Failed to send emergency shutdowns: ${errorMessage}`));
    }
  }
}
