import { Module } from '@nestjs/common';
import { DtekScheduleService } from './services/dtek-schedule.service';
import { PowerScheduleModule } from '../power-schedule/power-schedule.module';
import { BotModule } from '../bot/bot.module';

@Module({
  imports: [PowerScheduleModule, BotModule],
  providers: [DtekScheduleService],
  exports: [DtekScheduleService],
})
export class DtekModule {}
