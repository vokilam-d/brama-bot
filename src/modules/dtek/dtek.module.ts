import { Module } from '@nestjs/common';
import { DtekScheduleService } from './services/dtek-schedule.service';
import { PowerScheduleModule } from '../power-schedule/power-schedule.module';
import { BotModule } from '../bot/bot.module';
import { PuppeteerModule } from '../puppeteer/puppeteer.module';

@Module({
  imports: [PowerScheduleModule, BotModule, PuppeteerModule],
  providers: [DtekScheduleService],
  exports: [DtekScheduleService],
})
export class DtekModule {}
