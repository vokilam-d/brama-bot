import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { YasnoScheduleService } from './services/yasno-schedule.service';
import { PowerScheduleModule } from '../power-schedule/power-schedule.module';
import { BotModule } from '../bot/bot.module';

@Module({
  imports: [
    HttpModule,
    PowerScheduleModule,
    BotModule,
  ],
  providers: [YasnoScheduleService],
  exports: [YasnoScheduleService],
})
export class YasnoModule {}
