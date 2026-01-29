import { Module } from '@nestjs/common';
import { DtekScheduleService } from './services/dtek-schedule.service';

@Module({
  providers: [DtekScheduleService],
  exports: [DtekScheduleService],
})
export class DtekModule {}
