import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { CONFIG } from '../../../config';
import {
  INormalizedSchedule,
  IScheduleItemHours,
  PowerScheduleProviderId,
} from '../../power-schedule/interfaces/schedule.interface';
import { IPowerScheduleProvider } from '../../power-schedule/interfaces/power-schedule-provider.interface';
import { PowerScheduleOrchestratorService } from '../../power-schedule/services/power-schedule-orchestrator.service';
import { normalizeScheduleDate } from '../../power-schedule/helpers/normalize-schedule-date.helper';
import { BotService } from '../../bot/services/bot.service';
import { PowerScheduleConfigService } from '../../power-schedule/services/power-schedule-config.service';
import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';
import {
  normalizeYasnoSlots,
  YasnoSlot,
} from '../helpers/yasno-normalize.helper';

const YASNO_API = 'https://app.yasno.ua/api/blackout-service/public/shutdowns';

interface YasnoIdValue {
  id: number;
  value: string;
}

interface YasnoGroupResponse {
  group: number;
  subgroup: number;
}

interface YasnoDaySchedule {
  slots: YasnoSlot[];
  date: string;
  status: string;
}

interface YasnoGroupSchedule {
  today?: YasnoDaySchedule;
  tomorrow?: YasnoDaySchedule;
  updatedOn?: string;
}

type YasnoPlannedOutages = Record<string, YasnoGroupSchedule>;

@Injectable()
export class YasnoScheduleService implements IPowerScheduleProvider, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(YasnoScheduleService.name);
  private readonly regionId = CONFIG.yasno.regionId;
  private readonly dsoId = CONFIG.yasno.dsoId;
  private readonly streetQuery = CONFIG.yasno.street;
  private readonly buildingQuery = CONFIG.yasno.building;
  private readonly pollIntervalMs = CONFIG.yasno.pollIntervalMs;

  private pollTimer?: NodeJS.Timeout;
  private readonly lastScheduleHashes = new Map<string, string>();

  constructor(
    private readonly httpService: HttpService,
    private readonly powerScheduleOrchestrator: PowerScheduleOrchestratorService,
    private readonly botService: BotService,
    private readonly powerScheduleConfigService: PowerScheduleConfigService,
  ) {}

  getId(): string {
    return PowerScheduleProviderId.Yasno;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.pollIntervalMs) {
      this.logger.warn(`Yasno polling disabled (interval is falsy)`);
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
    const enabled = this.powerScheduleConfigService.isProviderEnabled(PowerScheduleProviderId.Yasno) ?? true;
    if (enabled && !this.pollTimer) {
      this.logger.debug(`Yasno provider enabled, starting schedule polling`);

      void this.schedulePollAndNotify();
    } else if (!enabled && this.pollTimer) {
      this.logger.debug(`Yasno provider disabled, stopping schedule polling`);

      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  async getScheduleForDate(date: Date): Promise<INormalizedSchedule | null> {
    try {
      const schedules = await this.fetchSchedules();
      const targetIso = normalizeScheduleDate(date).toISOString();
      const match = schedules.find((schedule) => {
        return normalizeScheduleDate(schedule.date).toISOString() === targetIso;
      });
      return match ?? null;
    } catch (error) {
      this.onError(error as Error, 'Yasno: getScheduleForDate failed');
      return null;
    }
  }

  private async schedulePollAndNotify(): Promise<void> {
    const enabled = this.powerScheduleConfigService.isProviderEnabled(PowerScheduleProviderId.Yasno) ?? true;
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
        const dateIso = schedule.date.toISOString();

        const hash = this.hashSchedule(schedule.hours);
        if (this.lastScheduleHashes.get(dateIso) === hash) {
          continue;
        }

        try {
          this.logger.debug(`Sending Yasno schedule for ${dateIso}`);
          await this.powerScheduleOrchestrator.onScheduleChange(
            PowerScheduleProviderId.Yasno,
            schedule.date,
            schedule,
          );
          this.lastScheduleHashes.set(dateIso, hash);
        } catch (error) {
          this.onError(
            error as Error,
            `Yasno: Failed to notify orchestrator for ${dateIso}`,
          );
        }
      }
    } catch (error) {
      this.onError(error as Error, 'Yasno: Failed to fetch schedule');
    }
  }

  private async fetchSchedules(): Promise<INormalizedSchedule[]> {
    const groupKey = await this.resolveGroupKey();
    if (!groupKey) {
      return [];
    }

    const planned = await this.fetchPlannedOutages();
    const groupSchedule = planned[groupKey];
    if (!groupSchedule) {
      this.logger.error(`Yasno: No schedule for group ${groupKey} in planned-outages`);
      this.logger.debug(planned);
      void this.botService.sendMessageToOwner(new BotMessageText(`Yasno: No schedule for group ${groupKey} in planned-outages`));
      return [];
    }

    const schedules: INormalizedSchedule[] = [];

    for (const day of ['today', 'tomorrow'] as const) {
      const dayData = groupSchedule[day];
      if (
        !dayData
        || dayData.status !== 'ScheduleApplies'
        || !dayData.slots?.length
      ) {
        continue;
      }

      const hours = normalizeYasnoSlots(dayData.slots);
      const date = normalizeScheduleDate(new Date(dayData.date));
      schedules.push({ date, hours });
    }

    return schedules;
  }

  private async resolveGroupKey(): Promise<string | null> {
    const streetId = await this.resolveStreetId();
    if (!streetId) {
      return null;
    }

    const houseId = await this.resolveHouseId(streetId);
    if (!houseId) {
      return null;
    }

    const group = await this.fetchGroup(streetId, houseId);
    if (!group) {
      return null;
    }

    return `${group.group}.${group.subgroup}`;
  }

  private async resolveStreetId(): Promise<number | null> {
    const url = `${YASNO_API}/addresses/v2/streets`;
    const { data } = await firstValueFrom(
      this.httpService.get<YasnoIdValue[]>(url, {
        params: {
          regionId: this.regionId,
          query: this.streetQuery,
          dsoId: this.dsoId,
        },
      }),
    );

    const match = data?.[0];
    if (!match) {
      this.logger.error(`Yasno: Street not found for query "${this.streetQuery}"`);
      this.logger.debug(data);
      void this.botService.sendMessageToOwner(new BotMessageText(`Yasno: Street not found for query "${this.streetQuery}"`));
      return null;
    }

    return match.id;
  }

  private async resolveHouseId(streetId: number): Promise<number | null> {
    const url = `${YASNO_API}/addresses/v2/houses`;
    const { data } = await firstValueFrom(
      this.httpService.get<YasnoIdValue[]>(url, {
        params: {
          regionId: this.regionId,
          streetId,
          query: this.buildingQuery,
          dsoId: this.dsoId,
        },
      }),
    );

    const match = data?.[0];
    if (!match) {
      this.logger.warn(`Yasno: House not found for street ${streetId}, query "${this.buildingQuery}"`);
      this.logger.debug(data);
      void this.botService.sendMessageToOwner(new BotMessageText(`Yasno: House not found for street ${streetId}, query "${this.buildingQuery}"`));
      return null;
    }

    return match.id;
  }

  private async fetchGroup(
    streetId: number,
    houseId: number,
  ): Promise<YasnoGroupResponse | null> {
    const url = `${YASNO_API}/addresses/v2/group`;
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<YasnoGroupResponse>(url, {
          params: {
            regionId: this.regionId,
            streetId,
            houseId,
            dsoId: this.dsoId,
          },
        }),
      );
      return data ?? null;
    } catch (error) {
      this.logger.error(`Yasno: Failed to fetch group: ${error.message}`);
      void this.botService.sendMessageToOwner(new BotMessageText(`Yasno: Failed to fetch group: ${error.message}`));
      return null;
    }
  }

  private async fetchPlannedOutages(): Promise<YasnoPlannedOutages> {
    const url = `${YASNO_API}/regions/${this.regionId}/dsos/${this.dsoId}/planned-outages`;
    const { data } = await firstValueFrom(
      this.httpService.get<YasnoPlannedOutages>(url),
    );
    return data ?? {};
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
