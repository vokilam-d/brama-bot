import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { CONFIG } from '../../../config';
import { BotService } from '../../bot/services/bot.service';
import { BasePowerScheduleProvider } from '../../power-schedule/base/base-power-schedule-provider';
import { normalizeScheduleDate } from '../../power-schedule/helpers/normalize-schedule-date.helper';
import {
  INormalizedSchedule,
  PowerScheduleProviderId
} from '../../power-schedule/interfaces/schedule.interface';
import { PowerScheduleConfigService } from '../../power-schedule/services/power-schedule-config.service';
import { PowerScheduleOrchestratorService } from '../../power-schedule/services/power-schedule-orchestrator.service';
import { PuppeteerService } from '../../puppeteer/services/puppeteer.service';
import {
  DtekSlotValue,
  isAllPowerOn,
  normalizeDtekDaySlots,
} from '../helpers/dtek-normalize.helper';

type DisconSchedule = {
  form: {
    find: (sel: string) => {
      val: (v?: string) => unknown;
      prop: (name: string, val?: boolean) => unknown;
      length: number;
      append: (el: unknown) => void;
    };
    append: (el: unknown) => void;
    serializeArray: () => { name: string; value: string }[];
  };
  fact?: { update?: string };
  ajax: {
    url: string;
    obj: Record<string, unknown>;
    send: (
      success: (a: unknown) => void,
      failure: (a: unknown) => void,
    ) => void;
  };
};

type DtekFactData = Record<
  string,
  Record<string, Record<string, DtekSlotValue>>
>;

interface DtekFactPayload {
  today?: number;
  update?: string;
  data?: DtekFactData;
}

interface DtekBuildingInfo {
  sub_type: string;
  start_date: string;
  end_date: string;
  type: string;
  sub_type_reason: string[];
  voluntarily: unknown;
}

interface DtekGetHomeNumResponse {
  result: boolean;
  data?: Record<string, DtekBuildingInfo>;
  showCurOutageParam?: boolean;
  showCurSchedule?: boolean;
  showTableSchedule?: boolean;
  showTablePlan?: boolean;
  showTableFact?: boolean;
  showUserGroup?: boolean;
  updateTimestamp?: string;
}

interface DtekFetchResult {
  response: DtekGetHomeNumResponse;
  fact?: DtekFactPayload;
}

const INCAPSULA_WAIT_MS = 4000;
const GET_HOME_NUM_TIMEOUT_MS = 30_000;

@Injectable()
export class DtekScheduleService
  extends BasePowerScheduleProvider
  implements OnApplicationBootstrap, OnModuleDestroy
{
  protected readonly logger = new Logger(DtekScheduleService.name);
  protected readonly pollIntervalMs = CONFIG.dtek.pollIntervalMs;
  protected readonly providerId = PowerScheduleProviderId.Dtek;
  private readonly street = CONFIG.dtek.street;
  private readonly building = CONFIG.dtek.building;

  constructor(
    powerScheduleOrchestrator: PowerScheduleOrchestratorService,
    botService: BotService,
    powerScheduleConfigService: PowerScheduleConfigService,
    private readonly puppeteerService: PuppeteerService,
  ) {
    super(powerScheduleOrchestrator, botService, powerScheduleConfigService);
  }

  protected override shouldSkipSchedule(schedule: INormalizedSchedule): boolean {
    return isAllPowerOn(schedule.hours);
  }

  override async fetchSchedules(): Promise<INormalizedSchedule[]> {
    this.logger.debug('[DTEK] fetchSchedules: start');
    const payload = await this.fetchDtekPagePayload();
    this.logger.debug(`[DTEK] fetchSchedules: fetchDtekPagePayload returned, payload=${payload ? 'ok' : 'null'}`);
    if (!payload) {
      this.logger.debug('[DTEK] fetchSchedules: returning [] (no payload)');
      return [];
    }

    const { response, fact } = payload;
    if (!response.result) {
      this.logger.warn(`DTEK response missing result flag`);
      this.logger.debug('[DTEK] fetchSchedules: returning [] (response.result=false)');
      return [];
    }

    const buildingInfo = response.data?.[this.building];
    const groupKey = buildingInfo?.sub_type_reason?.[0];
    this.logger.debug(`[DTEK] fetchSchedules: building=${this.building}, groupKey=${groupKey ?? 'undefined'}`);
    if (!groupKey) {
      this.logger.warn(`DTEK response does not contain sub_type_reason for building ${this.building}`);
      this.logger.debug('[DTEK] fetchSchedules: returning [] (no groupKey)');
      return [];
    }

    if (!fact?.data) {
      this.logger.warn(`DTEK fact data is empty`);
      this.logger.debug('[DTEK] fetchSchedules: returning [] (no fact.data)');
      return [];
    }

    const schedules: INormalizedSchedule[] = [];
    const dateKeys = Object.keys(fact.data);
    this.logger.debug(`[DTEK] fetchSchedules: processing ${dateKeys.length} dateKeys=${dateKeys.join(', ')}`);

    Object.keys(fact.data).forEach((dateKey) => {
      const slots = fact.data[dateKey]?.[groupKey];
      if (!slots) {
        this.logger.debug(`[DTEK] fetchSchedules: skip dateKey=${dateKey} (no slots for groupKey)`);
        return;
      }

      const hours = normalizeDtekDaySlots(slots);
      if (!hours) {
        this.logger.debug(`[DTEK] fetchSchedules: skip dateKey=${dateKey} (normalizeDtekDaySlots returned null)`);
        return;
      }

      const date = this.dateFromTimestamp(dateKey);
      schedules.push({ date, hours });
      this.logger.debug(`[DTEK] fetchSchedules: added schedule for dateKey=${dateKey}, date=${date.toISOString()}`);
    });

    this.logger.debug(`[DTEK] fetchSchedules: done, returning ${schedules.length} schedules`);
    return schedules;
  }

  private async fetchDtekPagePayload(): Promise<DtekFetchResult | null> {
    this.logger.debug('[DTEK] fetchDtekPagePayload: start, acquiring puppeteer page');
    const result = await this.puppeteerService.executeWithPage(async (page) => {
      this.logger.debug('[DTEK] fetchDtekPagePayload: page acquired, setting viewport/UA/headers');
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`);
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8',
      });
      page.setDefaultNavigationTimeout(60_000);
      this.logger.debug('[DTEK] fetchDtekPagePayload: navigating to DTEK page (waitUntil=networkidle2, timeout=60s)');
      await page.goto('https://www.dtek-kem.com.ua/ua/shutdowns', {
        waitUntil: 'networkidle2',
        timeout: 60_000,
      });
      this.logger.debug(`[DTEK] fetchDtekPagePayload: page loaded, waiting Incapsula ${INCAPSULA_WAIT_MS}ms`);

      await new Promise((r) => setTimeout(r, INCAPSULA_WAIT_MS));
      this.logger.debug('[DTEK] fetchDtekPagePayload: Incapsula wait done, running page.evaluate (getHomeNum)');

      const evaluatePromise = page.evaluate(
        ({ street }) => {
          return new Promise((resolve, reject) => {
            // Indirect eval, since variables declared with `let`/`const` are not accessible any other way
            const ds: DisconSchedule = (0, eval)('typeof DisconSchedule !== "undefined" ? DisconSchedule : null');
            if (!ds) {
              reject(new Error(`DisconSchedule is not available (html=${document.documentElement.outerHTML})`));
              return;
            }
            if (!ds?.ajax?.url) {
              reject(new Error(`DisconSchedule.ajax not available. (ds=${JSON.stringify(ds)})`));
              return;
            }
            ds.ajax.obj.method = 'getHomeNum';
            ds.ajax.obj.data = [
              { name: 'street', value: street },
              { name: 'updateFact', value: ds.fact?.update },
            ];
            ds.ajax.send(
              (answer) => resolve({
                response: answer as DtekGetHomeNumResponse,
                fact: ds.fact as DtekFactPayload | undefined,
              }),
              (answer) => reject(new Error((answer as { message?: string })?.message ?? 'DTEK getHomeNum failed')),
            );
          });
        },
        { street: this.street },
      );

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`DTEK getHomeNum timed out after ${GET_HOME_NUM_TIMEOUT_MS}ms`)),
          GET_HOME_NUM_TIMEOUT_MS,
        );
      });

      const payload = await Promise.race([evaluatePromise, timeoutPromise]);

      this.logger.debug('[DTEK] fetchDtekPagePayload: page.evaluate done, returning payload');
      return payload as DtekFetchResult | null;
    });
    this.logger.debug(`[DTEK] fetchDtekPagePayload: done, payload=${result ? 'ok' : 'null'}`);
    return result;
  }

  private dateFromTimestamp(timestamp: string): Date {
    const numeric = Number(timestamp);
    if (Number.isNaN(numeric)) {
      return new Date();
    }

    return normalizeScheduleDate(new Date(numeric * 1000));
  }
}
