import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
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
  DtekSlotValue,
  isAllPowerOn,
  normalizeDtekDaySlots,
} from '../helpers/dtek-normalize.helper';
import { LaunchOptions } from 'puppeteer';
import { isInDocker } from '../../../helpers/is-in-docker';

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

@Injectable()
export class DtekScheduleService implements IPowerScheduleProvider, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DtekScheduleService.name);
  private readonly pollIntervalMs = CONFIG.dtek.pollIntervalMs;
  private readonly street = CONFIG.dtek.street;
  private readonly building = CONFIG.dtek.building;

  private pollTimer?: NodeJS.Timeout;
  private readonly lastScheduleHashes = new Map<string, string>();

  constructor(
    private readonly powerScheduleOrchestrator: PowerScheduleOrchestratorService,
    private readonly botService: BotService,
    private readonly powerScheduleConfigService: PowerScheduleConfigService,
  ) {}

  getId(): string {
    return PowerScheduleProviderId.Dtek;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.pollIntervalMs) {
      this.logger.warn(`DTEK polling disabled (interval is falsy)`);
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
    const enabled = this.powerScheduleConfigService.isProviderEnabled(PowerScheduleProviderId.Dtek) ?? true;
    if (enabled && !this.pollTimer) {
      void this.schedulePollAndNotify();
    } else if (!enabled && this.pollTimer) {
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
      this.onError(error as Error, 'DTEK: getScheduleForDate failed');
      return null;
    }
  }

  private async schedulePollAndNotify(): Promise<void> {
    const enabled = this.powerScheduleConfigService.isProviderEnabled(PowerScheduleProviderId.Dtek) ?? true;
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
        if (isAllPowerOn(schedule.hours)) {
          this.lastScheduleHashes.delete(dateIso);
          continue;
        }

        const hash = this.hashSchedule(schedule.hours);
        if (this.lastScheduleHashes.get(dateIso) === hash) {
          continue;
        }

        try {
          this.logger.debug(`Sending DTEK schedule for ${dateIso}`);
          await this.powerScheduleOrchestrator.onScheduleChange(
            PowerScheduleProviderId.Dtek,
            schedule.date,
            schedule,
          );
          this.lastScheduleHashes.set(dateIso, hash);
        } catch (error) {
          this.onError(
            error as Error,
            `DTEK: Failed to notify orchestrator for ${dateIso}`,
          );
        }
      }
    } catch (error) {
      this.onError(error as Error, 'DTEK: Failed to fetch schedule');
    }
  }

  private onError(error: Error, description: string): void {
    const message = error.stack ?? error.message ?? String(error);
    this.logger.error(`${description}: ${message}`);
    void this.botService.sendMessageToOwner(new BotMessageText(`${description}: ${message}`));
  }

  private async fetchSchedules(): Promise<INormalizedSchedule[]> {
    const payload = await this.fetchDtekPagePayload();
    if (!payload) {
      return [];
    }

    const { response, fact } = payload;
    if (!response.result) {
      this.logger.warn(`DTEK response missing result flag`);
      return [];
    }

    const buildingInfo = response.data?.[this.building];
    const groupKey = buildingInfo?.sub_type_reason?.[0];
    if (!groupKey) {
      this.logger.warn(`DTEK response does not contain sub_type_reason for building ${this.building}`);
      return [];
    }

    if (!fact?.data) {
      this.logger.warn(`DTEK fact data is empty`);
      return [];
    }

    const schedules: INormalizedSchedule[] = [];

    Object.keys(fact.data).forEach((dateKey) => {
      const slots = fact.data[dateKey]?.[groupKey];
      if (!slots) {
        return;
      }

      const hours = normalizeDtekDaySlots(slots);
      if (!hours) {
        return;
      }

      const date = this.dateFromTimestamp(dateKey);
      schedules.push({ date, hours });
    });

    return schedules;
  }

  private async fetchDtekPagePayload(): Promise<DtekFetchResult | null> {
    puppeteer.use(StealthPlugin());

    const launchOptions: LaunchOptions = {
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--no-zygote',
      ],
    };
    if (isInDocker()) {
      launchOptions.executablePath = 'google-chrome-stable';
      launchOptions.args.push('--single-process');
    }
    const browser = await puppeteer.launch({
      headless: true,
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      );
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8',
      });
      page.setDefaultNavigationTimeout(60_000);
      await page.goto('https://www.dtek-kem.com.ua/ua/shutdowns', {
        waitUntil: 'networkidle2',
        timeout: 60_000,
      });

      await new Promise((r) => setTimeout(r, INCAPSULA_WAIT_MS));

      const payload = await page.evaluate(
        ({ street }) => {
          return new Promise((resolve, reject) => {
            // DisconSchedule is a top-level `let`, not on window; use indirect eval to read from global scope
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
              {
                "name": "street",
                "value": street
              },
              {
                "name": "updateFact",
                "value": ds.fact?.update
              }
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

      return payload as DtekFetchResult | null;
    } finally {
      await browser.close();
    }
  }

  private dateFromTimestamp(timestamp: string): Date {
    const numeric = Number(timestamp);
    if (Number.isNaN(numeric)) {
      return new Date();
    }

    return normalizeScheduleDate(new Date(numeric * 1000));
  }

  private hashSchedule(hours: IScheduleItemHours): string {
    return JSON.stringify(hours);
  }
}
