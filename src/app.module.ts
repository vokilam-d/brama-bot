import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CONFIG } from './config';
import { PowerScheduleModule } from './modules/power-schedule/power-schedule.module';
import { KdModule } from './modules/kyiv-digital/kd.module';
import { DtekModule } from './modules/dtek/dtek.module';
import { YasnoModule } from './modules/yasno/yasno.module';
import { BotModule } from './modules/bot/bot.module';
import { BotService } from './modules/bot/services/bot.service';
import { BotMessageText } from './modules/bot/helpers/bot-message-text.helper';
import { EshopModule } from './modules/eshop/eshop.module';
import { PowerSensorModule } from './modules/power-sensor/power-sensor.module';

@Module({
  imports: [
    MongooseModule.forRoot(CONFIG.mongoUri, { retryDelay: 1 }),
    PowerScheduleModule,
    KdModule,
    DtekModule,
    YasnoModule,
    BotModule,
    EshopModule,
    PowerSensorModule,
  ],
})
export class AppModule implements OnApplicationBootstrap {

  private readonly logger: Logger = new Logger(AppModule.name);

  constructor(
    private readonly botService: BotService,
  ) {
  }

  onApplicationBootstrap(): any {
    this.botService.sendMessageToOwner(new BotMessageText(`Bot started`)).then();
    this.handleUnhandledExceptions();
  }

  private handleUnhandledExceptions(): void {
    process.on('unhandledRejection', (reason) => {
      this.logger.error('unhandledRejection:');
      this.logger.error(reason, (reason as Error).stack);

      this.botService.sendMessageToOwner(new BotMessageText(`unhandledRejection: ${reason}`)).then();
    });
  }
}
