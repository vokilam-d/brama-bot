import { Module } from '@nestjs/common';
import { BotService } from './services/bot.service';
import { BotController } from './controllers/bot.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { BotConfig, BotConfigSchema } from './schemas/bot-config.schema';
import { BotSentMessage, BotSentMessageSchema } from './schemas/bot-sent-message.schema';
import { BotIncomingMessage, BotIncomingMessageSchema } from './schemas/bot-incoming-message.schema';
import { TelegramApiService } from './services/telegram-api.service';
import { BotConfigService } from './services/bot-config.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BotConfig.name, schema: BotConfigSchema, collection: 'bot-config' },
      { name: BotSentMessage.name, schema: BotSentMessageSchema, collection: 'bot-sent-messages' },
      { name: BotIncomingMessage.name, schema: BotIncomingMessageSchema, collection: 'bot-incoming-messages' },
    ]),
    HttpModule,
  ],
  providers: [BotService, TelegramApiService, BotConfigService],
  controllers: [BotController],
  exports: [BotService],
})
export class BotModule {}
