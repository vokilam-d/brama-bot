import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { HttpService } from '@nestjs/axios';
import { BotConfig } from '../schemas/bot-config.schema';
import { config } from '../../../config';
import { firstValueFrom } from 'rxjs';
import { BotMessageText } from '../helpers/bot-message-text.helper';
import { ITelegramReplyParameters } from '../interfaces/telegram-reply-parameters.interface';
import { ITelegramInlineKeyboardMarkup } from '../interfaces/inline-keyboard-markup.interface';
import { ITelegramReplyKeyboardMarkup } from '../interfaces/reply-keyboard-markup.interface';
import { ITelegramReplyKeyboardRemove } from '../interfaces/reply-keyboard-remove.interface';
import { ITelegramMessage } from '../interfaces/message.interface';
import { EventEmitter } from 'events';
import { BotSentMessage } from '../schemas/bot-sent-message.schema';
import { BotIncomingMessage } from '../schemas/bot-incoming-message.schema';
import { ITelegramUpdate } from '../interfaces/telegram-update.interface';

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

enum BotCommand {
  Enable = '/enable',
  Disable = '/disable',
  Status = '/status',
  SetGroupStatus = '/set_group_status',
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
  private readonly supportedTags: string[] = ['b', 'i', 'a', 'pre', 'code', 'blockquote'];

  constructor(
    @InjectModel(BotConfig.name) private botConfigModel: Model<BotConfig>,
    @InjectModel(BotSentMessage.name) private botSentMessageModel: Model<BotSentMessage>,
    @InjectModel(BotIncomingMessage.name) private botIncomingMessageModel: Model<BotIncomingMessage>,
    private readonly httpService: HttpService,
  ) {
  }

  async onApplicationBootstrap(): Promise<void> {
    // this.setWebhook();

    await this.ensureAndCacheConfig();

    if (!this.botConfig.ownerIds[0]) {
      throw new Error(`No owner ID configured`);
    }

    // this.execMethod('deleteMessages' as any, { chat_id: -1001392103291, message_ids: [71664, 71663, 71662, 71661, 71660, 71659, 71658, 71657, 71656, 71655] })
  }

  async onNewIncomingMessage(update: ITelegramUpdate): Promise<void> {
    const senderId = update.message?.from?.id;

    if (update.message?.reply_to_message) {
      this.onReply(update.message).then();
    } else if (this.botConfig.ownerIds.includes(senderId) && update.message?.chat?.type === 'private') {
      this.onOwnerMessage(update.message).then();
    } else {
      if (update.message?.text === '/start' && update.message.chat.type === 'private') {
        const text = new BotMessageText(`Вітаю! Я бот для сповіщень від "Київ Цифровий" щодо відключень світла на вул. Юлії Здановської, 71-з.`)
          .newLine()
          .addLine(`Для отримання сповіщень, можете підписатись на канал: ${BotMessageText.link({ url: 'https://t.me/brama_kyiv_digital' }, 't.me/brama_kyiv_digital')}.`)
          .newLine()
          .addLine(`Або якщо Ви бажаєте отримувати сповіщення у власній групі, будь ласка, зверніться до адміністратора бота ${BotMessageText.link({ userId: this.botConfig.ownerIds[0] }, '@vokilam')}`);

        await this.sendMessage(
          update.message.chat.id,
          text,
        );
      }

      // Notify about every incoming message
      if (update.message?.new_chat_members) {
        return;
      }

      const message = update.message || update;
      try {
        await this.botIncomingMessageModel.create({ message });

        await this.sendMessageToOwner(new BotMessageText(BotMessageText.code(JSON.stringify(message), 'json')));
      } catch (e) {
        this.logger.error(`Creating incoming message: Failed:`);
        this.logger.error(e);
      }
    }
  }

  private async onOwnerMessage(message: ITelegramMessage): Promise<void> {
    this.logger.debug(`Handling owner message... (message=${message.text})`);
    const chatId = message.chat.id;

    try {
      const [command, ...args] = message.text.split(' ');
      switch (command) {
        case BotCommand.Enable:
          await this.updateConfig('isEnabled', true);
          await this.likeMessage(chatId, message.message_id);
          await this.sendMessage(chatId, this.buildStatusText());
          break;

        case BotCommand.Disable:
          await this.updateConfig('isEnabled', false);
          await this.likeMessage(chatId, message.message_id);
          await this.sendMessage(chatId, this.buildStatusText());
          break;

        case BotCommand.Status:
          await this.sendMessage(chatId, this.buildStatusText());
          break;

        case BotCommand.SetGroupStatus:
          const groupId = parseInt(args[0]);
          const status = args[1];

          const groupIndex = this.botConfig.groups.findIndex(group => group.id === groupId);
          if (groupIndex === -1) {
            await this.sendMessage(chatId, new BotMessageText(`Group not found (id=${groupId})`));
            return;
          }

          if (status !== 'enabled' && status !== 'disabled') {
            await this.sendMessage(chatId, new BotMessageText(`Invalid status: ${status}`));
            return;
          }

          this.botConfig.groups[groupIndex].isEnabled = status === 'enabled';

          await this.updateConfig('groups', this.botConfig.groups);
          await this.likeMessage(chatId, message.message_id);
          await this.sendMessage(chatId, this.buildStatusText());
          break;

        default:
          return;
      }

      this.logger.debug(`Handling owner message: Finished`);
    } catch (e) {
      this.logger.error(`Handling owner message: Failed:`);
      this.logger.error(e);
      this.sendMessageToOwner(new BotMessageText(`Failed to handle owner message (message=${message.text}): ${e.message}`)).then();
    }
  }

  private async onReply(message: ITelegramMessage): Promise<void> {
    this.logger.debug(`Handling reply... (message=${message.text})`);

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

  async sendMessageToAllEnabledGroups(
    text: BotMessageText,
  ): Promise<void> {
    this.logger.debug(`Sending message to all enabled groups... (text=${text.toString()})`);
    if (!this.botConfig.isEnabled) {
      this.logger.debug(`Sending message to all enabled groups: Exiting, bot is disabled`);
      return;
    }

    for (const group of this.botConfig.groups) {
      if (!group.isEnabled) {
        this.logger.debug(`Sending message to all enabled groups: Skipping disabled group (id=${group.id}, comment=${group.comment})`);
        continue;
      }

      try {
        await this.sendMessage(group.id, text, { messageThreadId: group.threadId });
      } catch (e) {
        const message = `Could not send message to group`;
        this.logger.error(message);
        this.logger.error({ group });
        this.logger.error(e, e.stack);
        this.sendMessageToOwner(new BotMessageText(message)).then();
      }
    }

    this.logger.debug(`Sending message to all enabled groups: Finished`);
  }

  async sendMessageToOwner(
    text: BotMessageText,
  ): Promise<void> {
    try {
      const ownerId = this.botConfig.ownerIds[0];

      if (config.appEnv !== 'production') {
        text
          .newLine()
          .newLine()
          .addLine(BotMessageText.quote(`env=${config.appEnv}`));
      }

      await this.sendMessage(ownerId, text);
    } catch (e) {
      this.logger.error(`Could not send message to owner:`);
      this.logger.error(e, e.stack);
    }
  }

  likeMessage(chatId: number, messageId: number): Promise<boolean> {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    };

    return this.execMethod(ApiMethodName.SetMessageReaction, payload);
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

    const webhookUrl = `${websiteOrigin}/brama-bot/api/v1/bot/tg-webhook`;
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

    this.logger.debug(`Executing method:...`);
    this.logger.debug({ url, data });

    try {
      const response = await firstValueFrom(this.httpService.post<{ ok: boolean; result: T }>(url, data));
      if (response.data?.ok !== true) {
        throw response.data;
      }

      this.logger.debug(`Executing method finished`);
      if (!response.data.result) {
        this.logger.warn({ 'response.data': response.data });
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

      const appEnvKey: keyof BotConfig = 'appEnv';
      const configDoc = await this.botConfigModel.findOne({ [appEnvKey]: config.appEnv }).exec();
      this.botConfig = configDoc?.toJSON();

      if (!this.botConfig) {
        this.logger.debug(`Did not find bot config, creating new...`);

        this.botConfig = new BotConfig();
        await this.botConfigModel.create(this.botConfig);
      }

      this.logger.debug(`Caching config: Finished`);
      this.logger.debug(this.botConfig);
    } catch (e) {
      this.logger.error(`Caching config: Failed:`);
      this.logger.error(e);
    }
  }

  private async persistSentMessages(sentMessages: ITelegramMessage[]): Promise<void> {
    for (const sentMessage of sentMessages) {
      if (!sentMessage) {
        const message = `No sent message to persist`;
        this.logger.error(message);
        this.sendMessageToOwner(new BotMessageText(message)).then();
        continue;
      }

      try {
        const sentMessageDocContents: BotSentMessage = {
          messageId: sentMessage.message_id,
          chatId: sentMessage.chat.id,
          messageThreadId: sentMessage.message_thread_id,
          text: sentMessage.text,
          sentAtIso: new Date(sentMessage.date * 1000).toISOString(),
        };

        await this.botSentMessageModel.create(sentMessageDocContents);

        this.logger.debug(`Persisted sent message:`);
        this.logger.debug(sentMessageDocContents);
      } catch (e) {
        this.logger.error(`Could not persist sent message:`);
        this.logger.error(e);
      }
    }
  }

  private async updateConfig<K extends keyof BotConfig>(key: K, value: BotConfig[K]): Promise<void> {
    this.logger.debug(`Updating config... (${key}=${value})`);

    this.botConfig[key] = value;

    try {
      const appEnvKey: keyof BotConfig = 'appEnv';
      await this.botConfigModel.findOneAndUpdate(
        { [appEnvKey]: config.appEnv },
        { $set: { [key]: value } },
      );

      this.logger.debug(`Updating config: Finished`);
      this.logger.debug(this.botConfig);
    } catch (e) {
      this.logger.error(`Updating config: Failed:`);
      this.logger.error(e);
      this.sendMessageToOwner(new BotMessageText(`Failed to update config: ${e.message}`)).then();
    }
  }

  private buildStatusText(): BotMessageText {
    const text = new BotMessageText(`Status: ${BotMessageText.bold(this.botConfig.isEnabled ? 'enabled' : 'disabled')}`)
      .newLine();

    text.addLine(`Owner IDs: ${this.botConfig.ownerIds.map(id => BotMessageText.bold(id)).join(', ')}`)
      .newLine();

    text.addLine(`Groups:`)
    for (let i = 0; i < this.botConfig.groups.length; i++) {
      const group = this.botConfig.groups[i];
      const status = group.isEnabled ? 'enabled' : 'disabled';
      const threadId = group.threadId ? ` (threadId=${group.threadId})` : '';
      text.addLine(` ${i + 1}. ${BotMessageText.bold(group.id)}${threadId} - ${BotMessageText.bold(status)}: "${group.comment}"`);
    }

    return text;
  }
}
