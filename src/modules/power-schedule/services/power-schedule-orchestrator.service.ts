import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BotService, PendingMessageType } from '../../bot/services/bot.service';
import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';
import {
  INormalizedSchedule,
  IScheduleItemHours,
  PowerScheduleProviderId,
  PowerState,
} from '../interfaces/schedule.interface';
import { ProcessedScheduleInfo } from '../schemas/processed-schedule-info.schema';
import { buildDayScheduleMessage, buildScheduleTitleLine } from '../helpers/schedule-message.helper';
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
   * Normalize date to 6 AM to match KD/store convention and avoid DST edge cases.
   */
  private normalizeScheduleDate(date: Date): Date {
    const d = new Date(date);
    d.setHours(6, 0, 0, 0);
    return d;
  }

  /**
   * Called by a provider when it detects a new or changed schedule for a date.
   * Orchestrator decides whether to send (most recent wins) and persists.
   */
  async onScheduleChange(
    providerId: PowerScheduleProviderId,
    date: Date,
    normalizedSchedule: INormalizedSchedule,
    updatedAt?: Date,
  ): Promise<void> {
    const normalizedDate = this.normalizeScheduleDate(date);
    const dateIso = normalizedDate.toISOString();
    const effectiveUpdatedAt = updatedAt ?? new Date();

    const lastProcessed = await this.processedScheduleInfoModel
      .findOne({ dateIso })
      .sort({ updatedAt: -1 })
      .exec();

    if (lastProcessed && new Date(lastProcessed.updatedAt) >= effectiveUpdatedAt) {
      this.logger.debug(
        `Schedule change ignored (older than last sent): dateIso=${dateIso}, providerId=${providerId}`,
      );
      return;
    }

    const isScheduleNotSetup = Object.values(normalizedSchedule.hours).some(
      (state) => state === PowerState.MaybeOff,
    );
    const hasAnyOff = Object.values(normalizedSchedule.hours).some(
      (state) => state === PowerState.Off || state === PowerState.MaybeOff,
    );
    const isFullyOn = !hasAnyOff;
    if (isScheduleNotSetup && !isFullyOn) {
      this.logger.debug(`Schedule not setup (dateIso=${dateIso}), persisting without send`);
      await this.persistProcessed(providerId, dateIso, effectiveUpdatedAt, normalizedSchedule.hours, false);
      return;
    }

    const isNew = !lastProcessed?.isSent;
    const messageText = new BotMessageText()
      .addLine(BotMessageText.bold(buildScheduleTitleLine(normalizedDate, isNew)))
      .newLine();
    messageText.merge(buildDayScheduleMessage(normalizedSchedule.hours, normalizedDate));

    await this.botService.sendMessageToAllEnabledGroups(messageText);
    await this.persistProcessed(providerId, dateIso, effectiveUpdatedAt, normalizedSchedule.hours, true);

    this.logger.debug(
      `Schedule sent: dateIso=${dateIso}, providerId=${providerId}, updatedAt=${effectiveUpdatedAt.toISOString()}`,
    );
  }

  private async persistProcessed(
    providerId: PowerScheduleProviderId,
    dateIso: string,
    updatedAt: Date,
    scheduleItemHours: IScheduleItemHours,
    isSent: boolean,
  ): Promise<void> {
    await this.processedScheduleInfoModel.findOneAndUpdate(
      { dateIso },
      {
        dateIso,
        providerId,
        updatedAt,
        scheduleItemHours,
        isSent,
      },
      { upsert: true },
    );
  }

  private async sendScheduleToChat(
    day: 'today' | 'tomorrow',
    chatId?: number,
    sendToGroups = false,
  ): Promise<void> {
    const date = this.normalizeScheduleDate(new Date());
    let dayName = 'сьогодні';
    if (day === 'tomorrow') {
      date.setDate(date.getDate() + 1);
      dayName = 'завтра';
    }
    const dateIso = date.toISOString();

    let hours: IScheduleItemHours | null = null;
    const fromStore = await this.processedScheduleInfoModel
      .findOne({ dateIso })
      .sort({ updatedAt: -1 })
      .exec();
    if (fromStore) {
      hours = fromStore.scheduleItemHours as unknown as IScheduleItemHours;
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
    messageText.merge(buildDayScheduleMessage(hours, date));

    if (chatId !== undefined) {
      await this.botService.sendMessage(chatId, messageText);
    } else if (sendToGroups) {
      await this.botService.sendMessageToAllEnabledGroups(messageText);
    }
  }
}
