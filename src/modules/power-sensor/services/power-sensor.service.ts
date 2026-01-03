import { Injectable, Logger } from '@nestjs/common';
import { BotService } from '../../bot/services/bot.service';
import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';
import { PowerSensorDto } from '../dto/power-sensor.dto';

@Injectable()
export class PowerSensorService {
  private readonly logger = new Logger(PowerSensorService.name);

  constructor(private readonly botService: BotService) {}

  async onPowerSensorMessage(dto: PowerSensorDto): Promise<void> {
    this.logger.debug(`Received power sensor message: ${JSON.stringify(dto)}`);
    
    try {
      const messageText = new BotMessageText(BotMessageText.bold('Power Sensor Update'))
        .newLine()
        .addLine(BotMessageText.code(JSON.stringify(dto, null, 2), 'json'));

      await this.botService.sendMessageToOwner(messageText);
    } catch (error) {
      const message = `Failed to process power sensor message: ${error}`;
      this.logger.error(message);
      this.botService.sendMessageToOwner(new BotMessageText(message)).then();
    }
  }
}
