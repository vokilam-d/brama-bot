import { Module } from '@nestjs/common';
import { KdService } from './services/kd.service';
import { KdScheduleService } from './services/kd-schedule.service';
import { KdController } from './controllers/kd.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { KdConfig, KdConfigSchema } from './schemas/kd-config.schema';
import { HttpModule } from '@nestjs/axios';
import { BotModule } from '../bot/bot.module';
import { PowerScheduleModule } from '../power-schedule/power-schedule.module';
import { KdProcessedFeedItem, KdProcessedFeedItemSchema } from './schemas/kd-processed-feed-item.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: KdConfig.name, schema: KdConfigSchema, collection: 'kyiv-digital-config' },
      { name: KdProcessedFeedItem.name, schema: KdProcessedFeedItemSchema, collection: 'kd-processed-feed-item' },
    ]),
    HttpModule,
    BotModule,
    PowerScheduleModule,
  ],
  providers: [KdService, KdScheduleService],
  controllers: [KdController]
})
export class KdModule {}
