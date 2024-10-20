import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { config } from './config';
import { KdModule } from './kyiv-digital/kd.module';
import { BotModule } from './bot/bot.module';
import { BotService } from './bot/services/bot.service';
import { BotMessageText } from './bot/helpers/bot-message-text.helper';

@Module({
  imports: [
    MongooseModule.forRoot(config.mongoUri, { retryDelay: 1 }),
    KdModule,
    BotModule,
  ],
})
export class AppModule implements OnApplicationBootstrap {

  private readonly logger: Logger = new Logger(AppModule.name);

  constructor(
    private readonly botService: BotService,
  ) {
  }

  onApplicationBootstrap(): any {
    this.handleUnhandledExceptions();
  }

  private handleUnhandledExceptions(): void {
    process.on('unhandledRejection', (reason) => {
      this.logger.error('unhandledRejection:');
      this.logger.error(reason, (reason as Error).stack);

      this.botService.sendMessageToOwner(new BotMessageText(`unhandledRejection: ${JSON.stringify(reason)}`)).then();
    });
  }
}
