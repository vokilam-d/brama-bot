import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { HttpService } from '@nestjs/axios';
import { BotConfig } from '../schemas/bot-config.schema';
import { config } from '../../config';
import { firstValueFrom } from 'rxjs';
import { BotMessageText } from '../helpers/bot-message-text.helper';
import { ITelegramReplyParameters } from '../interfaces/telegram-reply-parameters.interface';
import { ITelegramInlineKeyboardMarkup } from '../interfaces/inline-keyboard-markup.interface';
import { ITelegramReplyKeyboardMarkup } from '../interfaces/reply-keyboard-markup.interface';
import { ITelegramReplyKeyboardRemove } from '../interfaces/reply-keyboard-remove.interface';
import { ITelegramMessage } from '../interfaces/message.interface';
import { EventEmitter } from 'events';
import { BotSentMessage } from '../schemas/bot-sent-message.schema';

export type ReplyMarkup = ITelegramInlineKeyboardMarkup | ITelegramReplyKeyboardMarkup | ITelegramReplyKeyboardRemove;

enum ApiMethodName {
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
}

export enum PendingMessageType {
  askForCode = 'askForCode',
}

@Injectable()
export class BotService implements OnApplicationBootstrap {

  events = new EventEmitter();

  private readonly logger = new Logger(BotService.name);
  private botConfig: BotConfig;

  private pendingMessages: { type: PendingMessageType, chatId: number, messageId: number, }[] = [];

  private readonly maxMessageTextSize = 4000;
  private readonly apiHost = `https://api.telegram.org`;
  private readonly token = config.botToken;
  private readonly tooManyRequestsErrorCode = 429;
  private readonly textParseMode = 'HTML';
  private readonly supportedTags: string[] = ['b', 'i', 'a', 'pre', 'code'];

  constructor(
    @InjectModel(BotConfig.name) private botConfigModel: Model<BotConfig>,
    @InjectModel(BotSentMessage.name) private botSentMessageModel: Model<BotSentMessage>,
    private readonly httpService: HttpService,
  ) {
  }

  async onApplicationBootstrap(): Promise<void> {
    // this.setWebhook();

    try {
      await this.ensureAndCacheConfig();
    } catch (e) {
      this.logger.error(`Could not init:`);
      this.logger.error(e);
    }

    if (!this.botConfig.ownerIds[0]) {
      throw new Error(`No owner ID configured`);
    }
  }

  async onReply(message: ITelegramMessage): Promise<void> {
    const pendingBotMessageIndex = this.pendingMessages.findIndex(pendingMessage => {
      return pendingMessage.chatId === message.reply_to_message.chat.id
        && pendingMessage.messageId === message.reply_to_message.message_id;
    });
    if (pendingBotMessageIndex === -1) {
      return;
    }
    const pendingBotMessage = this.pendingMessages[pendingBotMessageIndex];

    if (pendingBotMessage.type === PendingMessageType.askForCode) {
      this.events.emit(PendingMessageType.askForCode, message.text);

      this.pendingMessages.splice(pendingBotMessageIndex, 1);
    }
  }

  async askForCode(): Promise<void> {
    this.logger.debug(`Asking for code...`);

    const text = new BotMessageText(`Отправьте код в ответ на это сообщение`);
    const response = await this.sendMessage(this.botConfig.ownerIds[0], text);
    this.logger.debug(response);
    this.pendingMessages.push({
      type: PendingMessageType.askForCode,
      chatId: response[0].chat.id,
      messageId: response[0].message_id,
    });

    this.logger.debug(`Asking for code finished`);
  }

  async sendMessageToAllGroups(
    text: BotMessageText,
  ): Promise<void> {
    for (const group of this.botConfig.groups) {
      await this.sendMessage(group.id, text, { messageThreadId: group.threadId });
    }
  }

  async sendMessageToOwner(
    text: BotMessageText,
  ): Promise<void> {
    const ownerId = this.botConfig.ownerIds[0];
    await this.sendMessage(ownerId, text);
  }

  private async sendMessage(
    chatId: string | number,
    text: BotMessageText,
    options: {
      messageThreadId?: number,
      replyParameters?: ITelegramReplyParameters,
      replyMarkup?: ReplyMarkup,
    } = {},
  ): Promise<ITelegramMessage[]> {
    let textStr = this.escapeStr(text.toString());
    const payload: any = {
      chat_id: chatId,
      text: null,
    };

    payload.parse_mode = this.textParseMode;
    if (options.messageThreadId) {
      payload.message_thread_id = options.messageThreadId;
    }
    if (options.replyParameters) {
      payload.reply_parameters = options.replyParameters;
    }
    if (options.replyMarkup) {
      payload.reply_markup = options.replyMarkup;
    }

    const sentMessages: ITelegramMessage[] = [];
    while (textStr) {
      payload.text = textStr.slice(0, this.maxMessageTextSize);
      textStr = textStr.slice(this.maxMessageTextSize);

      const sentMessage = await this.execMethod<ITelegramMessage>(ApiMethodName.SendMessage, payload);
      sentMessages.push(sentMessage);
    }

    this.persistSentMessages(sentMessages).then();

    return sentMessages;
  }

  private async setWebhook(): Promise<void> {
    const websiteOrigin = `https://64b5-193-194-107-76.ngrok-free.app`;
    // const websiteOrigin = `https://klondike.com.ua`;

    const webhookUrl = `${websiteOrigin}/api/v1/bot/tg-webhook`;
    const payload = {
      url: webhookUrl,
    };

    try {
      await this.execMethod(ApiMethodName.SetWebhook, payload);

      this.logger.log(`Successfully set webhook: ${webhookUrl}`);
    } catch (e) {
      this.logger.error(`Could not set webhook:`);
      this.logger.error(e);
    }
  }

  private async execMethod<T = any>(methodName: ApiMethodName, data: any): Promise<T> {
    const url = `${this.apiHost}/bot${this.token}/${methodName}`;
    try {
      const response = await firstValueFrom(this.httpService.post<{ ok: boolean; result: T }>(url, data));
      if (response.data?.ok !== true) {
        throw response.data;
      }

      return response.data.result;
    } catch (error) {
      delete error.response?.data?.config;
      const errorNormalized = error.response?.data || error.response || error;

      if (errorNormalized.error_code === this.tooManyRequestsErrorCode) {
        const retryAfter = errorNormalized.parameters.retry_after * 1000;

        setTimeout(() => this.execMethod(methodName, data), retryAfter);
      } else {
        const { url, method } = error.config;

        const errorObj = { url, method, data, error: errorNormalized };

        this.logger.error(`Method "${methodName}" failed:`);
        this.logger.error(errorObj);
        throw errorObj;
      }
    }
  }

  private escapeStr(str: string = ''): string {
    return str
      .replaceAll('&', '&amp;')
      .replaceAll(/<.+?>/g, value => {
        const tagWithAttrs = value.slice(1, value.length - 1);
        const [tagNameWithClosing] = tagWithAttrs.split(' ');
        const isClosingTag = tagNameWithClosing.startsWith('/');
        const tagName = isClosingTag ? tagNameWithClosing.slice(1) : tagNameWithClosing;

        if (this.supportedTags.includes(tagName)) {
          return value;
        } else {
          return `&lt;${tagWithAttrs}&gt;`;
        }
      });
  }

  private async ensureAndCacheConfig(): Promise<void> {
    try {
      this.logger.debug(`Caching config...`);

      this.botConfig = await this.botConfigModel.findOne().exec();

      if (!this.botConfig) {
        this.logger.debug(`Did not found bot config, creating new...`);

        this.botConfig = new BotConfig();
        await this.botConfigModel.create(this.botConfig);
      }

      this.logger.debug(`Caching config finished:`);
      this.logger.debug(this.botConfig);
    } catch (e) {
      this.logger.error(`Could not cache config:`);
      this.logger.error(e);
    }
  }

  private async persistSentMessages(sentMessages: ITelegramMessage[]): Promise<void> {
    for (const sentMessage of sentMessages) {
      try {
        await this.botSentMessageModel.create({
          messageId: sentMessage.message_id,
          chatId: sentMessage.chat.id,
          messageThreadId: sentMessage.message_thread_id,
          text: sentMessage.text,
          sentAtIso: new Date(sentMessage.date * 1000).toISOString(),
        });
      } catch (e) {
        this.logger.error(`Could not persist sent message:`);
        this.logger.error(e);
      }
    }
  }
}
