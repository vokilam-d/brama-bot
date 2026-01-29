import { Module } from '@nestjs/common';
import { YasnoScheduleService } from './services/yasno-schedule.service';

@Module({
  providers: [YasnoScheduleService],
  exports: [YasnoScheduleService],
})
export class YasnoModule {}
