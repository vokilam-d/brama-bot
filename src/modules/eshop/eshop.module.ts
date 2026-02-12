import { Module } from '@nestjs/common';
import { BotModule } from '../bot/bot.module';
import { PuppeteerModule } from '../puppeteer/puppeteer.module';
import { EshopService } from './services/eshop.service';

@Module({
  imports: [BotModule, PuppeteerModule],
  providers: [EshopService],
})
export class EshopModule {}