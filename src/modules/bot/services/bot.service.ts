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
  DeleteMessages = 'deleteMessages',
}

export enum PendingMessageType {
  AskForCode = 'askForCode',
  GetSchedule = 'getSchedule',
  SendScheduleToAll = 'sendScheduleToAll',
  EshopSubscribe = 'eshopSubscribe',
  EshopUnsubscribe = 'eshopUnsubscribe',
  EshopGetInfo = 'eshopGetInfo',
}

enum AdminBotCommand {
  Enable = '/enable',
  Disable = '/disable',
  Status = '/status',
  SetGroupStatus = '/set_group_status',
  SendScheduleTodayToAll = '/send_schedule_today_to_all',
  SendScheduleTomorrowToAll = '/send_schedule_tomorrow_to_all',
  GetScheduleToday = '/get_schedule_today',
  GetScheduleTomorrow = '/get_schedule_tomorrow',
  GetCommands = '/get_commands',
  DeleteMessages = '/del',
  EshopSubscribe = '/eshop_subscribe',
  EshopUnsubscribe = '/eshop_unsubscribe',
  EshopGetInfo = '/eshop_info',
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

    // const text = `🗓 <b>Новий графік на сьогодні</b>\n\nСвітло буде відсутнє:\nз 06:00 до 12:30\nз 15:30 до 20:00`
    // this.execMethod('editMessageText' as any, { chat_id: -1002164849966, message_id: 378, text: text, parse_mode: 'HTML' });
  }

  async onNewIncomingMessage(update: ITelegramUpdate): Promise<void> {
    const senderId = update.message?.from?.id;

    if (update.message?.reply_to_message) {
      this.onReply(update.message).then();
    } else if (this.botConfig.ownerIds.includes(senderId) && update.message?.chat?.type === 'private') {
      this.onOwnerPrivateMessage(update.message).then();

    } else if (this.botConfig.ownerIds.includes(senderId) && update.message?.text === AdminBotCommand.EshopSubscribe) {
      this.logger.debug(`Received eshop subscribe command from owner (chatId=${update.message.chat.id})`);
      await this.updateConfig('eshopChatId', update.message.chat.id);
      await this.likeMessage(update.message.chat.id, update.message.message_id);

    } else if (this.botConfig.ownerIds.includes(senderId) && update.message?.text === AdminBotCommand.EshopUnsubscribe) {
      this.logger.debug(`Received eshop unsubscribe command from owner (chatId=${update.message.chat.id})`);
      await this.updateConfig('eshopChatId', null);
      await this.likeMessage(update.message.chat.id, update.message.message_id);

    } if (update.message.chat.id === this.botConfig.eshopChatId && update.message?.text === AdminBotCommand.EshopGetInfo) {
      this.logger.debug(`Received eshop get info command from eshop chat (chatId=${update.message.chat.id})`);
      this.execMethod(ApiMethodName.SendChatAction, { chat_id: update.message.chat.id, action: 'typing' });
      this.events.emit(PendingMessageType.EshopGetInfo);

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

  private async onOwnerPrivateMessage(message: ITelegramMessage): Promise<void> {
    this.logger.debug(`Handling owner message... (message=${message.text})`);
    if (!message.text) {
      this.logger.debug(`Handling owner message: Exiting, no text`);
      return;
    }
    
    const chatId = message.chat.id;

    try {
      const [command, ...args] = message.text.split(' ');
      switch (command) {
        case AdminBotCommand.Enable:
          await this.updateConfig('isEnabled', true);
          await this.likeMessage(chatId, message.message_id);
          break;

        case AdminBotCommand.Disable:
          await this.updateConfig('isEnabled', false);
          await this.likeMessage(chatId, message.message_id);
          break;

        case AdminBotCommand.Status:
          await this.sendMessage(chatId, this.buildStatusText());
          break;

        case AdminBotCommand.SetGroupStatus:
          const groupId = parseInt(args[0]);
          const status = args[1];

          const groupIndex = this.botConfig.groups.findIndex(group => group.id === groupId);
          if (groupIndex === -1) {
            await this.sendMessage(chatId, new BotMessageText(`Group not found (id=${groupId})`));
            return;
          }

          if (status !== 'enabled' && status !== 'disabled') {
            await this.sendMessage(chatId, new BotMessageText(`Invalid status: ${status}. Valid statuses: enabled, disabled`));
            return;
          }

          this.botConfig.groups[groupIndex].isEnabled = status === 'enabled';

          await this.updateConfig('groups', this.botConfig.groups);
          await this.likeMessage(chatId, message.message_id);
          await this.sendMessage(chatId, this.buildStatusText());
          break;

        case AdminBotCommand.GetScheduleToday: {
          this.events.emit(PendingMessageType.GetSchedule, { day: 'today', chatId });
          break;
        }

        case AdminBotCommand.GetScheduleTomorrow: {
          this.events.emit(PendingMessageType.GetSchedule, { day: 'tomorrow', chatId });
          break;
        }

        case AdminBotCommand.SendScheduleTodayToAll: {
          this.events.emit(PendingMessageType.SendScheduleToAll, { day: 'today' });
          await this.likeMessage(chatId, message.message_id);
          break;
        }

        case AdminBotCommand.SendScheduleTomorrowToAll: {
          this.events.emit(PendingMessageType.SendScheduleToAll, { day: 'tomorrow' });
          await this.likeMessage(chatId, message.message_id);
          break;
        }

        case AdminBotCommand.GetCommands: {
          const commandsText = new BotMessageText(BotMessageText.bold(`Commands:`));
          for (const command of Object.values(AdminBotCommand)) {
            commandsText.newLine().addLine(command);
          }
          await this.sendMessage(chatId, commandsText);
          break;
        }

        case AdminBotCommand.DeleteMessages: {
          const messageLinks = args;
          if (!messageLinks.length) {
            await this.sendMessage(chatId, new BotMessageText(`No message links provided, usage: /del <message link 1> <message link 2> ...`));
            return;
          }

          const messageIdsByChatId = new Map<string, number[]>();
          
          for (const messageLink of messageLinks) {
            const pathParts = messageLink.replace('https://t.me/', '').split('/');
            if (pathParts.length < 2) {
              await this.sendMessage(
                chatId,
                new BotMessageText(`Invalid message link format: ${messageLink}`),
              );
              continue;
            }

            let deletedMessageChatId: string;
            let deletedMessageId: number;

            if (pathParts[0] === 'c') {
              deletedMessageChatId = `-100${pathParts[1]}`;
              deletedMessageId = parseInt(pathParts[3] ?? pathParts[2]);
            } else {
              deletedMessageChatId = `@${pathParts[0]}`;
              deletedMessageId = parseInt(pathParts[1]);
            }

            if (!messageIdsByChatId.has(deletedMessageChatId)) {
              messageIdsByChatId.set(deletedMessageChatId, []);
            }
            messageIdsByChatId.get(deletedMessageChatId).push(deletedMessageId);
          }

          let totalDeleted = 0;
          for (const [deletedMessageChatId, messageIds] of messageIdsByChatId.entries()) {
            await this.execMethod(
              ApiMethodName.DeleteMessages,
              { chat_id: deletedMessageChatId, message_ids: messageIds },
            );
            totalDeleted += messageIds.length;
          }

          await this.sendMessage(chatId, new BotMessageText(`Deleted ${totalDeleted} messages`));
          break;
        }

        default:
          return;
      }

      this.logger.debug(`Handling owner message: Finished`);
    } catch (e) {
      this.logger.error(`Handling owner message: Failed:`);
      this.logger.error(e);
      const errorMessage = e.error?.description || e.message || e.toString?.() || JSON.stringify(e);
      this.sendMessageToOwner(new BotMessageText(`Failed to handle owner message (message=${message.text}): ${errorMessage}`)).then();
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

    if (pendingBotMessage.type === PendingMessageType.AskForCode) {
      this.events.emit(PendingMessageType.AskForCode, message.text);

      this.pendingMessages.splice(pendingBotMessageIndex, 1);
    }
  }

  async askForCode(): Promise<void> {
    this.logger.debug(`Asking for code...`);

    const text = new BotMessageText(`Отправьте код в ответ на это сообщение`);
    const response = await this.sendMessage(this.botConfig.ownerIds[0], text);
    this.logger.debug(response);
    this.pendingMessages.push({
      type: PendingMessageType.AskForCode,
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
      this.sendMessageToOwner(new BotMessageText(`Tried to send message to all enabled groups, but bot is disabled (text=${text.toString()})`)).then();
      this.logger.warn(`Sending message to all enabled groups: Exiting, bot is disabled`);
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

  async sendMessageToEshop(
    text: BotMessageText,
  ): Promise<void> {
    this.logger.debug(`Sending message to eshop... (text=${text.toString()})`);
    if (!this.botConfig.eshopChatId) {
      this.logger.warn(`Sending message to eshop: Exiting, no eshop chat ID configured`);
      return;
    }

    try {
      await this.sendMessage(this.botConfig.eshopChatId, text);
    } catch (e) {
      this.logger.error(`Could not send message to eshop:`);
      this.logger.error(e);
    }

    this.logger.debug(`Sending message to eshop: Finished`);
  }

  async sendPhotoToEshop(
    photoUrl: string,
    text: BotMessageText,
  ): Promise<void> {
    this.logger.debug(`Sending photo to eshop... (photoUrl=${photoUrl}, text=${text.toString()})`);
    if (!this.botConfig.eshopChatId) {
      this.logger.warn(`Sending photo to eshop: Exiting, no eshop chat ID configured`);
      return;
    }

    try {
      await this.execMethod(ApiMethodName.SendPhoto, {
        chat_id: this.botConfig.eshopChatId,
        photo: photoUrl,
        caption: text.toString(),
        parse_mode: this.textParseMode,
      });
    } catch (e) {
      this.logger.error(`Could not send photo to eshop:`);
      this.logger.error(e);
    }

    this.logger.debug(`Sending photo to eshop: Finished`);
  }

  async sendMessage(
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

        this.logger.debug(`Persisted sent message: ${JSON.stringify(sentMessageDocContents)}`);
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
