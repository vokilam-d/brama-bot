import { Injectable } from '@nestjs/common';
import {
  INormalizedSchedule,
  PowerScheduleProviderId,
} from '../../power-schedule/interfaces/schedule.interface';
import { IPowerScheduleProvider } from '../../power-schedule/interfaces/power-schedule-provider.interface';

/**
 * Stub: Yasno power schedule provider.
 * TODO: Implement polling Yasno API and call
 * PowerScheduleOrchestratorService.onScheduleChange on detected changes.
 */
@Injectable()
export class YasnoScheduleService implements IPowerScheduleProvider {
  getId(): string {
    return PowerScheduleProviderId.Yasno;
  }

  async getScheduleForDate(_date: Date): Promise<INormalizedSchedule | null> {
    return null;
  }
}
