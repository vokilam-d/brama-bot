import { Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
  INormalizedSchedule,
  IScheduleItemHours,
  PowerScheduleProviderId,
} from '../interfaces/schedule.interface';
import { PowerScheduleOrchestratorService } from '../services/power-schedule-orchestrator.service';
import { normalizeScheduleDate } from '../helpers/normalize-schedule-date.helper';
import { BotService } from '../../bot/services/bot.service';
import { PowerScheduleConfigService } from '../services/power-schedule-config.service';
import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';

const CONSECUTIVE_ERROR_THRESHOLD = 3;

export abstract class BasePowerScheduleProvider implements OnApplicationBootstrap, OnModuleDestroy {
  protected abstract readonly logger: Logger;
  protected abstract readonly pollIntervalMs: number;
  protected abstract readonly providerId: PowerScheduleProviderId;

  protected readonly lastScheduleHashes = new Map<string, string>();
  private consecutiveErrorCount = 0;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    protected readonly powerScheduleOrchestrator: PowerScheduleOrchestratorService,
    protected readonly botService: BotService,
    protected readonly powerScheduleConfigService: PowerScheduleConfigService,
  ) {}

  getId(): string {
    return this.providerId;
  }

  abstract fetchSchedules(): Promise<INormalizedSchedule[]>;

  protected abstract shouldSkipSchedule(schedule: INormalizedSchedule): boolean;

  protected hashSchedule(hours: IScheduleItemHours): string {
    return JSON.stringify(hours);
  }

  protected getDateIso(schedule: INormalizedSchedule): string {
    return normalizeScheduleDate(schedule.date).toISOString();
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
      this.handleError(error, `${this.providerId}: getScheduleForDate failed`);
      return null;
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.pollIntervalMs) {
      this.logger.warn(`${this.providerId} polling disabled (interval is falsy)`);
      return;
    }
    this.powerScheduleConfigService.events.on('configUpdated', () => {
      this.applyScheduleProviderEnabled();
    });
    this.applyScheduleProviderEnabled();
  }

  onModuleDestroy(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
  }

  private applyScheduleProviderEnabled(): void {
    const enabled = this.powerScheduleConfigService.isProviderEnabled(this.providerId);
    if (enabled && !this.pollTimer) {
      this.logger.debug(`${this.providerId} provider enabled, starting schedule polling`);
      void this.schedulePollAndNotify();
    } else if (!enabled && this.pollTimer) {
      this.logger.debug(`${this.providerId} provider disabled, stopping schedule polling`);
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async schedulePollAndNotify(): Promise<void> {
    const enabled = this.powerScheduleConfigService.isProviderEnabled(this.providerId);
    if (!enabled) {
      return;
    }
    await this.pollAndNotify();
    this.pollTimer = setTimeout(() => this.schedulePollAndNotify(), this.pollIntervalMs);
  }

  private async pollAndNotify(): Promise<void> {
    try {
      const schedules = await this.fetchSchedules();
      this.consecutiveErrorCount = 0;
      for (const schedule of schedules) {
        const dateIso = this.getDateIso(schedule);
        if (this.shouldSkipSchedule(schedule)) {
          this.lastScheduleHashes.delete(dateIso);
          continue;
        }

        const hash = this.hashSchedule(schedule.hours);
        if (this.lastScheduleHashes.get(dateIso) === hash) {
          continue;
        }

        try {
          this.logger.debug(`Sending ${this.providerId} schedule for ${dateIso}`);
          await this.powerScheduleOrchestrator.onScheduleChange(
            this.providerId,
            schedule.date,
            schedule,
          );
          this.lastScheduleHashes.set(dateIso, hash);
        } catch (error) {
          this.handleError(
            error,
            `${this.providerId}: Failed to notify orchestrator for ${dateIso}`,
          );
        }
      }
    } catch (error) {
      this.consecutiveErrorCount++;
      if (this.consecutiveErrorCount >= CONSECUTIVE_ERROR_THRESHOLD) {
        this.handleError(error, `${this.providerId}: Failed to fetch schedule`);
        this.consecutiveErrorCount = 0;
      }
    }
  }

  private handleError(error: Error, description: string): void {
    const message = error.message ?? String(error);
    const stackOrMessage = error.stack ?? message;
    this.logger.error(`${description}: ${stackOrMessage}`);
    void this.botService.sendMessageToOwner(new BotMessageText(`${description}: ${message}`));
  }
}
