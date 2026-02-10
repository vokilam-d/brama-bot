import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter } from 'events';
import { CONFIG } from '../../../config';
import { PowerScheduleProviderId } from '../interfaces/schedule.interface';
import { PowerScheduleConfig } from '../schemas/power-schedule-config.schema';

@Injectable()
export class PowerScheduleConfigService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PowerScheduleConfigService.name);
  private config!: PowerScheduleConfig;

  /** Emitted after config is updated (schedule toggles). */
  readonly events = new EventEmitter();

  private readonly whenReadyPromise: Promise<void>;
  private resolveReady!: () => void;

  constructor(
    @InjectModel(PowerScheduleConfig.name)
    private powerScheduleConfigModel: Model<PowerScheduleConfig>,
  ) {
    this.whenReadyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  /** Resolves when config is cached. */
  whenReady(): Promise<void> {
    return this.whenReadyPromise;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureAndCacheConfig();
  }

  private async ensureAndCacheConfig(): Promise<void> {
    try {
      this.logger.debug(`Caching power schedule config...`);

      const appEnvKey: keyof PowerScheduleConfig = 'appEnv';
      const configDoc = await this.powerScheduleConfigModel
        .findOne({ [appEnvKey]: CONFIG.appEnv })
        .exec();
      this.config = configDoc?.toJSON();

      if (!this.config) {
        this.logger.debug(`Did not find power schedule config, creating new...`);

        this.config = Object.assign(new PowerScheduleConfig(), {
          appEnv: CONFIG.appEnv,
          enabledProviderIds: [
            PowerScheduleProviderId.Kd,
            PowerScheduleProviderId.Dtek,
            PowerScheduleProviderId.Yasno,
          ],
        });
        await this.powerScheduleConfigModel.create(this.config);
      }

      this.logger.log(`Caching power schedule config: Finished`);
      this.logger.debug(this.config);
    } catch (e) {
      this.logger.error(`Caching power schedule config: Failed:`);
      this.logger.error(e);
    } finally {
      this.resolveReady();
    }
  }

  getConfig(): PowerScheduleConfig {
    return this.config;
  }

  /** When enabledProviderIds is missing/empty, all providers are considered enabled. */
  isProviderEnabled(providerId: PowerScheduleProviderId): boolean {
    const ids = this.config.enabledProviderIds;
    if (!ids || ids.length === 0) {
      return true;
    }
    return ids.includes(providerId);
  }

  async toggleProviderEnabled(providerId: PowerScheduleProviderId): Promise<void> {
    const ids = this.config.enabledProviderIds ?? [
      PowerScheduleProviderId.Kd,
      PowerScheduleProviderId.Dtek,
      PowerScheduleProviderId.Yasno,
    ];
    const next = ids.includes(providerId)
      ? ids.filter((id) => id !== providerId)
      : [...ids, providerId];
    await this.updateConfig('enabledProviderIds', next);
  }

  async updateConfig<K extends keyof PowerScheduleConfig>(
    key: K,
    value: PowerScheduleConfig[K],
  ): Promise<void> {
    this.logger.debug(`Updating power schedule config... (${key}=${value})`);

    this.config[key] = value;

    try {
      const appEnvKey: keyof PowerScheduleConfig = 'appEnv';
      await this.powerScheduleConfigModel.findOneAndUpdate(
        { [appEnvKey]: CONFIG.appEnv },
        { $set: { [key]: value } },
      );

      this.logger.log(`Updating power schedule config: Finished`);
      this.logger.debug(this.config);
      this.events.emit('configUpdated');
    } catch (e) {
      this.logger.error(`Updating power schedule config: Failed:`);
      this.logger.error(e);
      throw e;
    }
  }
}
