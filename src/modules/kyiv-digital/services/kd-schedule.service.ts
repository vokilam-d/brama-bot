import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { CONFIG } from '../../../config';
import {
  INormalizedSchedule,
  IScheduleItemHours,
  PowerScheduleProviderId,
  PowerState,
} from '../../power-schedule/interfaces/schedule.interface';
import { IPowerScheduleProvider } from '../../power-schedule/interfaces/power-schedule-provider.interface';
import { PowerScheduleOrchestratorService } from '../../power-schedule/services/power-schedule-orchestrator.service';
import { normalizeScheduleDate } from '../../power-schedule/helpers/normalize-schedule-date.helper';
import { BotService } from '../../bot/services/bot.service';
import { PowerScheduleConfigService } from '../../power-schedule/services/power-schedule-config.service';
import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';
import { KdService } from './kd.service';
import { IScheduleItem } from '../interfaces/schedule-response.interface';

@Injectable()
export class KdScheduleService implements IPowerScheduleProvider, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KdScheduleService.name);
  private readonly pollIntervalMs = CONFIG.kyivDigital.schedulePollIntervalMs;

  private pollTimer?: NodeJS.Timeout;
  private readonly lastScheduleHashes = new Map<string, string>();

  constructor(
    private readonly kdService: KdService,
    private readonly powerScheduleOrchestrator: PowerScheduleOrchestratorService,
    private readonly botService: BotService,
    private readonly powerScheduleConfigService: PowerScheduleConfigService,
  ) {}

  getId(): string {
    return PowerScheduleProviderId.Kd;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.pollIntervalMs) {
      this.logger.warn(`KD schedule polling disabled (interval is falsy)`);
      return;
    }
    this.powerScheduleConfigService.events.on('configUpdated', () => this.applyScheduleProviderEnabled());
    this.applyScheduleProviderEnabled();
  }

  onModuleDestroy(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
  }

  private applyScheduleProviderEnabled(): void {
    const enabled = this.powerScheduleConfigService.isProviderEnabled(PowerScheduleProviderId.Kd);
    if (enabled && !this.pollTimer) {
      this.logger.debug(`KD provider enabled, starting schedule polling`);

      void this.schedulePollAndNotify();
    } else if (!enabled && this.pollTimer) {
      this.logger.debug(`KD provider disabled, stopping schedule polling`);

      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  async getScheduleForDate(date: Date): Promise<INormalizedSchedule | null> {
    try {
      const schedules = await this.fetchSchedules();
      const targetIso = normalizeScheduleDate(date).toISOString();
      const match = schedules.find((s) => {
        return normalizeScheduleDate(s.date).toISOString() === targetIso;
      });
      return match ?? null;
    } catch (error) {
      this.onError(error as Error, 'KD: getScheduleForDate failed');
      return null;
    }
  }

  private async schedulePollAndNotify(): Promise<void> {
    const enabled = this.powerScheduleConfigService.isProviderEnabled(PowerScheduleProviderId.Kd);
    if (!enabled) {
      return;
    }
    await this.pollAndNotify();
    this.pollTimer = setTimeout(() => this.schedulePollAndNotify(), this.pollIntervalMs);
  }

  private async pollAndNotify(): Promise<void> {
    try {
      const schedules = await this.fetchSchedules();
      for (const schedule of schedules) {
        const dateIso = normalizeScheduleDate(schedule.date).toISOString();

        if (Object.values(schedule.hours).some((s) => s === PowerState.MaybeOff)) {
          this.lastScheduleHashes.delete(dateIso);
          continue;
        }

        const hash = this.hashSchedule(schedule.hours);
        if (this.lastScheduleHashes.get(dateIso) === hash) {
          continue;
        }

        try {
          this.logger.debug(`Sending KD schedule for ${dateIso}`);
          await this.powerScheduleOrchestrator.onScheduleChange(
            PowerScheduleProviderId.Kd,
            schedule.date,
            schedule,
          );
          this.lastScheduleHashes.set(dateIso, hash);
        } catch (error) {
          this.onError(
            error as Error,
            `KD: Failed to notify orchestrator for ${dateIso}`,
          );
        }
      }
    } catch (error) {
      this.onError(error as Error, 'KD: Failed to fetch schedule');
    }
  }

  private async fetchSchedules(): Promise<INormalizedSchedule[]> {
    await this.kdService.whenReady();
    const weekSchedule = await this.kdService.getWeekSchedule();
    if (!weekSchedule?.length) {
      return [];
    }

    const today = normalizeScheduleDate(new Date());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const schedules: INormalizedSchedule[] = [];
    for (const date of [today, tomorrow]) {
      const dayOfWeek = this.dateToKdDayOfWeek(date);
      const item = weekSchedule.find((s: IScheduleItem) => s.day_of_week === dayOfWeek);
      if (!item) {
        continue;
      }
      schedules.push({ date, hours: item.hours });
    }

    return schedules;
  }

  /**
   * KD API uses day_of_week: 1=Mon .. 7=Sun. JS Date.getDay(): 0=Sun, 1=Mon .. 6=Sat.
   */
  private dateToKdDayOfWeek(date: Date): number {
    const jsDay = date.getDay();
    return jsDay === 0 ? 7 : jsDay;
  }

  private hashSchedule(hours: IScheduleItemHours): string {
    return JSON.stringify(hours);
  }

  private onError(error: Error, description: string): void {
    const message = error.stack ?? error.message ?? String(error);
    this.logger.error(`${description}: ${message}`);
    void this.botService.sendMessageToOwner(new BotMessageText(`${description}: ${message}`));
  }
}
