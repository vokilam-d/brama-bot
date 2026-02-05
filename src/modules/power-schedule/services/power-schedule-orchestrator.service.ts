import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BotService, PendingMessageType } from '../../bot/services/bot.service';
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

  constructor(
    @InjectModel(ProcessedScheduleInfo.name)
    private processedScheduleInfoModel: Model<ProcessedScheduleInfo>,
    private readonly botService: BotService,
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
   */
  async onScheduleChange(
    providerId: PowerScheduleProviderId,
    date: Date,
    normalizedSchedule: INormalizedSchedule,
  ): Promise<void> {
    const normalizedDate = normalizeScheduleDate(date);
    const dateIso = normalizedDate.toISOString();

    const lastProcessedDoc = await this.processedScheduleInfoModel
      .findOne({ dateIso })
      .sort({ updatedAt: -1 })
      .exec();
    const lastProcessed = lastProcessedDoc?.toJSON();

    if (lastProcessed) {
      const isScheduleChanged = Object.entries(lastProcessed.scheduleItemHours).some(([halfHour, processedPowerState]) => {
        const currentPowerState = normalizedSchedule.hours[halfHour];
        return currentPowerState !== processedPowerState;
      });
      if (!isScheduleChanged) {
        this.logger.debug(
          `Schedule change ignored (not changed): dateIso=${dateIso}, providerId=${providerId}`,
        );
        return;
      }
    }

    const isNew = lastProcessed?.isSent;
    const messageText = new BotMessageText()
      .addLine(BotMessageText.bold(buildScheduleTitleLine(normalizedDate, isNew)))
      .newLine();
    messageText.merge(buildDayScheduleMessage(normalizedSchedule.hours));

    messageText.newLine().addLine(`Джерело графіка: ${providerId}`);

    await this.botService.sendMessageToAllEnabledGroups(messageText);
    // void this.botService.sendMessageToOwner(new BotMessageText(`Джерело графіка: ${providerId}`));
    await this.persistProcessed(providerId, dateIso, new Date(), normalizedSchedule.hours, true);

    this.logger.debug(`Schedule sent: dateIso=${dateIso}, providerId=${providerId}`);
  }

  private async persistProcessed(
    providerId: PowerScheduleProviderId,
    dateIso: string,
    updatedAt: Date,
    scheduleItemHours: IScheduleItemHours,
    isSent: boolean,
  ): Promise<void> {
    const dateInfoKey: keyof ProcessedScheduleInfo = 'dateIso';
    const scheduleInfo: ProcessedScheduleInfo = {
      dateIso,
      providerId,
      updatedAt,
      scheduleItemHours,
      isSent,
    };

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
    const date = normalizeScheduleDate(new Date());
    let dayName = 'сьогодні';
    if (day === 'tomorrow') {
      date.setDate(date.getDate() + 1);
      dayName = 'завтра';
    }
    const dateIso = date.toISOString();

    let hours: IScheduleItemHours | null = null;
    let providerId: PowerScheduleProviderId | undefined;
    const fromStore = await this.processedScheduleInfoModel
      .findOne({ dateIso })
      .sort({ updatedAt: -1 })
      .exec();
    if (fromStore) {
      hours = fromStore.scheduleItemHours as unknown as IScheduleItemHours;
      providerId = fromStore.providerId;
    }

    if (!hours) {
      this.logger.warn(`No schedule available for ${day} (dateIso=${dateIso})`);
      return;
    }

    const scheduleTitleWithDay = BotMessageText.bold(
      `🗓 Графік на ${dayName} (${date.getDate()} ${getMonthName(date)})`,
    );
    const messageText = new BotMessageText()
      .add(scheduleTitleWithDay)
      .newLine()
      .newLine();
    messageText.merge(buildDayScheduleMessage(hours));

    if (chatId !== undefined) {
      await this.botService.sendMessage(chatId, messageText);
    } else if (sendToGroups) {
      await this.botService.sendMessageToAllEnabledGroups(messageText);
    }
    if (providerId) {
      void this.botService.sendMessageToOwner(new BotMessageText(`Джерело графіка: ${providerId}`));
    }
  }
}
