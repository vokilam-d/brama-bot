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
import {
  buildDayScheduleMessage,
  buildScheduleTitleLine,
} from '../helpers/schedule-message.helper';
import { normalizeScheduleDate } from '../helpers/normalize-schedule-date.helper';
import { getMonthName } from '../../../helpers/get-month-name.helper';

@Injectable()
export class PowerScheduleOrchestratorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PowerScheduleOrchestratorService.name);
  private readonly dateMutexes = new Map<string, Promise<unknown>>();

  constructor(
    @InjectModel(ProcessedScheduleInfo.name) private processedScheduleInfoModel: Model<ProcessedScheduleInfo>,
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
    const lastProcessed: ProcessedScheduleInfo = await this.processedScheduleInfoModel
      .findOne({ dateIso })
      .lean()
      .exec();

    if (lastProcessed) {
      const isScheduleChanged = Object.entries(lastProcessed.scheduleItemHours).some(([halfHour, processedPowerState]) => {
        const currentPowerState = normalizedSchedule.hours[halfHour];
        return currentPowerState !== processedPowerState;
      });
      if (!isScheduleChanged) {
        this.logger.debug(`Schedule change ignored (not changed): dateIso=${dateIso}, providerId=${providerId}`);

        const skippedMessageText = new BotMessageText()
          .addLine(`Skipped (${providerId}, ${dateIso}): `)
          .newLine()
          .addLine(BotMessageText.bold(buildScheduleTitleLine(normalizedDate, true)))
          .newLine()
          .merge(buildDayScheduleMessage(normalizedSchedule.hours));
        void this.botService.sendMessageToOwner(skippedMessageText);
        return;
      }
    }

    const isNew = !!lastProcessed;
    const messageText = new BotMessageText()
      .addLine(BotMessageText.bold(buildScheduleTitleLine(normalizedDate, isNew)))
      .newLine()
      .merge(buildDayScheduleMessage(normalizedSchedule.hours));

    if (this.powerScheduleConfigService.isScheduleSendingEnabled()) {
      await this.botService.sendMessageToAllEnabledGroups(messageText);

      const ownerMessageText = new BotMessageText()
        .addLine(`Sent (${providerId}, ${dateIso})`)
        .newLine()
        .merge(messageText);
      void this.botService.sendMessageToOwner(ownerMessageText);
    } else {
      void this.botService.sendMessageToOwner(new BotMessageText(`Tried to send schedule, but sending is disabled (${providerId}, ${dateIso}) text:\n\n${messageText.toString()}`));
    }
    await this.persistProcessed(providerId, dateIso, new Date(), normalizedSchedule.hours);

    this.logger.debug(`Schedule sent: dateIso=${dateIso}, providerId=${providerId}`);
  }

  private async persistProcessed(
    providerId: PowerScheduleProviderId,
    dateIso: string,
    updatedAt: Date,
    scheduleItemHours: IScheduleItemHours,
  ): Promise<void> {
    const scheduleInfo: ProcessedScheduleInfo = {
      dateIso,
      providerId,
      updatedAt,
      scheduleItemHours,
    };
    const dateInfoKey: keyof ProcessedScheduleInfo = 'dateIso';

    await this.processedScheduleInfoModel.findOneAndUpdate(
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
    let dayName = 'сьогодні';
    if (day === 'tomorrow') {
      date.setDate(date.getDate() + 1);
      dayName = 'завтра';
    }
    const dateIso = date.toISOString();

    const dateIsoKey: keyof ProcessedScheduleInfo = 'dateIso';
    const lastProcessed: ProcessedScheduleInfo = await this.processedScheduleInfoModel
      .findOne({ [dateIsoKey]: dateIso })
      .lean()
      .exec();

    if (!lastProcessed) {
      const message = `Sending schedule to chat: Failed: No schedule available for ${day} (dateIso=${dateIso}, chatId=${chatId}, sendToGroups=${sendToGroups})`;
      this.logger.warn(message);
      void this.botService.sendMessageToOwner(new BotMessageText(message));
      return;
    }

    const scheduleTitleWithDay = BotMessageText.bold(
      `🗓 Графік на ${dayName} (${date.getDate()} ${getMonthName(date)})`,
    );
    const messageText = new BotMessageText()
      .add(scheduleTitleWithDay)
      .newLine()
      .newLine();
    messageText.merge(buildDayScheduleMessage(lastProcessed.scheduleItemHours));

    if (chatId !== undefined) {
      await this.botService.sendMessage(chatId, messageText);
    } else if (sendToGroups) {
      if (this.powerScheduleConfigService.isScheduleSendingEnabled()) {
        await this.botService.sendMessageToAllEnabledGroups(messageText);

        const ownerMessageText = new BotMessageText()
          .addLine(`Sent (${lastProcessed.providerId}, ${dateIso})`)
          .newLine()
          .merge(messageText);
        void this.botService.sendMessageToOwner(ownerMessageText);
      } else {
        void this.botService.sendMessageToOwner(new BotMessageText(`Tried to send schedule to groups, but sending is disabled (${lastProcessed.providerId}, ${dateIso}) text:\n\n${messageText.toString()}`));
      }
    }
  }
}
