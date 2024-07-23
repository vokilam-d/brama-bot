import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { KdConfig } from '../schemas/kd-config.schema';
import { Model } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { BotService, PendingMessageType } from '../../bot/services/bot.service';
import { config } from '../../config';
import { IFeedItem, IFeedResponse } from '../interfaces/feed-response.interface';
import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';
import { AxiosError, AxiosResponse } from 'axios';
import { KdProcessedFeedItem } from '../schemas/kd-processed-feed-item.schema';

// login method 0 - sms, input 4 digits
// login method 1 - incoming call, input last 3 digits of phone number

@Injectable()
export class KdService implements OnApplicationBootstrap {

  private logger = new Logger(KdService.name);

  private kdConfig: KdConfig;
  private feedRequestsCounter = {
    count: 0,
    limitsLeft: new Set(),
  };
  private cachedProcessedFeedItemIds: string[] = [];

  private readonly phoneNumber = config.phoneNumber;
  private readonly apiHost = `https://kyiv.digital/api`; // https://stage.kyiv.digital/api

  constructor(
    @InjectModel(KdConfig.name) private kdConfigModel: Model<KdConfig>,
    @InjectModel(KdProcessedFeedItem.name) private kdProcessedFeedItemModel: Model<KdProcessedFeedItem>,
    private readonly httpService: HttpService,
    private readonly botService: BotService,
  ) {
  }

  async onApplicationBootstrap(): Promise<void> {
    this.botService.events.on(PendingMessageType.askForCode, code => {
      this.logger.debug({ code });
    });

    setInterval(() => {
      this.logger.debug({
        count: this.feedRequestsCounter.count,
        limitsLeft: [...this.feedRequestsCounter.limitsLeft.values()],
      });
      this.feedRequestsCounter.count = 0;
      this.feedRequestsCounter.limitsLeft.clear();
    }, config.kdFeedRequestTimeout * 360);

    try {
      await this.ensureAndCacheConfig();
      await this.cacheProcessedFeedItems();
      await this.validatePersistedToken();
      await this.getFeed();
    } catch (e) {
      this.onError(e, `Could not init`);
    }
  }

  private async ensureAndCacheConfig(): Promise<void> {
    this.kdConfig = await this.kdConfigModel.findOne().exec();
    if (this.kdConfig) {
      return;
    }

    this.kdConfig = new KdConfig();
    this.kdConfig.accessToken = null;
    this.kdConfig.lastProcessedFeedItemCreatedAtIso = null;
    await this.kdConfigModel.create(this.kdConfig);
  }

  private async validatePersistedToken(): Promise<void> {
    this.logger.debug(`Validating persisted token...`);

    try {
      if (this.kdConfig.accessToken) {
        await this.refreshToken();
      } else {
        await this.login();
      }

      this.logger.debug(`Validating persisted token finished, accessToken=${this.kdConfig.accessToken}`);
    } catch (e) {
      this.onError(e, `Could not validate persisted token`);
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

  private async getFeed(): Promise<void> {
    if (!this.kdConfig.accessToken) {
      const message = `Could not get feed: no access token`;
      this.logger.error(message);
      this.botService.sendMessageToOwner(new BotMessageText(message)).then();
      return;
    }

    const url = `${this.apiHost}/v4/feed?page=1`;
    const authHeader = `Bearer ${this.kdConfig.accessToken}`;

    /* eslint-disable */
    const urlConfig = {
      method: 'get',
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
        'user-agent': 'KD/2.18.6(1) iOS/17.5.1 User/3315799'
      }
    };
    /* eslint-enable */

    this.feedRequestsCounter.count++;

    let response: AxiosResponse<IFeedResponse>;
    try {
      response = await firstValueFrom(this.httpService.request<IFeedResponse>(urlConfig));
    } catch (e) {
      this.onError(e, `Could not get feed`);

      const noAuthStatuses = [401, 403];
      if (!noAuthStatuses.includes((e as AxiosError).response?.status)) {
        const nextRequestDelay = config.kdFeedRequestTimeout * 5;
        this.logger.debug(`Re-fetching feed in "${nextRequestDelay / 1000} sec"...`);
        setTimeout(() => this.getFeed(), config.kdFeedRequestTimeout * 10);
      }

      return;
    }

    const { data, headers } = response;

    try {
      await this.processFeed(data);

      let nextRequestDelay = config.kdFeedRequestTimeout;
      const rateLimitLeft = Number(headers['x-ratelimit-remaining']);
      this.feedRequestsCounter.limitsLeft.add(rateLimitLeft);

      if (rateLimitLeft <= 5) {
        nextRequestDelay *= 10;

        this.botService.sendMessageToOwner(new BotMessageText(`Rate limit left: ${rateLimitLeft}`)).then();
      }

      setTimeout(() => this.getFeed(), nextRequestDelay);

    } catch (e) {
      this.onError(e, `Could not process feed`);
    }
  }

  private async persistConfig(): Promise<void> {
    this.logger.debug(`Persisting config...`);
    this.logger.debug(this.kdConfig);

    await this.kdConfigModel.findOneAndUpdate({}, this.kdConfig);

    this.logger.debug(`Persisting config finished`);
  }

  private async processFeed(feedResponse: IFeedResponse): Promise<void> {
    const feed = feedResponse.feed.data;
    if (feed.length === 0) {
      this.logger.warn(`No feed items`);
      await this.botService.sendMessageToOwner(new BotMessageText(`No feed items`));
      return;
    }

    const feedDcnItems = feed
      .filter(feedItem => feedItem.id.startsWith(`dcn_`) && feedItem.description.includes(config.address))
      .reverse();

    const processedFeedItems: IFeedItem[] = [];
    for (const feedDcnItem of feedDcnItems) {
      if (this.cachedProcessedFeedItemIds.includes(feedDcnItem.id)) {
        // check for already processed feed items
        continue;
      }

      const createdDate = this.buildDateByItemCreatedAt(feedDcnItem.created_at);
      const lastProcessedFeedItemCreatedAt = new Date(this.kdConfig.lastProcessedFeedItemCreatedAtIso);
      if (createdDate < lastProcessedFeedItemCreatedAt) {
        // double-check for already processed feed items

        const message = `Failed double-check for already processed feed items, createdDate=${createdDate.toISOString()}, lastProcessedFeedItemCreatedAt=${lastProcessedFeedItemCreatedAt.toISOString()}`;
        this.logger.error(message);
        this.botService.sendMessageToOwner(new BotMessageText(message)).then();
        await this.onFeedItemProcessed(feedDcnItem);
        continue;
      }

      const createdTimeFormatted = this.getFormattedTime(createdDate);

      const botMessageText = new BotMessageText();
      botMessageText
        .add(BotMessageText.bold(feedDcnItem.title))
        .add(BotMessageText.bold(`, ${createdTimeFormatted}`))
        .newLine()
        .addLine(feedDcnItem.description);

      await this.onFeedItemProcessed(feedDcnItem);
      await this.botService.sendMessageToAllGroups(botMessageText);

      this.kdConfig.lastProcessedFeedItemCreatedAtIso = createdDate.toISOString();
      processedFeedItems.push(feedDcnItem);
    }

    if (processedFeedItems.length === 0) {
      return;
    }

    this.logger.debug(`Processing feed finished, items count=${processedFeedItems.length}`);
    await this.persistConfig();
  }

  private getFormattedTime(date: Date): string {
    const timeParts = [
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
    ];
    const pad = (num: number | string) => `${num}`.padStart(2, '0');

    return timeParts
      .map(pad)
      .join(':');
  }

  private async cacheProcessedFeedItems(): Promise<void> {
    this.logger.debug(`Caching processed feed item ids...`);

    const processedFeedItems = await this.kdProcessedFeedItemModel.find().exec();
    this.cachedProcessedFeedItemIds = processedFeedItems.map(feedItem => feedItem.id);

    this.logger.debug(`Caching processed feed item id finished, count=${this.cachedProcessedFeedItemIds.length}`);
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

    this.logger.debug(`On feed item processed finished:`);
    this.logger.debug({ processedFeedItem });
  }

  private buildDateByItemCreatedAt(created_at: number): Date {
    return new Date(created_at * 1000);
  }

  private onError(error: AxiosError, description: string) {
    this.logger.error(description);

    let message: string = error.message;
    if (error.isAxiosError) {
      message = `${error.code}, ${error.message}, ${error.response.status}, ${error.response.statusText}`;
    }

    this.logger.error(message, error.stack);
    if (error.isAxiosError) {
      this.logger.error(error.response.data);
    }

    this.botService.sendMessageToOwner(new BotMessageText(`${description}: ${message}`)).then();
  }
}
