import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BotService, PendingMessageType } from '../../bot/services/bot.service';
import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';
import { PowerSensorDto } from '../dto/power-sensor.dto';
import { PowerStatus } from '../schemas/power-status.schema';
import { ITelegramReplyParameters } from '../../bot/interfaces/telegram-reply-parameters.interface';

@Injectable()
export class PowerSensorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PowerSensorService.name);

  constructor(
    @InjectModel(PowerStatus.name) private powerStatusModel: Model<PowerStatus>,
    private readonly botService: BotService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.botService.events.on(
      PendingMessageType.GetPowerStatus,
      (options: { replyParameters: ITelegramReplyParameters }) => {
        this.sendCurrentPowerStatus(options.replyParameters).then();
      },
    );
  }

  async getCurrentPowerStatus(): Promise<PowerSensorDto> {
    const lastStatusDoc = await this.powerStatusModel.findOne().exec();

    if (!lastStatusDoc) {
      return {
        hasPower: null,
      };
    }

    const dto: PowerSensorDto = {
      hasPower: lastStatusDoc.isPowerOn,
      timestampIso: lastStatusDoc.timestamp?.toISOString(),
    };

    return dto;
  }

  async onPowerSensorMessage(dto: PowerSensorDto): Promise<void> {
    this.logger.debug(`Received power sensor message: ${JSON.stringify(dto)}`);

    try {
      const currentStatus = dto.hasPower;
      if (typeof currentStatus !== 'boolean') {
        const message = `Power status is not a boolean: "${currentStatus}"`;
        this.logger.error(message);
        this.botService.sendMessageToOwner(new BotMessageText(message)).then();
        return;
      }

      const lastStatus = await this.getCurrentPowerStatus();

      if (lastStatus.hasPower !== null && lastStatus.hasPower === currentStatus) {
        this.logger.debug(`Power status unchanged: "${currentStatus}", skipping notification`);
        return;
      }

      this.logger.log(`Power status changed: ${lastStatus.hasPower} -> ${currentStatus}, sending notification`);

      const timestamp = dto.timestampIso ? new Date(dto.timestampIso) : new Date();
      const title = currentStatus ? '🔋 Світло дали!' : '🪫 Світло вимкнули';
      const padTime = (time: number) => time.toString().padStart(2, '0');

      const messageText = new BotMessageText()
        .add(BotMessageText.bold(title))
        .add(` • ${padTime(timestamp.getHours())}:${padTime(timestamp.getMinutes())}:${padTime(timestamp.getSeconds())}`);

      await this.botService.sendMessageToPowerStatusGroup(
        messageText,
        {
          disableNotification: !currentStatus,
        },
      );

      await this.powerStatusModel.findOneAndUpdate(
        {},
        { isPowerOn: currentStatus, timestamp: timestamp },
        { upsert: true },
      );
    } catch (error) {
      const message = `Failed to process power sensor message: ${error}`;
      this.logger.error(message);
      this.botService.sendMessageToOwner(new BotMessageText(message)).then();
    }
  }

  private async sendCurrentPowerStatus(replyParameters?: ITelegramReplyParameters): Promise<void> {
    try {
      const currentStatus = await this.getCurrentPowerStatus();

      if (currentStatus.hasPower === null) {
        await this.botService.sendMessageToPowerStatusGroup(
          new BotMessageText('Немає даних'),
          { replyParameters },
        );
        return;
      }

      const padTime = (time: number) => time.toString().padStart(2, '0');
      const title = currentStatus.hasPower ? '🔋 Світло є' : '🪫 Світла немає';
      const messageText = new BotMessageText(BotMessageText.bold(title));

      if (currentStatus.timestampIso) {
        const ts = new Date(currentStatus.timestampIso);
        const prefix = currentStatus.hasPower ? `Увімкнули` : `Вимкнули`;
        messageText.addLine(`${prefix} о ${padTime(ts.getHours())}:${padTime(ts.getMinutes())}:${padTime(ts.getSeconds())}`);
      }

      await this.botService.sendMessageToPowerStatusGroup(
        messageText,
        { replyParameters: replyParameters },
      );
      this.logger.log(`Sent current power status to group: ${currentStatus.hasPower ? 'ON' : 'OFF'}`);
    } catch (error) {
      const message = `Failed to send current power status: ${error}`;
      this.logger.error(message);
      this.botService.sendMessageToOwner(new BotMessageText(message)).then();
    }
  }
}
