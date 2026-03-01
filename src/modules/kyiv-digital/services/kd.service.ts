import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { KdConfig } from '../schemas/kd-config.schema';
import { Model } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { BotService, PendingMessageType } from '../../bot/services/bot.service';
import { CONFIG } from '../../../config';
import { IFeedItem, IFeedResponse } from '../interfaces/feed-response.interface';
import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';
import { AxiosError, AxiosResponse } from 'axios';
import { KdProcessedFeedItem } from '../schemas/kd-processed-feed-item.schema';
import { IScheduleItem, IScheduleResponse } from '../interfaces/schedule-response.interface';
import { wait } from '../../../helpers/wait.function';
import { pad } from '../../../helpers/pad.function';
import { IDtekObjectsResponse } from '../interfaces/dtek-response.interface';

// login method 0 - sms, input 4 digits
// login method 1 - incoming call, input last 3 digits of phone number

enum FeedItemIdPrefix {
  POWER = 'dcn_',
  POWER_INFO = 'cmp_',
}

@Injectable()
export class KdService implements OnApplicationBootstrap {
  private logger = new Logger(KdService.name);

  private readonly whenReadyPromise: Promise<void>;
  private resolveReady!: () => void;

  private cachedKdConfig!: KdConfig;
  private feedRequestsCounter = {
    count: 0,
    limitsLeft: new Set(),
  };
  private cachedProcessedFeedItemIds: string[] = [];
  private isDtekObjectAvailable: boolean = true;

  private readonly phoneNumber = CONFIG.kyivDigital.phoneNumber;
  private readonly apiHost = `https://kyiv.digital/api`; // https://stage.kyiv.digital/api

  constructor(
    @InjectModel(KdConfig.name) private kdConfigModel: Model<KdConfig>,
    @InjectModel(KdProcessedFeedItem.name) private kdProcessedFeedItemModel: Model<KdProcessedFeedItem>,
    private readonly httpService: HttpService,
    private readonly botService: BotService,
  ) {
    this.whenReadyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  /** Resolves when config is cached and token is validated. Dependents should await before using getWeekSchedule. */
  whenReady(): Promise<void> {
    return this.whenReadyPromise;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.botService.events.on(PendingMessageType.AskForCode, code => {
      this.logger.debug({ code });
    });

    setInterval(() => {
      if (Object.values(this.feedRequestsCounter.limitsLeft.values()).some(limit => limit < 56)) {
        this.logger.warn({
          count: this.feedRequestsCounter.count,
          limitsLeft: [...this.feedRequestsCounter.limitsLeft.values()],
        });
      }
      this.feedRequestsCounter.count = 0;
      this.feedRequestsCounter.limitsLeft.clear();
    }, CONFIG.kyivDigital.feedRequestIntervalMs * 360);

    try {
      await this.ensureAndCacheConfig();
      await this.cacheProcessedFeedItems();
      await this.validatePersistedToken();
    } catch (e) {
      this.onError(e, `Failed to init`);
    } finally {
      this.resolveReady();
    }

    this.logger.debug(`Dtek object id=${CONFIG.kyivDigital.dtekObjectId}, checking it`);
    this.checkDtekObject().then();

    this.logger.debug(`Requesting feed`);
    this.handleFeed().then();
  }

  private async ensureAndCacheConfig(): Promise<void> {
    this.logger.debug(`Ensuring and caching config...`);

    this.cachedKdConfig = await this.kdConfigModel.findOne().exec();
    if (this.cachedKdConfig) {
      this.logger.log(`Ensuring and caching config: Finished: Config found`);
    } else {
      this.cachedKdConfig = new KdConfig();
      this.cachedKdConfig.accessToken = null;
      this.cachedKdConfig.lastProcessedFeedItemCreatedAtIso = null;
      await this.kdConfigModel.create(this.cachedKdConfig);
      this.logger.log(`Ensuring and caching config: Finished: New config created`);
    }

    this.logger.debug(this.cachedKdConfig);
  }

  private async validatePersistedToken(): Promise<void> {
    this.logger.debug(`Validating persisted token...`);

    try {
      if (this.cachedKdConfig.accessToken) {
        await this.refreshToken();
      } else {
        await this.login();
      }

      this.logger.debug(`Validating persisted token: Finished`);
    } catch (e) {
      this.onError(e, `Validating persisted token: Failed`);
    }
  }

  private async login(): Promise<void> {
    this.logger.debug(`Login...`);

    // const url = `${this.apiHost}/v4/login?phone=${this.phoneNumber}`;
    //
    // try {
    //   const { data } = await firstValueFrom(this.httpService.post<any>(url, url));
    //   this.logger.log({ data })
    // } catch (e) {
    //   this.logger.error(e, e.stack);
    // }

    this.logger.debug(`Login finished`);
  }

  private async refreshToken(): Promise<void> {
    this.logger.debug(`Refreshing token...`);

    // const url = `${this.apiHost}/v3/auth/refresh`;
    //
    // try {
    //   const { data } = await firstValueFrom(this.httpService.get<any>(url));
    //   this.logger.log({ data })
    // } catch (e) {
    //   this.logger.error(e, e.stack);
    // }

    this.logger.debug(`Refreshing token finished`);
  }

  private async handleFeed(tryCount: number = 1): Promise<void> {
    if (!this.cachedKdConfig.accessToken) {
      const message = `Failed to get feed: no access token`;
      this.logger.error(message);
      this.botService.sendMessageToOwner(new BotMessageText(message)).then();
      return;
    }

    if (!this.isDtekObjectAvailable) {
      setTimeout(() => this.handleFeed(), CONFIG.kyivDigital.dtekObjectsRequestIntervalMs);
      return;
    }

    const url = `${this.apiHost}/v4/feed?page=1`;
    const requestConfig = this.buildRequestConfig('get', url);

    this.feedRequestsCounter.count++;

    let response: AxiosResponse<IFeedResponse>;
    try {
      response = await firstValueFrom(this.httpService.request<IFeedResponse>(requestConfig));

      tryCount = 1;
    } catch (e) {
      this.onError(e, `Failed to get feed`, tryCount >= 3);

      const noAuthStatuses = [401, 403];
      if (!noAuthStatuses.includes((e as AxiosError).response?.status)) {
        const nextRequestDelay = CONFIG.kyivDigital.feedRequestIntervalMs * 10;
        this.logger.warn(`Re-fetching feed in "${nextRequestDelay / 1000} sec"...`);
        setTimeout(() => this.handleFeed(tryCount + 1), nextRequestDelay);
      }

      return;
    }

    const { data, headers } = response;

    try {
      await this.processFeed(data);

      let nextRequestDelay = CONFIG.kyivDigital.feedRequestIntervalMs;
      const rateLimitLeft = Number(headers['x-ratelimit-remaining']);
      this.feedRequestsCounter.limitsLeft.add(rateLimitLeft);

      if (rateLimitLeft <= 5) {
        nextRequestDelay *= 10;

        this.botService.sendMessageToOwner(new BotMessageText(`Rate limit left: ${rateLimitLeft}`)).then();
      }

      setTimeout(() => this.handleFeed(), nextRequestDelay);

    } catch (e) {
      this.onError(e, `CRITICAL - Failed to process feed`);
    }
  }

  private async persistConfig(): Promise<void> {
    this.logger.debug(`Persisting config...`);
    this.logger.debug(this.cachedKdConfig);

    await this.kdConfigModel.findOneAndUpdate({}, this.cachedKdConfig);

    this.logger.debug(`Persisting config finished`);
  }

  private async processFeed(feedResponse: IFeedResponse): Promise<void> {
    if (!feedResponse.feed) {
      this.logger.warn(`No feed in response`);
      this.logger.debug(feedResponse);
      await this.botService.sendMessageToOwner(new BotMessageText(`No feed in response`));
      return;
    }

    const feed = feedResponse.feed.data;
    if (feed.length === 0) {
      this.logger.warn(`No feed items`);
      await this.botService.sendMessageToOwner(new BotMessageText(`No feed items`));
      return;
    }

    const schedulesDisabledTitle = `Графік не діє`;
    const relevantFeedItems = feed
      .filter(feedItem => {
        return `${feedItem.id}`.startsWith(FeedItemIdPrefix.POWER)
          || `${feedItem.id}`.startsWith(FeedItemIdPrefix.POWER_INFO)
          || feedItem.title?.includes(schedulesDisabledTitle);
      })
      .reverse();

    const processedFeedItems: IFeedItem[] = [];
    for (const feedItem of relevantFeedItems) {
      if (this.cachedProcessedFeedItemIds.includes(feedItem.id)) {
        // check for already processed feed items
        continue;
      }

      const createdDate = this.buildDateByItemCreatedAt(feedItem.created_at);
      await this.onFeedItemProcessed(feedItem);
      processedFeedItems.push(feedItem);

      const lastProcessedFeedItemCreatedAt = new Date(this.cachedKdConfig.lastProcessedFeedItemCreatedAtIso);
      if (createdDate <= lastProcessedFeedItemCreatedAt) {
        // double-check for already processed feed items

        const message = `Failed double-check for already processed feed items, createdDate=${createdDate.toISOString()}, lastProcessedFeedItemCreatedAt=${lastProcessedFeedItemCreatedAt.toISOString()}, title=${feedItem.title}`;
        this.logger.error(message);
        this.botService.sendMessageToOwner(new BotMessageText(message)).then();
        continue;
      }

      this.cachedKdConfig.lastProcessedFeedItemCreatedAtIso = createdDate.toISOString();

      const createdTimeFormatted = this.getFormattedTime(createdDate);
      const botMessageText = new BotMessageText();
      const isPowerToggle = feedItem.title.includes(`Стабілізаційне відключення`)
        || feedItem.title.includes(`Світло повертається`)
        || feedItem.title.includes(schedulesDisabledTitle);
      const isPowerInfo = feedItem.title.includes(`Коротші відключення`);
      const isScheduleToday = feedItem.title === `Новий графік`;
      const isScheduleTomorrow = feedItem.title === `Графік на завтра`;

      botMessageText
        .add(BotMessageText.bold(feedItem.title))
        .add(` • ${createdTimeFormatted}`)
        .newLine()
        .newLine();

      if (isPowerToggle || isPowerInfo) {
        botMessageText.addLine(feedItem.description);
      // } else if (isScheduleToday || isScheduleTomorrow) {
      //   botMessageText.prependToFirstLine('🗓 ');

      //   const weekSchedule = await this.getWeekSchedule();
      //   if (!weekSchedule) {
      //     this.botService.sendMessageToOwner(new BotMessageText(`CRITICAL - Failed to get schedule`)).then();
      //     continue;
      //   }

      //   if (isScheduleToday) {
      //     botMessageText.merge(this.buildDayScheduleMessage(weekSchedule, createdDate));
      //   } else if (isScheduleTomorrow) {
      //     const tomorrowDate = new Date(createdDate);
      //     tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      //     botMessageText.merge(this.buildDayScheduleMessage(weekSchedule, tomorrowDate));
      //   }
      } else {
        continue;
      }

      await this.botService.sendMessageToAllEnabledGroups(botMessageText);
    }

    if (processedFeedItems.length === 0) {
      return;
    }

    this.logger.debug(`Processing feed finished, items count=${processedFeedItems.length}`);
    await this.persistConfig();
  }

  async getWeekSchedule(tryCount: number = 1): Promise<IScheduleItem[] | null> {
    const url = `${this.apiHost}/v4/dtek/${CONFIG.kyivDigital.dtekObjectId}`;
    const requestConfig = this.buildRequestConfig('get', url);

    let response: AxiosResponse<IScheduleResponse>;
    try {
      response = await firstValueFrom(this.httpService.request<IScheduleResponse>(requestConfig));
    } catch (e) {
      this.onError(e, `Failed to get schedule`, tryCount >= 3);

      const noAuthStatuses = [401, 403];
      if (tryCount <= 3 && !noAuthStatuses.includes((e as AxiosError).response?.status)) {
        const nextRequestDelay = CONFIG.kyivDigital.feedRequestIntervalMs * 10;
        this.logger.warn(`Re-fetching schedule in "${nextRequestDelay / 1000} sec"...`);
        await wait(nextRequestDelay);
        return this.getWeekSchedule(tryCount + 1);
      }

      return null;
    }

    return response.data.schedule ?? null;
  }

  private async checkDtekObject(tryCount: number = 1): Promise<void> {
    const url = `${this.apiHost}/v3/dtek`;
    const requestConfig = this.buildRequestConfig('get', url);

    try {
      const response = await firstValueFrom(this.httpService.request<IDtekObjectsResponse>(requestConfig));
      const dtekObject = response.data.objects.find(object => object.id === CONFIG.kyivDigital.dtekObjectId);
      if (!dtekObject && this.isDtekObjectAvailable) {
        this.isDtekObjectAvailable = false;
        this.logger.error(`Dtek object not found (id=${CONFIG.kyivDigital.dtekObjectId})`);
        this.logger.debug(response.data);
        this.botService.sendMessageToOwner(new BotMessageText(`Dtek object not found (id=${CONFIG.kyivDigital.dtekObjectId})`)).then();
      } else if (dtekObject && !this.isDtekObjectAvailable) {
        this.isDtekObjectAvailable = true;
        this.logger.log(`Dtek object found (id=${CONFIG.kyivDigital.dtekObjectId})`);
      }

      tryCount = 1;
    } catch (e) {
      this.onError(e, `Failed to check Dtek objects`, tryCount >= 3);

      tryCount++;
    }

    setTimeout(() => this.checkDtekObject(tryCount), CONFIG.kyivDigital.dtekObjectsRequestIntervalMs);
  }

  private buildRequestConfig(method: 'get', url: string) {
    const authHeader = `Bearer ${this.cachedKdConfig.accessToken}`;

    /* eslint-disable */
    return {
      method: method,
      maxBodyLength: Infinity,
      url: url,
      headers: {
        'Host': 'kyiv.digital',
        'Cookie': 'XSRF-TOKEN=eyJpdiI6ImJlMis3TGg1TWhGRGdsR3JsU29Cb3c9PSIsInZhbHVlIjoiMXVOMW1CSVpwZGk5dXBKMUlTMHNjblFwNUVjc0ZyN1JoM2c5WE1wVG43V2tuZlR5S2lLWUpiVEttZ3B2YjhTcjg0bnFRQ2ZzQlRMSERjMVcwT3hrMy9pbG5PRXMvK25ZVFE4bXpreU1maFdPcm5JLzN0bVo4NlpRSWhwVDlSV24iLCJtYWMiOiJhYzRiODliMGQ2ZTU3N2RiNmE0YTQxYWMyNWUzYzRmN2Q3YjY2NjZkOGU2NTZmZGQxM2I1MWJhODkwMDc2ZWVlIiwidGFnIjoiIn0%3D; kyivdigital_session=eyJpdiI6Ikc4SGFzYVJ0Zm5JY2JsNTRQOFhlbUE9PSIsInZhbHVlIjoiWDltb1NaemxxbDQ5SEpBcjJJZURUZ0g2MXBxdDlEejNYeVo2c1lXaFF6blU4a0Q1QkJGZTUyS2pGZ1RtZGpZSkkxZ2VLRm1VUEgvbjFXekJvem5lbkNpVGF0WDI4UTZtZG94ZGNaMHBrUlZpT04xdWY0R1pGY01SbmltS0ZEKzkiLCJtYWMiOiJhYmYyNDhjZGVmMWIzZmM3OGEzNWU3N2I1MDI0NTcwMmQwYzI1NGI4Yjc1ZTg5MDNmMTc3MTY1ZmM2ODU0MWRlIiwidGFnIjoiIn0%3D',
        'content-type': 'application/json',
        'accept': 'application/json',
        'authorization': authHeader,
        'x-client-version': '2.18.6',
        'x-client-auth': 'ea616729cad76840f183bbc3e55db9885e57c7483488f227703dc8a1f26e9a1c',
        'x-client-platform': '1',
        'accept-language': 'en-GB,en;q=0.9',
        'x-client-locale': 'uk',
        'x-device-uuid': '11E307AB-23D2-4F8B-AD61-CD9A9276653D',
        'user-agent': 'KD/2.18.6(1) iOS/17.5.1 User/3315799',
      },
    };
    /* eslint-enable */
  }

  private getFormattedTime(date: Date): string {
    const timeParts = [
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
    ];

    return timeParts
      .map(part => pad(part))
      .join(':');
  }

  private async cacheProcessedFeedItems(): Promise<void> {
    this.logger.debug(`Caching processed feed item ids...`);

    const processedFeedItems = await this.kdProcessedFeedItemModel.find().exec();
    this.cachedProcessedFeedItemIds = processedFeedItems.map(feedItem => feedItem.id);

    this.logger.debug(`Caching processed feed item ids: Finished (count=${this.cachedProcessedFeedItemIds.length})`);
  }

  private async onFeedItemProcessed(feedDcnItem: IFeedItem): Promise<void> {
    this.logger.debug(`On feed item processed...`);

    const processedFeedItem: KdProcessedFeedItem = {
      id: feedDcnItem.id,
      title: feedDcnItem.title,
      description: feedDcnItem.description,
      createdAtIso: this.buildDateByItemCreatedAt(feedDcnItem.created_at).toISOString(),
    };

    this.cachedProcessedFeedItemIds.push(processedFeedItem.id);
    await this.kdProcessedFeedItemModel.create(processedFeedItem);

    this.logger.debug(`On feed item processed: Finished`);
    this.logger.debug(processedFeedItem);
  }

  private buildDateByItemCreatedAt(created_at: number): Date {
    return new Date(created_at * 1000);
  }

  private onError(error: AxiosError, description: string, sendToOwner: boolean = true) {
    this.logger.error(description);

    let message: string = error.message;
    if (error.isAxiosError) {
      message = `${error.code}, ${error.message}, ${error.response?.status}, ${error.response?.statusText}`;
    }

    this.logger.error(message, error.stack);
    if (error.isAxiosError) {
      this.logger.error(error.response?.data);
    }

    if (sendToOwner) {
      this.botService.sendMessageToOwner(new BotMessageText(`${description}: ${message}`)).then();
    }
  }
}
