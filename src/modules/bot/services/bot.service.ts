import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CONFIG } from '../../../config';
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
import { ITelegramCallbackQuery } from '../interfaces/telegram-callback-query.interface';
import { ITelegramInlineKeyboardButton } from '../interfaces/inline-keyboard-button.interface';
import {
  TelegramApiService,
  ApiMethodName,
} from './telegram-api.service';
import { BotConfigService } from './bot-config.service';
import { PowerScheduleConfigService } from '../../power-schedule/services/power-schedule-config.service';
import { PowerScheduleProviderId } from '../../power-schedule/interfaces/schedule.interface';

export type ReplyMarkup = ITelegramInlineKeyboardMarkup | ITelegramReplyKeyboardMarkup | ITelegramReplyKeyboardRemove;

export enum PendingMessageType {
  AskForCode = 'askForCode',
  GetSchedule = 'getSchedule',
  SendScheduleToAll = 'sendScheduleToAll',
  EshopSubscribe = 'eshopSubscribe',
  EshopUnsubscribe = 'eshopUnsubscribe',
  EshopGetInfo = 'eshopGetInfo',
  GetPowerStatus = 'getPowerStatus',
}

enum AdminBotCommand {
  GroupsSettings = '/groups_settings',
  SendScheduleTodayToAll = '/send_schedule_today_to_all',
  SendScheduleTomorrowToAll = '/send_schedule_tomorrow_to_all',
  GetScheduleToday = '/get_schedule_today',
  GetScheduleTomorrow = '/get_schedule_tomorrow',
  GetCommands = '/get_commands',
  DeleteMessages = '/del',
  EshopSubscribe = '/eshop_subscribe',
  EshopUnsubscribe = '/eshop_unsubscribe',
  EshopGetInfo = '/eshop_info',
  PowerStatusGroup = '/power_status_group',
  GetPowerStatus = '/get_power_status',
  ScheduleSettings = '/schedule_settings',
}

@Injectable()
export class BotService implements OnApplicationBootstrap {

  events = new EventEmitter();

  private readonly logger = new Logger(BotService.name);

  private pendingMessages: { type: PendingMessageType, chatId: number, messageId: number, }[] = [];

  private readonly maxMessageTextSize = 4000;
  private readonly textParseMode = 'HTML';
  private readonly supportedTags: string[] = ['b', 'i', 'a', 'pre', 'code', 'blockquote'];

  constructor(
    @InjectModel(BotSentMessage.name) private botSentMessageModel: Model<BotSentMessage>,
    @InjectModel(BotIncomingMessage.name) private botIncomingMessageModel: Model<BotIncomingMessage>,
    private readonly telegramApiService: TelegramApiService,
    private readonly botConfigService: BotConfigService,
    private readonly powerScheduleConfigService: PowerScheduleConfigService,
  ) {
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.botConfigService.whenReady();

    // this.setWebhook();

    const botConfig = this.botConfigService.getConfig();
    if (!botConfig.ownerIds[0]) {
      throw new Error(`No owner ID configured`);
    }

    // const text = `🗓 <b>Новий графік на сьогодні</b>\n\nСвітло буде відсутнє:\nз 06:00 до 12:30\nз 15:30 до 20:00`
    // this.telegramApiService.execMethod('editMessageText' as any, { chat_id: -0, message_id: 378, text: text, parse_mode: 'HTML' });
  }

  async onNewTelegramUpdate(update: ITelegramUpdate): Promise<void> {
    const callbackQuery = update.callback_query;
    if (callbackQuery) {
      await this.onNewTelegramCallbackQuery(callbackQuery);
    }

    const message = update.message;
    if (message) {
      await this.onNewTelegramMessage(message);
    }

    await this.persistAndForwardIncomingUpdate(update);
  }

  private async onNewTelegramCallbackQuery(callbackQuery: ITelegramCallbackQuery): Promise<void> {
    const botConfig = this.botConfigService.getConfig();
    const isOwner = botConfig.ownerIds.includes(callbackQuery.from.id);
    if (isOwner && callbackQuery.data?.startsWith('schedule_')) {
      await this.onScheduleSettingsCallback(callbackQuery);
    }
    if (isOwner && callbackQuery.data?.startsWith('group_')) {
      await this.onGroupSettingsCallback(callbackQuery);
    }
  }

  private async onNewTelegramMessage(message: ITelegramMessage): Promise<void> {
    const senderId = message.from?.id;
    const botConfig = this.botConfigService.getConfig();
    const isOwnerMessage = botConfig.ownerIds.includes(senderId);
    const isPrivateChat = message.chat.type === 'private';

    if (message.reply_to_message) {
      await this.onReply(message);
    }

    const isOwnerPrivateChat = isOwnerMessage && isPrivateChat;
    if (isOwnerPrivateChat) {
      this.onOwnerPrivateMessage(message);
    }

    const isEshopSubscribeCommand = isOwnerMessage && message.text === AdminBotCommand.EshopSubscribe;
    if (isEshopSubscribeCommand) {
      await this.onOwnerEshopSubscribe(message);
    }

    const isEshopUnsubscribeCommand = isOwnerMessage && message.text === AdminBotCommand.EshopUnsubscribe;
    if (isEshopUnsubscribeCommand) {
      await this.onOwnerEshopUnsubscribe(message);
    }

    const isEshopGetInfoCommand = message
      && message.chat.id === botConfig.eshopChatId
      && message.text === AdminBotCommand.EshopGetInfo;
    if (isEshopGetInfoCommand) {
      this.onEshopGetInfo(message);
    }

    const isGetPowerStatusCommand = message
      && message.chat.id === botConfig.powerStatusGroupId
      && message.text === AdminBotCommand.GetPowerStatus;
    if (isGetPowerStatusCommand) {
      this.onGetPowerStatus(message);
    }

    const isPowerStatusGroupCommand = isOwnerMessage && message.text === AdminBotCommand.PowerStatusGroup;
    if (isPowerStatusGroupCommand) {
      await this.onOwnerSetPowerStatusGroup(message);
    }

    const isStartCommand = message && isPrivateChat && message.text === '/start';
    if (isStartCommand) {
      await this.sendStartMessage(message);
    }
  }

  private async onOwnerEshopSubscribe(message: ITelegramMessage): Promise<void> {
    this.logger.debug(`Received eshop subscribe command from owner (chatId=${message.chat.id})`);
    try {
      await this.botConfigService.updateConfig('eshopChatId', message.chat.id);
      await this.likeMessage(message.chat.id, message.message_id);
    } catch (e) {
      const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
      await this.sendMessageToOwner(new BotMessageText(`Failed to update eshop chat ID: ${errorMessage}`));
    }
  }

  private async onOwnerEshopUnsubscribe(message: ITelegramMessage): Promise<void> {
    this.logger.debug(`Received eshop unsubscribe command from owner (chatId=${message.chat.id})`);
    try {
      await this.botConfigService.updateConfig('eshopChatId', null);
      await this.likeMessage(message.chat.id, message.message_id);
    } catch (e) {
      const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
      await this.sendMessageToOwner(new BotMessageText(`Failed to update eshop chat ID: ${errorMessage}`));
    }
  }

  private onEshopGetInfo(message: ITelegramMessage): void {
    this.logger.debug(`Received eshop get info command from eshop chat (chatId=${message.chat.id})`);
    this.telegramApiService.execMethod(
      ApiMethodName.SendChatAction,
      { chat_id: message.chat.id, action: 'typing' },
    ).catch(() => {});
    this.events.emit(PendingMessageType.EshopGetInfo);
  }

  private onGetPowerStatus(message: ITelegramMessage): void {
    this.logger.debug(`Received get power status command from power status group (chatId=${message.chat.id})`);
    this.telegramApiService.execMethod(
      ApiMethodName.SendChatAction,
      { chat_id: message.chat.id, action: 'typing' },
    ).catch(() => {});

    const replyParameters: ITelegramReplyParameters = {
      message_id: message.message_id,
    };

    this.events.emit(PendingMessageType.GetPowerStatus, { replyParameters });
  }

  private async onOwnerSetPowerStatusGroup(message: ITelegramMessage): Promise<void> {
    this.logger.debug(`Received power status group command from owner (chatId=${message.chat.id})`);
    try {
      await this.botConfigService.updateConfig('powerStatusGroupId', message.chat.id);
      await this.likeMessage(message.chat.id, message.message_id);
    } catch (e) {
      const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
      await this.sendMessageToOwner(new BotMessageText(`Failed to update power status group ID: ${errorMessage}`));
    }
  }

  private async sendStartMessage(message: ITelegramMessage): Promise<void> {
    const botConfig = this.botConfigService.getConfig();
    const channelLink = BotMessageText.link(
      { url: 'https://t.me/brama_kyiv_digital' },
      't.me/brama_kyiv_digital',
    );
    const ownerLink = BotMessageText.link(
      { userId: botConfig.ownerIds[0] },
      '@vokilam',
    );
    const text = new BotMessageText(`Вітаю! Я неофіційний бот для сповіщень від "Київ Цифровий" щодо відключень світла у ЖК "Сонячна Брама".`)
      .newLine()
      .addLine(`Для отримання сповіщень, можете підписатись на канал: ${channelLink}.`)
      .newLine()
      .addLine(`Або якщо Ви бажаєте отримувати сповіщення у власній групі, будь ласка, зверніться до адміністратора бота ${ownerLink}`);

    await this.sendMessage(message.chat.id, text);
  }

  private async persistAndForwardIncomingUpdate(update: ITelegramUpdate): Promise<void> {
    const botConfig = this.botConfigService.getConfig();
    const isOwnerMessage = update.message && botConfig.ownerIds.includes(update.message.from?.id);
    const isOwnerCallbackQuery = update.callback_query && botConfig.ownerIds.includes(update.callback_query.from.id);
    const isPowerStatusGroupMessage = update.message?.chat.id === botConfig.powerStatusGroupId;
    const isEshopChatMessage = update.message?.chat.id === botConfig.eshopChatId;

    if (
      isOwnerMessage
      || isOwnerCallbackQuery
      || update.edited_message
      || update.message?.new_chat_members
      || isPowerStatusGroupMessage
      || isEshopChatMessage
    ) {
      return;
    }

    try {
      await this.botIncomingMessageModel.create({ message: update });
    } catch (e) {
      this.logger.error(`Creating incoming message: Failed:`);
      this.logger.error(e);
      void this.sendMessageToOwner(new BotMessageText(`Failed to create incoming message: ${e.message}`));
    }

    try {
      await this.sendMessageToOwner(
        new BotMessageText(BotMessageText.code(JSON.stringify(update, null, 2), 'json')),
      );
    } catch (e) {
      const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
      this.logger.error(`Forwarding incoming message: Failed: ${errorMessage}`);
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
        case AdminBotCommand.GroupsSettings: {
          const groupsText = this.buildGroupsSettingsText();
          const groupsKeyboard = this.buildGroupsSettingsKeyboard();
          await this.sendMessage(chatId, groupsText, { replyMarkup: groupsKeyboard });
          break;
        }

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

        case AdminBotCommand.ScheduleSettings: {
          const scheduleText = this.buildScheduleSettingsText();
          const scheduleKeyboard = this.buildScheduleSettingsKeyboard();
          await this.sendMessage(chatId, scheduleText, { replyMarkup: scheduleKeyboard });
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
            await this.telegramApiService.execMethod(
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
      const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
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

    const botConfig = this.botConfigService.getConfig();
    const text = new BotMessageText(`Отправьте код в ответ на это сообщение`);
    const response = await this.sendMessage(botConfig.ownerIds[0], text);
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
    const botConfig = this.botConfigService.getConfig();
    if (!botConfig.isEnabled) {
      this.sendMessageToOwner(new BotMessageText(`Tried to send message to all enabled groups, but bot is disabled (text=${text.toString()})`)).then();
      this.logger.warn(`Sending message to all enabled groups: Exiting, bot is disabled`);
      return;
    }

    for (const group of botConfig.groups) {
      if (!group.isEnabled) {
        this.logger.debug(`Sending message to all enabled groups: Skipping disabled group (id=${group.id}, comment=${group.comment})`);
        continue;
      }

      try {
        await this.sendMessage(group.id, text, { messageThreadId: group.threadId });
      } catch (e) {
        const message = `Failed to send message to group`;
        this.logger.error(message);
        this.logger.error(e);
        this.logger.debug({ group });

        const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
        this.sendMessageToOwner(new BotMessageText(`${message}: ${errorMessage}`)).then();
      }
    }

    this.logger.debug(`Sending message to all enabled groups: Finished`);
  }

  async sendMessageToOwner(
    text: BotMessageText,
  ): Promise<void> {
    try {
      const botConfig = this.botConfigService.getConfig();
      const ownerId = botConfig.ownerIds[0];

      if (CONFIG.appEnv !== 'production') {
        text
          .newLine()
          .newLine()
          .addLine(BotMessageText.quote(`env=${CONFIG.appEnv}`));
      }

      await this.sendMessage(ownerId, text);
    } catch (e) {
      const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
      this.logger.error(`Failed to send message to owner: ${errorMessage}`);
    }
  }

  likeMessage(chatId: number, messageId: number): Promise<boolean> {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    };

    return this.telegramApiService.execMethod(ApiMethodName.SetMessageReaction, payload);
  }

  async sendMessageToEshop(
    text: BotMessageText,
  ): Promise<void> {
    this.logger.debug(`Sending message to eshop... (text=${text.toString()})`);
    const botConfig = this.botConfigService.getConfig();
    if (!botConfig.eshopChatId) {
      this.logger.warn(`Sending message to eshop: Exiting, no eshop chat ID configured`);
      return;
    }

    try {
      await this.sendMessage(botConfig.eshopChatId, text);
    } catch (e) {
      const message = `Failed to send message to eshop`;
      this.logger.error(message);
      this.logger.error(e);

      const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
      this.sendMessageToOwner(new BotMessageText(`${message}: ${errorMessage}`)).then();
    }

    this.logger.debug(`Sending message to eshop: Finished`);
  }

  async sendMessageToPowerStatusGroup(
    text: BotMessageText,
    options: {
      replyParameters?: ITelegramReplyParameters;
      disableNotification?: boolean;
    } = {},
  ): Promise<void> {
    this.logger.debug(`Sending message to power status group... (text=${text.toString()})`);
    const botConfig = this.botConfigService.getConfig();
    if (!botConfig.powerStatusGroupId) {
      this.logger.warn(`Sending message to power status group: Exiting, no power status group chat ID configured`);
      return;
    }

    try {
      await this.sendMessage(
        botConfig.powerStatusGroupId,
        text,
        {
          replyParameters: options.replyParameters,
          disableNotification: options.disableNotification,
        },
      );
    } catch (e) {
      const message = `Failed to send message to power status group`;
      this.logger.error(message);
      this.logger.error(e);

      const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
      this.sendMessageToOwner(new BotMessageText(`${message}: ${errorMessage}`)).then();
    }

    this.logger.debug(`Sending message to power status group: Finished`);
  }

  async sendPhotoToEshop(
    photoUrl: string,
    text: BotMessageText,
  ): Promise<void> {
    this.logger.debug(`Sending photo to eshop... (photoUrl=${photoUrl}, text=${text.toString()})`);
    const botConfig = this.botConfigService.getConfig();
    if (!botConfig.eshopChatId) {
      this.logger.warn(`Sending photo to eshop: Exiting, no eshop chat ID configured`);
      return;
    }

    try {
      await this.telegramApiService.execMethod(ApiMethodName.SendPhoto, {
        chat_id: botConfig.eshopChatId,
        photo: photoUrl,
        caption: text.toString(),
        parse_mode: this.textParseMode,
      });
    } catch (e) {
      const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
      this.logger.error(`Failed to send photo to eshop: ${errorMessage}`);
      void this.sendMessageToOwner(new BotMessageText(`Failed to send photo to eshop: ${errorMessage}`));
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
      disableNotification?: boolean,
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
    if (options.disableNotification) {
      payload.disable_notification = options.disableNotification;
    }

    const sentMessages: ITelegramMessage[] = [];
    while (textStr) {
      payload.text = textStr.slice(0, this.maxMessageTextSize);
      textStr = textStr.slice(this.maxMessageTextSize);

      const sentMessage = await this.telegramApiService.execMethod<ITelegramMessage>(
        ApiMethodName.SendMessage,
        payload,
      );
      sentMessages.push(sentMessage);
    }

    this.persistSentMessages(sentMessages).then();

    return sentMessages;
  }

  private async setWebhook(): Promise<void> {
    const websiteOrigin = `https://xnmjn8h3-3500.euw.devtunnels.ms`;
    // const websiteOrigin = `https://klondike.com.ua`;

    const webhookUrl = `${websiteOrigin}/brama-bot/api/v1/bot/tg-webhook`;
    const payload = {
      url: webhookUrl,
    };

    try {
      await this.telegramApiService.execMethod(ApiMethodName.SetWebhook, payload);

      this.logger.log(`Successfully set webhook: ${webhookUrl}`);
    } catch (e) {
      this.logger.error(`Failed to set webhook:`);
      this.logger.error(e);
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
        this.logger.error(`Failed to persist sent message: ${e.message}`);
        void this.sendMessageToOwner(new BotMessageText(`Failed to persist sent message: ${e.message}`));
      }
    }
  }

  private buildScheduleSettingsText(): BotMessageText {
    const sending = this.powerScheduleConfigService.isScheduleSendingEnabled() ? 'ON' : 'OFF';
    const kd = this.powerScheduleConfigService.isProviderEnabled(PowerScheduleProviderId.Kd) ? 'ON' : 'OFF';
    const dtek = this.powerScheduleConfigService.isProviderEnabled(PowerScheduleProviderId.Dtek) ? 'ON' : 'OFF';
    const yasno = this.powerScheduleConfigService.isProviderEnabled(PowerScheduleProviderId.Yasno) ? 'ON' : 'OFF';
    return new BotMessageText(BotMessageText.bold('Графіки: Налаштування'))
      .newLine()
      .addLine(`Загальне надсилання в групи: ${sending}`)
      .addLine(`KD: ${kd} | DTEK: ${dtek} | Yasno: ${yasno}`)
      .newLine()
      .addLine('Натисніть кнопку, щоб перемкнути.');
  }

  private buildScheduleSettingsKeyboard(): ITelegramInlineKeyboardMarkup {
    const btn = (label: string, data: string): ITelegramInlineKeyboardButton => ({
      text: label,
      callback_data: data,
    });
    const sending = this.powerScheduleConfigService.isScheduleSendingEnabled() ? '✅ Загальне' : '❌ Загальне';
    const kd = this.powerScheduleConfigService.isProviderEnabled(PowerScheduleProviderId.Kd) ? '✅ KD' : '❌ KD';
    const dtek = this.powerScheduleConfigService.isProviderEnabled(PowerScheduleProviderId.Dtek) ? '✅ DTEK' : '❌ DTEK';
    const yasno = this.powerScheduleConfigService.isProviderEnabled(PowerScheduleProviderId.Yasno) ? '✅ Yasno' : '❌ Yasno';
    return {
      inline_keyboard: [
        [btn(sending, 'schedule_toggle_sending')],
        [btn(kd, 'schedule_toggle_kd'), btn(dtek, 'schedule_toggle_dtek'), btn(yasno, 'schedule_toggle_yasno')],
      ],
    };
  }

  private async onScheduleSettingsCallback(callbackQuery: ITelegramCallbackQuery): Promise<void> {
    this.logger.debug(`Schedule settings callback (data=${callbackQuery.data})`);

    const data = callbackQuery.data;
    if (!data) {
      this.logger.debug(`Schedule settings callback: Exiting, no data (data=${callbackQuery.data})`);
      return;
    }
    const providerIdByData: Record<string, PowerScheduleProviderId> = {
      schedule_toggle_kd: PowerScheduleProviderId.Kd,
      schedule_toggle_dtek: PowerScheduleProviderId.Dtek,
      schedule_toggle_yasno: PowerScheduleProviderId.Yasno,
    };
    try {
      if (data === 'schedule_toggle_sending') {
        await this.powerScheduleConfigService.toggleScheduleSendingEnabled();
      } else if (providerIdByData[data]) {
        await this.powerScheduleConfigService.toggleProviderEnabled(providerIdByData[data]);
      } else {
        this.logger.debug(`Schedule settings callback: Exiting, invalid data (data=${callbackQuery.data})`);
        return;
      }

      await this.telegramApiService.execMethod(ApiMethodName.AnswerCallbackQuery, {
        callback_query_id: callbackQuery.id,
      });
      const text = this.buildScheduleSettingsText();
      const keyboard = this.buildScheduleSettingsKeyboard();
      await this.telegramApiService.execMethod(ApiMethodName.EditMessageText, {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        text: text.toString(),
        parse_mode: this.textParseMode,
        reply_markup: keyboard,
      });

      this.logger.debug(`Schedule settings callback: Finished (data=${callbackQuery.data})`);
    } catch (e) {
      const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
      this.logger.error(`Schedule settings callback failed: ${errorMessage}`);
      await this.telegramApiService.execMethod(ApiMethodName.AnswerCallbackQuery, {
        callback_query_id: callbackQuery.id,
        text: errorMessage,
      });
    }
  }

  private buildGroupsSettingsText(): BotMessageText {
    const botConfig = this.botConfigService.getConfig();
    const botStatus = botConfig.isEnabled ? '✅' : '❌';
    const text = new BotMessageText()
      .addLine(BotMessageText.bold('Групи: Налаштування'))
      .newLine()
      .addLine(`${botStatus} Глобальна відправка: ${botConfig.isEnabled ? 'увімкнено' : 'вимкнено'}`)
      .newLine()
      .addLine(`Owner IDs: ${botConfig.ownerIds.map((id) => BotMessageText.bold(id)).join(', ')}`)
      .newLine()
      .addLine('Groups:');
    for (let i = 0; i < botConfig.groups.length; i++) {
      const group = botConfig.groups[i];
      const status = group.isEnabled ? '✅' : '❌';
      const threadId = group.threadId ? ` (threadId=${group.threadId})` : '';
      text.addLine(` ${i + 1}. ${status} ${BotMessageText.bold(group.id)}${threadId}: "${group.comment}"`);
    }
    text.newLine().addLine('Натисніть кнопку з номером, щоб перемкнути групу.');
    return text;
  }

  private buildGroupsSettingsKeyboard(): ITelegramInlineKeyboardMarkup {
    const btn = (label: string, data: string): ITelegramInlineKeyboardButton => ({
      text: label,
      callback_data: data,
    });
    const botConfig = this.botConfigService.getConfig();
    const botLabel = botConfig.isEnabled ? '✅ Глобальна відправка увімкнена' : '❌ Глобальна відправка вимкнена';
    const groupButtons = botConfig.groups.map((group, index) => {
      const status = group.isEnabled ? '✅' : '❌';
      return btn(`${status} ${index + 1}`, `group_toggle_${group.id}`);
    });
    const groupRows: ITelegramInlineKeyboardButton[][] = [];
    const buttonsInRowCount: number = 3;
    for (let i = 0; i < groupButtons.length; i += buttonsInRowCount) {
      groupRows.push(groupButtons.slice(i, i + buttonsInRowCount));
    }
    return {
      inline_keyboard: [[btn(botLabel, 'group_toggle_bot')], ...groupRows],
    };
  }

  private async onGroupSettingsCallback(callbackQuery: ITelegramCallbackQuery): Promise<void> {
    this.logger.debug(`Group settings callback (data=${callbackQuery.data})`);

    const data = callbackQuery.data;
    if (!data?.startsWith('group_toggle_')) {
      this.logger.debug(`Group settings callback: Exiting, invalid data (data=${callbackQuery.data})`);
      return;
    }

    const botConfig = this.botConfigService.getConfig();

    try {
      if (data === 'group_toggle_bot') {
        await this.botConfigService.updateConfig('isEnabled', !botConfig.isEnabled);
      } else {
        const groupId = parseInt(data.replace('group_toggle_', ''), 10);
        const groupIndex = botConfig.groups.findIndex((g) => g.id === groupId);
        if (groupIndex === -1) {
          await this.telegramApiService.execMethod(ApiMethodName.AnswerCallbackQuery, {
            callback_query_id: callbackQuery.id,
            text: 'Group not found',
          });
          return;
        }
        botConfig.groups[groupIndex].isEnabled = !botConfig.groups[groupIndex].isEnabled;
        await this.botConfigService.updateConfig('groups', botConfig.groups);
      }

      await this.telegramApiService.execMethod(ApiMethodName.AnswerCallbackQuery, {
        callback_query_id: callbackQuery.id,
      });
      const text = this.buildGroupsSettingsText();
      const keyboard = this.buildGroupsSettingsKeyboard();
      await this.telegramApiService.execMethod(ApiMethodName.EditMessageText, {
        chat_id: callbackQuery.message.chat.id,
        message_id: callbackQuery.message.message_id,
        text: text.toString(),
        parse_mode: this.textParseMode,
        reply_markup: keyboard,
      });
    } catch (e) {
      const errorMessage = e.description || e.message || e.toString?.() || JSON.stringify(e);
      this.logger.error(`Group settings callback failed: ${errorMessage}`);
      await this.telegramApiService.execMethod(ApiMethodName.AnswerCallbackQuery, {
        callback_query_id: callbackQuery.id,
        text: errorMessage,
      });
    }
  }

}
