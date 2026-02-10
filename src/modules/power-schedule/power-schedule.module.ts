import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BotModule } from '../bot/bot.module';
import { ProcessedScheduleInfo, ProcessedScheduleInfoSchema } from './schemas/processed-schedule-info.schema';
import {
  PowerScheduleConfig,
  PowerScheduleConfigSchema,
} from './schemas/power-schedule-config.schema';
import { PowerScheduleConfigService } from './services/power-schedule-config.service';
import { PowerScheduleOrchestratorService } from './services/power-schedule-orchestrator.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: ProcessedScheduleInfo.name,
        schema: ProcessedScheduleInfoSchema,
      },
      {
        name: PowerScheduleConfig.name,
        schema: PowerScheduleConfigSchema,
      },
    ]),
    forwardRef(() => BotModule),
  ],
  providers: [PowerScheduleConfigService, PowerScheduleOrchestratorService],
  exports: [PowerScheduleConfigService, PowerScheduleOrchestratorService],
})
export class PowerScheduleModule {}
