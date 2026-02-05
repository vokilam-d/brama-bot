import { Body, Controller, Post } from '@nestjs/common';
import { ITelegramUpdate } from '../interfaces/telegram-update.interface';
import { BotService } from '../services/bot.service';

@Controller('bot')
export class BotController {

  constructor(private readonly botService: BotService) {}

  @Post('tg-webhook')
  async tgWebhook(@Body() update: ITelegramUpdate): Promise<void> {
    this.botService.onNewTelegramUpdate(update).then();
  }
}
