import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import puppeteer, { LaunchOptions } from 'puppeteer';
import { config } from '../../../config';
import {
  INormalizedSchedule,
  IScheduleItemHours,
  PowerScheduleProviderId,
} from '../../power-schedule/interfaces/schedule.interface';
import { IPowerScheduleProvider } from '../../power-schedule/interfaces/power-schedule-provider.interface';
import { PowerScheduleOrchestratorService } from '../../power-schedule/services/power-schedule-orchestrator.service';
import { BotService } from '../../bot/services/bot.service';
import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';
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
  data?: DtekFactData | Record<string, unknown>;
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

interface NormalizedScheduleWithMeta {
  schedule: INormalizedSchedule;
  updatedAt?: Date;
}

interface DtekFetchResult {
  response: DtekGetHomeNumResponse;
  fact?: DtekFactPayload;
}

@Injectable()
export class DtekScheduleService
  implements IPowerScheduleProvider, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DtekScheduleService.name);
  private readonly pollIntervalMs = config.dtekPollIntervalMs;
  private readonly street = config.dtekStreet;
  private readonly building = config.dtekBuilding;

  private pollTimer?: NodeJS.Timeout;
  private readonly lastScheduleHashes = new Map<string, string>();

  constructor(
    private readonly powerScheduleOrchestrator: PowerScheduleOrchestratorService,
    private readonly botService: BotService,
  ) {}

  getId(): string {
    return PowerScheduleProviderId.Dtek;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.pollIntervalMs) {
      this.logger.warn(`DTEK polling disabled (interval is falsy)`);
      return;
    }

    this.pollAndNotify()
      .catch((error) => this.onError(error, 'DTEK poll failed'))
      .finally(() => this.scheduleNextPoll());
  }

  onModuleDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
  }

  async getScheduleForDate(date: Date): Promise<INormalizedSchedule | null> {
    try {
      const schedules = await this.fetchSchedules();
      const targetIso = this.normalizeDate(date).toISOString();

      const match = schedules.find(({ schedule }) => {
        return this.normalizeDate(schedule.date).toISOString() === targetIso;
      });

      return match?.schedule ?? null;
    } catch (error) {
      this.onError(error as Error, 'DTEK: getScheduleForDate failed');
      return null;
    }
  }

  private scheduleNextPoll(): void {
    this.pollTimer = setTimeout(() => {
      this.pollAndNotify()
        .catch((error) => this.onError(error, 'DTEK poll failed'))
        .finally(() => {
          this.scheduleNextPoll();
        });
    }, this.pollIntervalMs);
  }

  private async pollAndNotify(): Promise<void> {
    try {
      const schedules = await this.fetchSchedules();
      for (const { schedule, updatedAt } of schedules) {
        if (isAllPowerOn(schedule.hours)) {
          const dateIso = this.normalizeDate(schedule.date).toISOString();
          this.lastScheduleHashes.delete(dateIso);
          this.logger.debug(
            `Skipping ${dateIso}: schedule not published yet (all slots On)`,
          );
          continue;
        }

        const hash = this.hashSchedule(schedule.hours);
        const dateIso = this.normalizeDate(schedule.date).toISOString();
        if (this.lastScheduleHashes.get(dateIso) === hash) {
          continue;
        }

        try {
          await this.powerScheduleOrchestrator.onScheduleChange(
            PowerScheduleProviderId.Dtek,
            schedule.date,
            schedule,
            updatedAt,
          );
          this.lastScheduleHashes.set(dateIso, hash);
          this.logger.log(`Sent DTEK schedule for ${dateIso}`);
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
    this.botService
      .sendMessageToOwner(new BotMessageText(`${description}: ${error.message}`))
      .then();
  }

  private async fetchSchedules(): Promise<NormalizedScheduleWithMeta[]> {
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

    const factData = this.normalizeFactData(fact?.data);
    if (!factData) {
      this.logger.warn(`DTEK fact data is empty`);
      return [];
    }

    const updatedAt =
      this.parseDtekUpdateDate(fact?.update) ??
      this.parseDtekUpdateDate(response.updateTimestamp);

    const dateKeys = this.getRelevantDateKeys(fact, factData);
    const schedules: NormalizedScheduleWithMeta[] = [];

    dateKeys.forEach((dateKey) => {
      const slots = factData[dateKey]?.[groupKey];
      if (!slots) {
        return;
      }

      const hours = normalizeDtekDaySlots(slots);
      if (!hours) {
        return;
      }

      const date = this.dateFromTimestamp(dateKey);
      schedules.push({ schedule: { date, hours }, updatedAt });
    });

    return schedules;
  }

  private async fetchDtekPagePayload(): Promise<DtekFetchResult | null> {
    const launchOptions: LaunchOptions = {
      headless: this.resolveHeadlessOption(config.dtekPuppeteerHeadless),
    };

    const browser = await puppeteer.launch(launchOptions);

    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      );
      page.setDefaultNavigationTimeout(60_000);
      await page.goto('https://www.dtek-kem.com.ua/ua/shutdowns', {
        waitUntil: 'networkidle2',
        timeout: 60_000,
      });

      const payload = await page.evaluate(
        ({ street }) => {
          return new Promise((resolve, reject) => {
            // DisconSchedule is a top-level `let`, not on window; use indirect eval to read from global scope
            const ds: DisconSchedule = (0, eval)('typeof DisconSchedule !== "undefined" ? DisconSchedule : null');
            if (!ds?.ajax?.url) {
              reject(new Error(`DisconSchedule.ajax not available. ${JSON.stringify(ds)}`));
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

  private normalizeFactData(
    factData?: DtekFactData | Record<string, unknown>,
  ): DtekFactData | null {
    if (!factData) {
      return null;
    }

    return factData as DtekFactData;
  }

  private getRelevantDateKeys(
    fact: DtekFactPayload | undefined,
    factData: DtekFactData,
  ): string[] {
    const keys = new Set<string>();

    if (fact?.today) {
      keys.add(String(fact.today));
      keys.add(String(fact.today + 24 * 60 * 60));
    }

    if (!keys.size) {
      Object.keys(factData).forEach((key) => keys.add(key));
    }

    return [...keys];
  }

  private dateFromTimestamp(timestamp: string): Date {
    const numeric = Number(timestamp);
    if (Number.isNaN(numeric)) {
      return new Date();
    }

    return new Date(numeric * 1000);
  }

  private parseDtekUpdateDate(source?: string): Date | undefined {
    if (!source) {
      return undefined;
    }

    const match =
      source.match(
        /(?<hours>\d{2}):(?<minutes>\d{2})\s+(?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{4})/,
      ) ?? undefined;
    if (!match?.groups) {
      return undefined;
    }

    const { hours, minutes, day, month, year } = match.groups;

    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hours),
      Number(minutes),
    );
  }

  private hashSchedule(hours: IScheduleItemHours): string {
    return JSON.stringify(hours);
  }

  private normalizeDate(date: Date): Date {
    const normalized = new Date(date);
    normalized.setHours(0, 0, 0, 0);
    return normalized;
  }

  private resolveHeadlessOption(
    headlessValue: string | boolean | undefined,
  ): LaunchOptions['headless'] {
    if (typeof headlessValue === 'boolean') {
      return headlessValue;
    }

    if (headlessValue === 'true') {
      return true;
    }

    if (headlessValue === 'false') {
      return false;
    }

    return true;
  }
}
