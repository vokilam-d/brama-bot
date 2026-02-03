import { IScheduleItemHours, PowerState } from '../../power-schedule/interfaces/schedule.interface';

const HALF_HOUR_KEYS = Array.from({ length: 24 }, (_, hour) => {
  const paddedHour = hour.toString().padStart(2, '0');
  return [`h${paddedHour}_0`, `h${paddedHour}_1`] as const;
}).flat();

export interface YasnoSlot {
  start: number;
  end: number;
  type: 'Definite' | 'NotPlanned' | 'Possible';
}

function getStateAtMinute(minute: number, slots: YasnoSlot[]): PowerState {
  for (const slot of slots) {
    if (minute >= slot.start && minute < slot.end) {
      if (slot.type === 'Definite') return PowerState.Off;
      if (slot.type === 'Possible') return PowerState.MaybeOff;
      return PowerState.On;
    }
  }
  return PowerState.On;
}

export function createDefaultScheduleHours(
  state: PowerState = PowerState.On,
): IScheduleItemHours {
  return HALF_HOUR_KEYS.reduce((acc, key) => {
    acc[key as keyof IScheduleItemHours] = state;
    return acc;
  }, {} as IScheduleItemHours);
}

export function normalizeYasnoSlots(slots: YasnoSlot[]): IScheduleItemHours {
  const hours = createDefaultScheduleHours();
  for (let i = 0; i < HALF_HOUR_KEYS.length; i++) {
    const minute = i * 30 + 15;
    const state = getStateAtMinute(minute, slots);
    const key = HALF_HOUR_KEYS[i] as keyof IScheduleItemHours;
    hours[key] = state;
  }
  return hours;
}
