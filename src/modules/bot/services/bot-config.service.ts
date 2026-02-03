import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BotConfig } from '../schemas/bot-config.schema';
import { CONFIG } from '../../../config';

@Injectable()
export class BotConfigService {
  private readonly logger = new Logger(BotConfigService.name);
  private botConfig: BotConfig;

  constructor(
    @InjectModel(BotConfig.name) private botConfigModel: Model<BotConfig>,
  ) {}

  async ensureAndCacheConfig(): Promise<void> {
    try {
      this.logger.debug(`Caching config...`);

      const appEnvKey: keyof BotConfig = 'appEnv';
      const configDoc = await this.botConfigModel
        .findOne({ [appEnvKey]: CONFIG.appEnv })
        .exec();
      this.botConfig = configDoc?.toJSON();

      if (!this.botConfig) {
        this.logger.debug(`Did not find bot config, creating new...`);

        this.botConfig = new BotConfig();
        await this.botConfigModel.create(this.botConfig);
      }

      this.logger.log(`Caching config: Finished`);
      this.logger.debug(this.botConfig);
    } catch (e) {
      this.logger.error(`Caching config: Failed:`);
      this.logger.error(e);
    }
  }

  getConfig(): BotConfig {
    return this.botConfig;
  }

  async updateConfig<K extends keyof BotConfig>(
    key: K,
    value: BotConfig[K],
  ): Promise<void> {
    this.logger.debug(`Updating config... (${key}=${value})`);

    this.botConfig[key] = value;

    try {
      const appEnvKey: keyof BotConfig = 'appEnv';
      await this.botConfigModel.findOneAndUpdate(
        { [appEnvKey]: CONFIG.appEnv },
        { $set: { [key]: value } },
      );

      this.logger.log(`Updating config: Finished`);
      this.logger.debug(this.botConfig);
    } catch (e) {
      this.logger.error(`Updating config: Failed:`);
      this.logger.error(e);
      throw e;
    }
  }
}
