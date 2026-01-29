import { Module } from '@nestjs/common';
import { KdService } from './services/kd.service';
import { KdController } from './controllers/kd.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { KdConfig, KdConfigSchema } from './schemas/kd-config.schema';
import { HttpModule } from '@nestjs/axios';
import { BotModule } from '../bot/bot.module';
import { PowerScheduleModule } from '../power-schedule/power-schedule.module';
import { KdProcessedFeedItem, KdProcessedFeedItemSchema } from './schemas/kd-processed-feed-item.schema';
import { KdProcessedScheduleInfo, KdProcessedScheduleInfoSchema } from './schemas/kd-processed-schedule-info.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: KdConfig.name, schema: KdConfigSchema, collection: 'kyiv-digital-config' },
      { name: KdProcessedFeedItem.name, schema: KdProcessedFeedItemSchema, collection: 'kd-processed-feed-item' },
      { name: KdProcessedScheduleInfo.name, schema: KdProcessedScheduleInfoSchema, collection: KdProcessedScheduleInfo.collectionName },
    ]),
    HttpModule,
    BotModule,
    PowerScheduleModule,
  ],
  providers: [KdService],
  controllers: [KdController]
})
export class KdModule {}
