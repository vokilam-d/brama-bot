import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { CONFIG } from '../../../config';

export enum ApiMethodName {
  SendMessage = 'sendMessage',
  SendPhoto = 'sendPhoto',
  SendMediaGroup = 'sendMediaGroup',
  GetMe = 'getMe',
  SetMyCommands = 'setMyCommands',
  AnswerCallbackQuery = 'answerCallbackQuery',
  SetWebhook = 'setWebhook',
  EditMessageText = 'editMessageText',
  SendChatAction = 'sendChatAction',
  SetMessageReaction = 'setMessageReaction',
  DeleteMessages = 'deleteMessages',
}

@Injectable()
export class TelegramApiService {
  private readonly logger = new Logger(TelegramApiService.name);
  private readonly apiHost = `https://api.telegram.org`;
  private readonly token = CONFIG.botToken;
  private readonly tooManyRequestsErrorCode = 429;

  constructor(private readonly httpService: HttpService) {}

  async execMethod<T = any>(methodName: ApiMethodName, data: any): Promise<T> {
    const url = `${this.apiHost}/bot${this.token}/${methodName}`;
    let httpsAgent = null;

    this.logger.debug(`Executing method... (methodName=${methodName})`);
    this.logger.debug({ data, hasSocks5Proxy: !!CONFIG.socks5Proxy });

    if (CONFIG.socks5Proxy) {
      httpsAgent = new SocksProxyAgent(CONFIG.socks5Proxy);
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post<{ ok: boolean; result: T }>(url, data, {
          httpsAgent: httpsAgent,
        }),
      );

      if (response.data?.ok !== true) {
        throw response.data;
      }

      this.logger.debug(`Executing method: Finished (methodName=${methodName})`);
      if (!response.data.result) {
        this.logger.warn({ 'response.data': response.data });
      }

      return response.data.result;
    } catch (error) {
      delete error.response?.data?.config;
      const errorNormalized = error.response?.data || error.response || error;

      if (errorNormalized.error_code === this.tooManyRequestsErrorCode) {
        const retryAfter = errorNormalized.parameters.retry_after * 1000;

        await this.delay(retryAfter);
        return this.execMethod(methodName, data);
      } else {
        delete errorNormalized.config;
        const errorObj = {
          url: error.config?.url,
          method: error.config?.method,
          data: data,
          error: errorNormalized,
        };

        this.logger.error(`Executing method: Failed: (methodName=${methodName})`);
        this.logger.error(errorObj);
        throw errorNormalized;
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
