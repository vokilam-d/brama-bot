import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { KdConfig } from '../schemas/kd-config.schema';
import { Model } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { BotService, PendingMessageType } from '../../bot/services/bot.service';
import { config } from '../../config';
import { IFeedResponse } from '../interfaces/feed-response.interface';
import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';
import { AxiosResponse } from 'axios';

// login method 0 - sms, input 4 digits
// login method 1 - incoming call, input last 3 digits of phone number

@Injectable()
export class KdService implements OnApplicationBootstrap {

  private logger = new Logger(KdService.name);

  private kdConfig: KdConfig;
  private feedRequestsCounter = {
    count: 0,
    limitsLeft: [],
  };

  private readonly phoneNumber = config.phoneNumber;
  private readonly apiHost = `https://kyiv.digital/api`; // https://stage.kyiv.digital/api

  constructor(
    @InjectModel(KdConfig.name) private kdConfigModel: Model<KdConfig>,
    private readonly httpService: HttpService,
    private readonly botService: BotService,
  ) {
  }

  async onApplicationBootstrap(): Promise<void> {
    this.botService.events.on(PendingMessageType.askForCode, code => {
      this.logger.debug({ code });
    });

    setInterval(() => {
      this.logger.debug(this.feedRequestsCounter);
      this.feedRequestsCounter = {
        count: 0,
        limitsLeft: [],
      };
    }, 1000 * 60 * 60);

    try {
      await this.ensureAndCacheConfig();
      await this.validatePersistedToken();
      await this.getFeed();
    } catch (e) {
      this.logger.error(`Could not init:`);
      this.logger.error(e);
    }
  }

  private async ensureAndCacheConfig(): Promise<void> {
    this.kdConfig = await this.kdConfigModel.findOne().exec();
    if (this.kdConfig) {
      return;
    }

    this.kdConfig = new KdConfig();
    this.kdConfig.accessToken = null;
    this.kdConfig.lastProcessedFeedId = null;
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
      this.logger.error(`Could not validate persisted token:`);
      this.logger.error(e);
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
    //   this.logger.error(e);
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
    //   this.logger.error(e);
    // }

    this.logger.debug(`Refreshing token finished`);
  }

  private async getFeed(): Promise<void> {
    if (!this.kdConfig.accessToken) {
      this.logger.error(`Could not get feed: no access token`);
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
      this.logger.error(`Could not get feed:`);
      this.logger.error(e);
      this.botService.sendMessageToOwner(new BotMessageText(`Could not get feed: ${e}`)).then();
      return;
    }

    const { data, headers } = response;

    await this.processFeed(data);

    let nextRequestDelay = config.kdFeedRequestTimeout;
    const rateLimitLeft = Number(headers['x-ratelimit-remaining']);
    this.feedRequestsCounter.limitsLeft.push(rateLimitLeft);

    if (rateLimitLeft <= 5) {
      nextRequestDelay *= 3;

      await this.botService.sendMessageToOwner(
        new BotMessageText(`Rate limit left: ${rateLimitLeft}`)
      );
    }

    setTimeout(() => this.getFeed(), nextRequestDelay);
  }

  private async persistConfig(): Promise<void> {
    await this.kdConfigModel.findOneAndUpdate({}, this.kdConfig);
  }

  private async processFeed(feedResponse: IFeedResponse): Promise<void> {
    const feed = feedResponse.feed.data;
    const firstFeedItem = feed[0];
    if (!firstFeedItem) {
      this.logger.warn(`No feed items`);
      await this.botService.sendMessageToOwner(new BotMessageText(`No feed items`));
      return;
    }

    if (this.kdConfig.lastProcessedFeedId === firstFeedItem.id) {
      return;
    }

    const lastProcessedItemIndex = feed.findIndex(item => item.id === this.kdConfig.lastProcessedFeedId);
    const newFeedItems = lastProcessedItemIndex === -1
      ? feed
      : feed.slice(0, lastProcessedItemIndex);

    const newFeedDcnItems = newFeedItems
      .filter(feedItem => feedItem.id.startsWith(`dcn_`) && feedItem.description.includes(config.address))
      .reverse();

    for (const newFeedDcnItem of newFeedDcnItems) {
      const createdDate = new Date(newFeedDcnItem.created_at * 1000);
      const createdTimeFormatted = this.getFormattedTime(createdDate);

      const botMessageText = new BotMessageText();
      botMessageText
        .add(BotMessageText.bold(newFeedDcnItem.title))
        .add(BotMessageText.bold(`, ${createdTimeFormatted}`))
        .newLine()
        .addLine(newFeedDcnItem.description);

      await this.botService.sendMessageToChannel(botMessageText);
    }

    this.kdConfig.lastProcessedFeedId = firstFeedItem.id;
    this.logger.debug(`Processed ${newFeedDcnItems.length} new feed items, lastProcessedFeedId=${this.kdConfig.lastProcessedFeedId}`);
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
}
