import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { KdConfig } from '../schemas/kd-config.schema';
import { Model } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { BotService, PendingMessageType } from '../../bot/services/bot.service';
import { config } from '../../../config';
import { IFeedItem, IFeedResponse } from '../interfaces/feed-response.interface';
import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';
import { AxiosError, AxiosResponse } from 'axios';
import { KdProcessedFeedItem } from '../schemas/kd-processed-feed-item.schema';
import { KdProcessedScheduleInfo } from '../schemas/kd-processed-schedule-info.schema';
import { IScheduleItem, IScheduleResponse, PowerState } from '../interfaces/schedule-response.interface';
import { wait } from '../../../helpers/wait.function';
import { pad } from '../../../helpers/pad.function';
import { IDtekObjectsResponse } from '../interfaces/dtek-response.interface';

// login method 0 - sms, input 4 digits
// login method 1 - incoming call, input last 3 digits of phone number

enum FeedItemIdPrefix {
  POWER = 'dcn_',
}

@Injectable()
export class KdService implements OnApplicationBootstrap {

  private logger = new Logger(KdService.name);

  private cachedKdConfig: KdConfig;
  private feedRequestsCounter = {
    count: 0,
    limitsLeft: new Set(),
  };
  private cachedProcessedFeedItemIds: string[] = [];
  private isDtekObjectAvailable: boolean = true;

  private readonly phoneNumber = config.phoneNumber;
  private readonly apiHost = `https://kyiv.digital/api`; // https://stage.kyiv.digital/api

  constructor(
    @InjectModel(KdConfig.name) private kdConfigModel: Model<KdConfig>,
    @InjectModel(KdProcessedFeedItem.name) private kdProcessedFeedItemModel: Model<KdProcessedFeedItem>,
    @InjectModel(KdProcessedScheduleInfo.name) private kdProcessedScheduleInfoModel: Model<KdProcessedScheduleInfo>,
    private readonly httpService: HttpService,
    private readonly botService: BotService,
  ) {
  }

  async onApplicationBootstrap(): Promise<void> {
    this.botService.events.on(PendingMessageType.AskForCode, code => {
      this.logger.debug({ code });
    });
    this.botService.events.on(PendingMessageType.GetSchedule, (options: { day: 'today' | 'tomorrow'; chatId: number; }) => {
      this.sendScheduleToChat(options.day, options.chatId).then();
    });
    this.botService.events.on(PendingMessageType.SendScheduleToAll, (options: { day: 'today' | 'tomorrow'; }) => {
      this.sendScheduleToChat(options.day, undefined, true).then();
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
    }, config.kdFeedRequestIntervalMs * 360);

    try {
      await this.ensureAndCacheConfig();
      await this.cacheProcessedFeedItems();
      await this.validatePersistedToken();

      this.logger.debug(`Dtek object id=${config.dtekObjectId}, checking it`);
      await this.checkDtekObject();

      this.logger.debug(`Requesting feed`);
      await this.handleFeed();

      this.logger.debug(`Requesting schedule`);
      await this.handleScheduleChanges();

      this.logLastTwoProcessedScheduleInfos().then();
    } catch (e) {
      this.onError(e, `Failed to init`);
    }
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

  private async handleFeed(): Promise<void> {
    if (!this.cachedKdConfig.accessToken) {
      const message = `Failed to get feed: no access token`;
      this.logger.error(message);
      this.botService.sendMessageToOwner(new BotMessageText(message)).then();
      return;
    }

    if (!this.isDtekObjectAvailable) {
      setTimeout(() => this.handleFeed(), config.kdFeedRequestIntervalMs);
      return;
    }

    const url = `${this.apiHost}/v4/feed?page=1`;
    const requestConfig = this.buildRequestConfig('get', url);

    this.feedRequestsCounter.count++;

    let response: AxiosResponse<IFeedResponse>;
    try {
      response = await firstValueFrom(this.httpService.request<IFeedResponse>(requestConfig));
    } catch (e) {
      this.onError(e, `Failed to get feed`);

      const noAuthStatuses = [401, 403];
      if (!noAuthStatuses.includes((e as AxiosError).response?.status)) {
        const nextRequestDelay = config.kdFeedRequestIntervalMs * 5;
        this.logger.warn(`Re-fetching feed in "${nextRequestDelay / 1000} sec"...`);
        setTimeout(() => this.handleFeed(), config.kdFeedRequestIntervalMs * 10);
      }

      return;
    }

    const { data, headers } = response;

    try {
      await this.processFeed(data);

      let nextRequestDelay = config.kdFeedRequestIntervalMs;
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
      .filter(feedItem => feedItem.id.startsWith(FeedItemIdPrefix.POWER) || feedItem.title.includes(schedulesDisabledTitle))
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
      const isScheduleToday = feedItem.title === `Новий графік`;
      const isScheduleTomorrow = feedItem.title === `Графік на завтра`;

      botMessageText
        .add(BotMessageText.bold(feedItem.title))
        .add(` • ${createdTimeFormatted}`)
        .newLine()
        .newLine();

      if (isPowerToggle) {
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

  private async sendScheduleToChat(
    day: 'today' | 'tomorrow',
    chatId?: number,
    sendToGroups: boolean = false,
  ): Promise<void> {
    const weekSchedule = await this.getWeekSchedule();
    if (!weekSchedule) {
      return;
    }

    const date = new Date();
    let dayName = 'сьогодні';
    if (day === 'tomorrow') {
      date.setDate(date.getDate() + 1);
      dayName = 'завтра';
    }

    const messageText = new BotMessageText()
      .addLine(BotMessageText.bold(`🗓 Графік на ${dayName}`))
      .newLine();
    messageText.merge(this.buildDayScheduleMessage(weekSchedule, date));

    if (chatId) {
      await this.botService.sendMessage(chatId, messageText);
    } else if (sendToGroups) {
      await this.botService.sendMessageToAllEnabledGroups(messageText);
    }
  }

  private async getWeekSchedule(tryCount: number = 1): Promise<IScheduleItem[]> {
    const url = `${this.apiHost}/v4/dtek/${config.dtekObjectId}`;
    const requestConfig = this.buildRequestConfig('get', url);

    let response: AxiosResponse<IScheduleResponse>;
    try {
      response = await firstValueFrom(this.httpService.request<IScheduleResponse>(requestConfig));
    } catch (e) {
      this.onError(e, `Failed to get schedule`);

      const noAuthStatuses = [401, 403];
      if (tryCount <= 3 && !noAuthStatuses.includes((e as AxiosError).response?.status)) {
        const nextRequestDelay = config.kdFeedRequestIntervalMs * 5;
        this.logger.warn(`Re-fetching schedule in "${nextRequestDelay / 1000} sec"...`);
        await wait(config.kdFeedRequestIntervalMs * 10);
        return this.getWeekSchedule(tryCount + 1);
      }

      return;
    }

    return response.data.schedule;
  }

  private async checkDtekObject(): Promise<void> {
    const url = `${this.apiHost}/v3/dtek`;
    const requestConfig = this.buildRequestConfig('get', url);

    try {
      const response = await firstValueFrom(this.httpService.request<IDtekObjectsResponse>(requestConfig));
      const dtekObject = response.data.objects.find(object => object.id === config.dtekObjectId);
      if (!dtekObject && this.isDtekObjectAvailable) {
        this.isDtekObjectAvailable = false;
        this.logger.error(`Dtek object not found (id=${config.dtekObjectId})`);
        this.logger.debug(response.data);
        this.botService.sendMessageToOwner(new BotMessageText(`Dtek object not found (id=${config.dtekObjectId})`)).then();
      } else if (dtekObject && !this.isDtekObjectAvailable) {
        this.isDtekObjectAvailable = true;
        this.logger.log(`Dtek object found (id=${config.dtekObjectId})`);
      }
    } catch (e) {
      this.onError(e, `Failed to check Dtek objects`);
    }

    setTimeout(() => this.checkDtekObject(), config.kdDtekObjectsRequestIntervalMs);
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

  private async handleScheduleChanges(): Promise<void> {
    const today = new Date();
    today.setHours(6, 0, 0, 0); // set to 6 hours to avoid DST/time zone issues
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const weekSchedule = await this.getWeekSchedule();
    if (!weekSchedule) {
      setTimeout(() => this.handleScheduleChanges(), config.kdFeedRequestIntervalMs * 10);
      return;
    }

    for (const date of [today, tomorrow]) {
      const dayKdFormat = this.buildDayKdFormat(date);
      const schedule = weekSchedule.find(schedule => schedule.day_of_week === dayKdFormat);
      if (!schedule) {
        this.botService.sendMessageToOwner(new BotMessageText(`CRITICAL - No schedule found for date ${date.toISOString()}`)).then();
        continue;
      }

      const processedScheduleInfoDoc = await this.kdProcessedScheduleInfoModel.findOne({ dateIso: date.toISOString() });
      if (processedScheduleInfoDoc) {
        const isScheduleTheSame = Object.keys(schedule.hours).every(halfHour => {
          const currentPowerState = schedule.hours[halfHour];
          const processedPowerState = processedScheduleInfoDoc.scheduleItemHours[halfHour];
          return currentPowerState === processedPowerState;
        });

        if (isScheduleTheSame) {
          continue;
        }
      }

      const persistProcessedScheduleInfo = async (isSent: boolean): Promise<void> => {
        if (processedScheduleInfoDoc) {
          processedScheduleInfoDoc.isSent = isSent;
          processedScheduleInfoDoc.scheduleItemHours = schedule.hours;
          await processedScheduleInfoDoc.save();
        } else {
          const newProcessedScheduleInfo: KdProcessedScheduleInfo = {
            dateIso: date.toISOString(),
            scheduleItemHours: schedule.hours,
            isSent: isSent,
          };
          await this.kdProcessedScheduleInfoModel.create(newProcessedScheduleInfo);
        }

        this.logger.debug(`Persisted processed schedule info (isNew=${!processedScheduleInfoDoc}, date=${date.toISOString()}, isSent=${isSent}, scheduleItemHours=${JSON.stringify(schedule.hours)})`);
      };

      const isScheduleNotSetup = Object.values(schedule.hours).some(powerState => powerState === PowerState.MaybeOff);
      if (isScheduleNotSetup) {
        this.logger.debug(`Schedule not setup (date=${date.toISOString()})`);
        await persistProcessedScheduleInfo(false);
        continue;
      }

      const dayName = date === today ? 'сьогодні' : 'завтра';
      const scheduleTitle = processedScheduleInfoDoc?.isSent ? `Новий графік` : `Графік`;

      this.logger.debug(`Schedule updated (date=${date.toISOString()}, scheduleTitle=${scheduleTitle}, dayName=${dayName}, hours=${JSON.stringify(schedule.hours)}, processedHours=${JSON.stringify(processedScheduleInfoDoc?.toJSON().scheduleItemHours)})`);

      const messageText = new BotMessageText()
        .addLine(BotMessageText.bold(`🗓 ${scheduleTitle} на ${dayName}`))
        .newLine();
      messageText.merge(this.buildDayScheduleMessage(weekSchedule, date));
      messageText.newLine().addLine(BotMessageText.quote(`test`));

      await this.botService.sendMessageToAllEnabledGroups(messageText);
      await persistProcessedScheduleInfo(true);
    }

    setTimeout(() => this.handleScheduleChanges(), config.kdFeedRequestIntervalMs);
  }

  private async logLastTwoProcessedScheduleInfos(): Promise<void> {
    const lastTwoProcessedScheduleInfos = await this.kdProcessedScheduleInfoModel
      .find()
      .sort({ dateIso: -1 })
      .limit(2)
      .exec();
    this.logger.debug(`Last two processed schedule infos:`);
    for (const processedScheduleInfo of lastTwoProcessedScheduleInfos) {
      this.logger.debug(JSON.stringify(processedScheduleInfo.toJSON()));
    }
  }

  private buildDateByItemCreatedAt(created_at: number): Date {
    return new Date(created_at * 1000);
  }

  private onError(error: AxiosError, description: string) {
    this.logger.error(description);

    let message: string = error.message;
    if (error.isAxiosError) {
      message = `${error.code}, ${error.message}, ${error.response?.status}, ${error.response?.statusText}`;
    }

    this.logger.error(message, error.stack);
    if (error.isAxiosError) {
      this.logger.error(error.response?.data);
    }

    this.botService.sendMessageToOwner(new BotMessageText(`${description}: ${message}`)).then();
  }

  private buildDayScheduleMessage(
    weekSchedule: IScheduleItem[],
    date: Date,
  ): BotMessageText {
    const dayKdFormat = this.buildDayKdFormat(date);
    const daySchedule = weekSchedule.find(schedule => schedule.day_of_week === dayKdFormat);
    const halfHours = Object.keys(daySchedule.hours).sort();

    const powerStatesWithRanges: { powerState: PowerState; ranges: { startHalfHour: string; endHalfHour?: string; }[] }[] = [];

    for (let i = 0; i < halfHours.length; i++) {
      const halfHour = halfHours[i];
      const powerState = daySchedule.hours[halfHour];
      const lastPowerStateWithRanges = powerStatesWithRanges.at(-1);
      const lastRange = lastPowerStateWithRanges?.ranges.at(-1);
      const isLastRangeEnded = Boolean(lastRange?.endHalfHour);

      const handleOffPowerState = (powerState: PowerState) => {
        if (!lastPowerStateWithRanges) {
          powerStatesWithRanges.push({ powerState: powerState, ranges: [{ startHalfHour: halfHour }] });
        } else if (lastPowerStateWithRanges.powerState !== powerState) {
          if (lastRange && !isLastRangeEnded) {
            lastRange.endHalfHour = halfHour;
          }

          powerStatesWithRanges.push({ powerState: powerState, ranges: [{ startHalfHour: halfHour }] });
        } else if (isLastRangeEnded) {
          lastPowerStateWithRanges.ranges.push({ startHalfHour: halfHour });
        }
      };

      if (powerState === PowerState.On) {
        if (lastRange && !isLastRangeEnded) {
          lastRange.endHalfHour = halfHour;
        }
      } else if (powerState === PowerState.Off || powerState === PowerState.MaybeOff) {
        handleOffPowerState(powerState);
      }
    }

    const messageText = new BotMessageText();

    if (powerStatesWithRanges.length === 0) {
      messageText.addLine(`Світло буде весь день`);
      return messageText;
    }

    const lastRange = powerStatesWithRanges.at(-1).ranges.at(-1);
    if (!lastRange.endHalfHour) {
      lastRange.endHalfHour = 'h00_0';
    }

    const buildReadableHalfHour = (halfHourStr: string): string => {
      const match = halfHourStr.match(/^h(\d{2})_([01])$/);

      if (!match) {
        return halfHourStr;
      }

      const hour = match[1];
      const halfHourIndex = match[2];
      const halfHour = halfHourIndex === '1' ? '30' : '00';

      return `${hour}:${halfHour}`;
    };

    for (const powerStateWithRanges of powerStatesWithRanges) {
      if (powerStateWithRanges.powerState === PowerState.Off) {
        messageText.addLine(`Світло буде відсутнє:`);
      } else if (powerStateWithRanges.powerState === PowerState.MaybeOff) {
        messageText.addLine(`Можливе відключення:`);
      }

      for (const range of powerStateWithRanges.ranges) {
        const start = buildReadableHalfHour(range.startHalfHour);
        const end = buildReadableHalfHour(range.endHalfHour);
        messageText.addLine(`з ${start} до ${end}`);
      }
    }

    return messageText;
  }

  private buildDayKdFormat(date: Date): number {
    let day = date.getDay();
    if (day === 0) { // force to KD indexes, where Sunday is 7, not 0 (like in JS Date)
      day = 7;
    }
    return day;
  }
}
