import { Injectable } from '@nestjs/common';
import {
  INormalizedSchedule,
  PowerScheduleProviderId,
} from '../../power-schedule/interfaces/schedule.interface';
import { IPowerScheduleProvider } from '../../power-schedule/interfaces/power-schedule-provider.interface';

/**
 * Stub: Dtek power schedule provider.
 * TODO: Implement polling Dtek API (e.g. dtek-kem.com.ua) and call
 * PowerScheduleOrchestratorService.onScheduleChange on detected changes.
 */
@Injectable()
export class DtekScheduleService implements IPowerScheduleProvider {
  getId(): string {
    return PowerScheduleProviderId.Dtek;
  }

  async getScheduleForDate(_date: Date): Promise<INormalizedSchedule | null> {
    return null;
  }
}
