import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BotService, PendingMessageType } from '../../bot/services/bot.service';
import { IChatMessageRef } from '../../bot/interfaces/chat-message-ref.interface';
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
import { mergeChatMessageRefs } from '../helpers/merge-chat-message-refs.helper';

const SEND_TO_GROUPS_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const SEND_TO_GROUPS_COOLDOWN_MINUTES = SEND_TO_GROUPS_COOLDOWN_MS / 60_000;
const EMERGENCY_SHUTDOWNS_MUTEX_KEY = 'emergency-shutdowns';

type ScheduleDay = 'today' | 'tomorrow';

interface ISentToGroups {
  /** The messages a later message replies to, one per group. */
  sentMessages: IChatMessageRef[];
  broadcastId: string;
}

/**
 * Decides which schedules and emergency shutdowns states reach the groups, and remembers the group
 * messages that announced them, so follow-ups are sent as replies: a newer schedule for the same date
 * replies to the previous one, and the end of emergency shutdowns replies to their start.
 */
@Injectable()
export class PowerScheduleOrchestratorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PowerScheduleOrchestratorService.name);
  private readonly mutexes = new Map<string, Promise<unknown>>();
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
      (options: { day: ScheduleDay; chatId: number }) => {
        this.sendScheduleToChat(options.day, options.chatId)
          .catch((e) => this.reportFailure(`Sending schedule to chat`, e));
      },
    );
    this.botService.events.on(
      PendingMessageType.SendScheduleToAll,
      (options: { day: ScheduleDay }) => {
        this.sendScheduleToGroups(options.day)
          .catch((e) => this.reportFailure(`Sending schedule to groups`, e));
      },
    );
    this.botService.events.on(
      PendingMessageType.GetEmergencyShutdowns,
      (options: { chatId: number }) => {
        this.sendEmergencyShutdownsToChat(options.chatId)
          .catch((e) => this.reportFailure(`Sending emergency shutdowns to chat`, e));
      },
    );
    this.botService.events.on(
      PendingMessageType.SendEmergencyShutdownsToAll,
      () => {
        this.sendEmergencyShutdownsToGroups()
          .catch((e) => this.reportFailure(`Sending emergency shutdowns to groups`, e));
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

    await this.withMutex(
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
    await this.withMutex(
      EMERGENCY_SHUTDOWNS_MUTEX_KEY,
      () => this.handleEmergencyShutdownsChange(providerId, isActive, updatedAt, groupKey),
    );
  }

  /**
   * Runs `fn` after every earlier run with the same key has finished. Everything that reads a processed
   * document and then replaces it runs under its key, so concurrent runs don't overwrite each other.
   */
  private async withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.mutexes.has(key)) {
      this.logger.debug(`Waiting for previous run to finish: key=${key}`);
    }
    const prev = this.mutexes.get(key) ?? Promise.resolve();
    const current = prev
      .then(() => fn())
      .finally(() => {
        if (this.mutexes.get(key) === current) {
          this.mutexes.delete(key);
        }
      });
    this.mutexes.set(key, current);
    return current;
  }

  private async handleEmergencyShutdownsChange(
    providerId: PowerScheduleProviderId,
    isActive: boolean,
    updatedAt: Date,
    groupKey?: string,
  ): Promise<void> {
    const prevProcessed = await this.findProcessedEmergencyShutdowns();
    const messageText = buildEmergencyShutdownsMessage(providerId, isActive, groupKey);
    const processed: ProcessedEmergencyShutdowns = {
      providerId,
      isActive,
      groupKey,
      updatedAt,
      activeSentMessages: prevProcessed?.activeSentMessages ?? [],
    };
    const logParams = `providerId=${providerId}, isActive=${isActive}, updatedAt=${updatedAt.toISOString()}`;

    if (prevProcessed?.isActive === isActive) {
      this.logger.debug(`Emergency shutdowns change ignored (not changed): ${logParams}`);
      void this.botService.sendMessageToOwner(
        new BotMessageText().addLine(`Skipped (not changed): `).newLine().merge(messageText),
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
          .addLine(`Skipped (updated ${updatedAt.toISOString()}, older than ${prevParams}): `)
          .newLine()
          .merge(messageText),
      );
      return;
    }

    const now = new Date();
    const withinCooldown = this.lastEmergencyShutdownsSentAt
      && (now.getTime() - this.lastEmergencyShutdownsSentAt.getTime()) < SEND_TO_GROUPS_COOLDOWN_MS;

    const isSendingEnabled = this.powerScheduleConfigService.isEmergencyShutdownsSendingEnabled();

    if (!prevProcessed && !isActive) {
      this.logger.debug(`Emergency shutdowns not active, nothing to send: ${logParams}`);
    } else if (!isSendingEnabled || withinCooldown) {
      if (!isSendingEnabled) {
        this.logger.debug(`Emergency shutdowns change skipped (sending disabled): ${logParams}`);
        this.sendDisabledNoticeToOwner('emergency shutdowns', providerId, messageText);
      } else {
        this.logger.debug(`Emergency shutdowns change skipped (cooldown): ${logParams}`);
        void this.botService.sendMessageToOwner(
          new BotMessageText()
            .addLine(`ATTENTION! Skipped (sent in last ${SEND_TO_GROUPS_COOLDOWN_MINUTES} mins)`)
            .newLine()
            .merge(messageText),
        );
      }
      if (isActive) {
        // This start was not announced, so its end must not reply to the start of earlier ones
        processed.activeSentMessages = [];
      }
    } else {
      this.lastEmergencyShutdownsSentAt = now;
      const { sentMessages, broadcastId } = await this.sendEmergencyShutdownsMessageToGroups(
        messageText,
        isActive,
        processed.activeSentMessages,
      );
      processed.activeSentMessages = sentMessages;
      this.sendSentCopyToOwner(`updated ${updatedAt.toISOString()}`, broadcastId, messageText);
      this.logger.debug(`Emergency shutdowns change sent: ${logParams}`);
    }
    await this.persistEmergencyShutdowns(processed);
  }

  /**
   * Sends the emergency shutdowns message to all enabled groups. The end of emergency shutdowns is sent
   * as a reply to the messages that announced their start. The result holds the start messages to keep.
   */
  private async sendEmergencyShutdownsMessageToGroups(
    messageText: BotMessageText,
    isActive: boolean,
    activeSentMessages: IChatMessageRef[],
  ): Promise<ISentToGroups> {
    const { sentMessages, broadcastId } = await this.botService.sendMessageToAllEnabledGroups(messageText, {
      replyTo: isActive ? undefined : activeSentMessages,
    });
    return { sentMessages: isActive ? sentMessages : activeSentMessages, broadcastId };
  }

  private async findProcessedEmergencyShutdowns(): Promise<ProcessedEmergencyShutdowns | null> {
    return this.processedEmergencyShutdownsModel.findOne().lean().exec();
  }

  private async persistEmergencyShutdowns(processed: ProcessedEmergencyShutdowns): Promise<void> {
    await this.processedEmergencyShutdownsModel.findOneAndReplace({}, processed, { upsert: true });
  }

  private async handleScheduleChange(
    providerId: PowerScheduleProviderId,
    dateIso: string,
    normalizedDate: Date,
    normalizedSchedule: INormalizedSchedule,
  ): Promise<void> {
    const prevProcessed = await this.findProcessedSchedule(dateIso);

    if (prevProcessed && !this.isScheduleChanged(prevProcessed.scheduleItemHours, normalizedSchedule.hours)) {
      this.handleUnchangedSchedule(providerId, dateIso, normalizedDate, normalizedSchedule);
      return;
    }

    const messageText = this.buildScheduleMessageText(
      providerId,
      normalizedDate,
      !prevProcessed,
      normalizedSchedule.hours,
      normalizedSchedule.groupKey,
    );
    const sentMessages = await this.deliverScheduleToGroups(
      providerId,
      dateIso,
      messageText,
      prevProcessed?.sentMessages ?? [],
    );
    await this.persistProcessedSchedule({
      dateIso,
      providerId,
      updatedAt: new Date(),
      scheduleItemHours: normalizedSchedule.hours,
      groupKey: normalizedSchedule.groupKey,
      sentMessages,
    });
  }

  private isScheduleChanged(processedHours: IScheduleItemHours, hours: IScheduleItemHours): boolean {
    return Object.entries(processedHours).some(([halfHour, processedPowerState]) => {
      return hours[halfHour] !== processedPowerState;
    });
  }

  private handleUnchangedSchedule(
    providerId: PowerScheduleProviderId,
    dateIso: string,
    normalizedDate: Date,
    normalizedSchedule: INormalizedSchedule,
  ): void {
    this.logger.debug(`Schedule change ignored (not changed): dateIso=${dateIso}, providerId=${providerId}`);
    const messageText = new BotMessageText()
      .addLine(`Skipped (not changed, ${dateIso}): `)
      .newLine()
      .merge(
        this.buildScheduleMessageText(
          providerId,
          normalizedDate,
          false,
          normalizedSchedule.hours,
          normalizedSchedule.groupKey,
        ),
      );
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

  /**
   * Sends a changed schedule to the groups unless sending is disabled or a schedule for the date was
   * sent recently. Returns the messages the next schedule for the date replies to.
   */
  private async deliverScheduleToGroups(
    providerId: PowerScheduleProviderId,
    dateIso: string,
    messageText: BotMessageText,
    sentMessages: IChatMessageRef[],
  ): Promise<IChatMessageRef[]> {
    const params = `${providerId}, ${dateIso}`;
    if (!this.powerScheduleConfigService.isScheduleSendingEnabled()) {
      this.sendDisabledNoticeToOwner('schedule', params, messageText);
      return sentMessages;
    }

    const now = new Date();
    const lastSentForDate = this.lastSentToGroupsAtByDate.get(dateIso);
    const withinCooldown = lastSentForDate
      && (now.getTime() - lastSentForDate.getTime()) < SEND_TO_GROUPS_COOLDOWN_MS;

    if (withinCooldown) {
      this.logger.debug(`Schedule change skipped (cooldown): dateIso=${dateIso}, providerId=${providerId}`);
      const ownerMessageText = new BotMessageText()
        .addLine(`ATTENTION! Skipped (sent to groups in last ${SEND_TO_GROUPS_COOLDOWN_MINUTES} mins): ${dateIso}`)
        .newLine()
        .merge(messageText);
      void this.botService.sendMessageToOwner(ownerMessageText);
      return sentMessages;
    }

    this.lastSentToGroupsAtByDate.set(dateIso, now);
    const sent = await this.sendScheduleMessageToGroups(messageText, sentMessages);
    this.sendSentCopyToOwner(dateIso, sent.broadcastId, messageText);
    this.logger.debug(`Schedule sent: dateIso=${dateIso}, providerId=${providerId}`);
    return sent.sentMessages;
  }

  /**
   * Sends the schedule message to all enabled groups, each as a reply to the group's previous schedule
   * message for the same date. The result holds the messages the next schedule for the date replies to.
   */
  private async sendScheduleMessageToGroups(
    messageText: BotMessageText,
    sentMessages: IChatMessageRef[],
  ): Promise<ISentToGroups> {
    const result = await this.botService.sendMessageToAllEnabledGroups(messageText, { replyTo: sentMessages });
    return {
      sentMessages: mergeChatMessageRefs(sentMessages, result.sentMessages),
      broadcastId: result.broadcastId,
    };
  }

  private async findProcessedSchedule(dateIso: string): Promise<ProcessedScheduleInfo | null> {
    const dateIsoKey: keyof ProcessedScheduleInfo = 'dateIso';
    return this.processedScheduleInfoModel.findOne({ [dateIsoKey]: dateIso }).lean().exec();
  }

  private async persistProcessedSchedule(scheduleInfo: ProcessedScheduleInfo): Promise<void> {
    const dateIsoKey: keyof ProcessedScheduleInfo = 'dateIso';
    await this.processedScheduleInfoModel.findOneAndReplace(
      { [dateIsoKey]: scheduleInfo.dateIso },
      scheduleInfo,
      { upsert: true },
    );
  }

  private async sendScheduleToChat(day: ScheduleDay, chatId: number): Promise<void> {
    this.logger.debug(`Sending schedule to chat... (day=${day}, chatId=${chatId})`);

    const date = this.getScheduleDate(day);
    const processed = await this.findScheduleToResend(day, date, `Sending schedule to chat (chatId=${chatId})`);
    if (!processed) {
      return;
    }

    await this.botService.sendMessage(chatId, this.buildResentScheduleMessageText(date, processed));
  }

  private async sendScheduleToGroups(day: ScheduleDay): Promise<void> {
    this.logger.debug(`Sending schedule to groups... (day=${day})`);

    const date = this.getScheduleDate(day);
    const dateIso = date.toISOString();

    await this.withMutex(dateIso, async () => {
      const processed = await this.findScheduleToResend(day, date, `Sending schedule to groups`);
      if (!processed) {
        return;
      }

      const messageText = this.buildResentScheduleMessageText(date, processed);
      const params = `${processed.providerId}, ${dateIso}`;
      if (!this.powerScheduleConfigService.isScheduleSendingEnabled()) {
        this.sendDisabledNoticeToOwner('schedule', params, messageText);
        return;
      }

      const { sentMessages, broadcastId } = await this.sendScheduleMessageToGroups(
        messageText,
        processed.sentMessages ?? [],
      );
      const dateIsoKey: keyof ProcessedScheduleInfo = 'dateIso';
      const sentMessagesKey: keyof ProcessedScheduleInfo = 'sentMessages';
      await this.processedScheduleInfoModel.updateOne(
        { [dateIsoKey]: dateIso },
        { $set: { [sentMessagesKey]: sentMessages } },
      );
      this.sendSentCopyToOwner(dateIso, broadcastId, messageText);
    });
  }

  private getScheduleDate(day: ScheduleDay): Date {
    const date = normalizeScheduleDate(new Date());
    if (day === 'tomorrow') {
      date.setDate(date.getDate() + 1);
    }
    return date;
  }

  /** Finds the processed schedule a command resends, telling the owner when there is none. */
  private async findScheduleToResend(
    day: ScheduleDay,
    date: Date,
    action: string,
  ): Promise<ProcessedScheduleInfo | null> {
    const dateIso = date.toISOString();
    const processed = await this.findProcessedSchedule(dateIso);
    if (!processed) {
      const message = `${action}: Failed: No schedule available for ${day} (dateIso=${dateIso})`;
      this.logger.warn(message);
      void this.botService.sendMessageToOwner(new BotMessageText(message));
    }
    return processed;
  }

  private buildResentScheduleMessageText(date: Date, processed: ProcessedScheduleInfo): BotMessageText {
    return this.buildScheduleMessageText(
      processed.providerId,
      date,
      true,
      processed.scheduleItemHours,
      processed.groupKey,
    );
  }

  private async sendEmergencyShutdownsToChat(chatId: number): Promise<void> {
    this.logger.debug(`Sending emergency shutdowns to chat... (chatId=${chatId})`);

    const action = `Sending emergency shutdowns to chat (chatId=${chatId})`;
    const processed = await this.findEmergencyShutdownsToResend(action);
    if (!processed) {
      return;
    }

    const { providerId, isActive, groupKey } = processed;
    await this.botService.sendMessage(chatId, buildEmergencyShutdownsMessage(providerId, isActive, groupKey));
  }

  private async sendEmergencyShutdownsToGroups(): Promise<void> {
    this.logger.debug(`Sending emergency shutdowns to groups...`);

    await this.withMutex(EMERGENCY_SHUTDOWNS_MUTEX_KEY, async () => {
      const processed = await this.findEmergencyShutdownsToResend(`Sending emergency shutdowns to groups`);
      if (!processed) {
        return;
      }

      const { providerId, isActive, groupKey, updatedAt } = processed;
      const messageText = buildEmergencyShutdownsMessage(providerId, isActive, groupKey);
      const params = `${providerId}, updated ${updatedAt.toISOString()}`;
      if (!this.powerScheduleConfigService.isEmergencyShutdownsSendingEnabled()) {
        this.sendDisabledNoticeToOwner('emergency shutdowns', params, messageText);
        return;
      }

      const { sentMessages, broadcastId } = await this.sendEmergencyShutdownsMessageToGroups(
        messageText,
        isActive,
        processed.activeSentMessages ?? [],
      );
      const activeSentMessagesKey: keyof ProcessedEmergencyShutdowns = 'activeSentMessages';
      await this.processedEmergencyShutdownsModel.updateOne(
        {},
        { $set: { [activeSentMessagesKey]: sentMessages } },
      );
      this.sendSentCopyToOwner(`updated ${updatedAt.toISOString()}`, broadcastId, messageText);
    });
  }

  /** Finds the emergency shutdowns state a command resends, telling the owner when there is none. */
  private async findEmergencyShutdownsToResend(action: string): Promise<ProcessedEmergencyShutdowns | null> {
    const processed = await this.findProcessedEmergencyShutdowns();
    if (!processed) {
      const message = `${action}: Failed: No emergency shutdowns state available`;
      this.logger.warn(message);
      void this.botService.sendMessageToOwner(new BotMessageText(message));
    }
    return processed;
  }

  /** The provider is left out of `details`, since the message footer already names it. */
  private sendSentCopyToOwner(details: string, broadcastId: string, messageText: BotMessageText): void {
    const ownerMessageText = new BotMessageText()
      .addLine([`Sent (${details}), broadcast `, BotMessageText.inlineCode(broadcastId)])
      .newLine()
      .merge(messageText);
    void this.botService.sendMessageToOwner(ownerMessageText);
  }

  private sendDisabledNoticeToOwner(subject: string, params: string, messageText: BotMessageText): void {
    const notice = `Tried to send ${subject} to groups, but its sending is disabled (${params}) text:`;
    void this.botService.sendMessageToOwner(new BotMessageText(`${notice}\n\n${messageText.toString()}`));
  }

  private reportFailure(action: string, e: any): void {
    const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
    this.logger.error(`${action}: Failed: ${errorMessage}`);
    void this.botService.sendMessageToOwner(new BotMessageText(`${action}: Failed: ${errorMessage}`));
  }
}
