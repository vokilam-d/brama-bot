import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { CONFIG } from '../../../config';
import {
  INormalizedSchedule,
  PowerScheduleProviderId,
  PowerState,
} from '../../power-schedule/interfaces/schedule.interface';
import { BasePowerScheduleProvider } from '../../power-schedule/base/base-power-schedule-provider';
import { PowerScheduleOrchestratorService } from '../../power-schedule/services/power-schedule-orchestrator.service';
import { normalizeScheduleDate } from '../../power-schedule/helpers/normalize-schedule-date.helper';
import { BotService } from '../../bot/services/bot.service';
import { PowerScheduleConfigService } from '../../power-schedule/services/power-schedule-config.service';
import { KdService } from './kd.service';
import { IScheduleItem } from '../interfaces/schedule-response.interface';

@Injectable()
export class KdScheduleService
  extends BasePowerScheduleProvider
  implements OnApplicationBootstrap, OnModuleDestroy
{
  protected readonly logger = new Logger(KdScheduleService.name);
  protected readonly pollIntervalMs = CONFIG.kyivDigital.schedulePollIntervalMs;
  protected readonly providerId = PowerScheduleProviderId.Kd;

  constructor(
    private readonly kdService: KdService,
    powerScheduleOrchestrator: PowerScheduleOrchestratorService,
    botService: BotService,
    powerScheduleConfigService: PowerScheduleConfigService,
  ) {
    super(powerScheduleOrchestrator, botService, powerScheduleConfigService);
  }

  protected override shouldSkipSchedule(schedule: INormalizedSchedule): boolean {
    return Object.values(schedule.hours).some((s) => s === PowerState.MaybeOff);
  }

  override async fetchSchedules(): Promise<INormalizedSchedule[]> {
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
}
