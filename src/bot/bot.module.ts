import { Module } from '@nestjs/common';
import { BotService } from './services/bot.service';
import { BotController } from './controllers/bot.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';
import { BotConfig, BotConfigSchema } from './schemas/bot-config.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: BotConfig.name, schema: BotConfigSchema, collection: 'bot-config' }]),
    HttpModule,
  ],
  providers: [BotService],
  controllers: [BotController],
  exports: [BotService],
})
export class BotModule {}
