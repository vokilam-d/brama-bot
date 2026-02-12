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
  PowerScheduleProviderId,
} from '../../power-schedule/interfaces/schedule.interface';
import { BasePowerScheduleProvider } from '../../power-schedule/base/base-power-schedule-provider';
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
export class YasnoScheduleService
  extends BasePowerScheduleProvider
  implements OnApplicationBootstrap, OnModuleDestroy
{
  protected readonly logger = new Logger(YasnoScheduleService.name);
  protected readonly pollIntervalMs = CONFIG.yasno.pollIntervalMs;
  protected readonly providerId = PowerScheduleProviderId.Yasno;
  private readonly regionId = CONFIG.yasno.regionId;
  private readonly dsoId = CONFIG.yasno.dsoId;
  private readonly streetQuery = CONFIG.yasno.street;
  private readonly buildingQuery = CONFIG.yasno.building;

  constructor(
    private readonly httpService: HttpService,
    powerScheduleOrchestrator: PowerScheduleOrchestratorService,
    botService: BotService,
    powerScheduleConfigService: PowerScheduleConfigService,
  ) {
    super(powerScheduleOrchestrator, botService, powerScheduleConfigService);
  }

  protected override shouldSkipSchedule(_schedule: INormalizedSchedule): boolean {
    return false;
  }

  override async fetchSchedules(): Promise<INormalizedSchedule[]> {
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
      this.logger.error(`Yasno: Failed to fetch group: ${(error as Error).message}`);
      void this.botService.sendMessageToOwner(
        new BotMessageText(`Yasno: Failed to fetch group: ${(error as Error).message}`),
      );
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
}
