import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BotModule } from '../bot/bot.module';
import { ProcessedScheduleInfo, ProcessedScheduleInfoSchema } from './schemas/processed-schedule-info.schema';
import { PowerScheduleOrchestratorService } from './services/power-schedule-orchestrator.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: ProcessedScheduleInfo.name,
        schema: ProcessedScheduleInfoSchema,
      },
    ]),
    BotModule,
  ],
  providers: [PowerScheduleOrchestratorService],
  exports: [PowerScheduleOrchestratorService],
})
export class PowerScheduleModule {}
