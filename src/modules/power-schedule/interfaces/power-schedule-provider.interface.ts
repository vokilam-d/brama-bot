import { INormalizedSchedule } from './schedule.interface';

/**
 * Optional: used by orchestrator for on-demand schedule (GetSchedule / SendScheduleToAll)
 * when store has no entry for the requested date.
 */
export interface IPowerScheduleProvider {
  getId(): string;
  getScheduleForDate(date: Date): Promise<INormalizedSchedule | null>;
}
