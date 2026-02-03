import { IScheduleItemHours, PowerState } from '../../power-schedule/interfaces/schedule.interface';

const HALF_HOUR_KEYS = Array.from({ length: 24 }, (_, hour) => {
  const paddedHour = hour.toString().padStart(2, '0');
  return [`h${paddedHour}_0`, `h${paddedHour}_1`] as const;
}).flat();

const SLOT_TO_HALF_HOUR_KEYS = Array.from({ length: 24 }, (_, index) => {
  const hour = index.toString().padStart(2, '0');
  const slot = (index + 1).toString();
  return {
    slot,
    firstHalfKey: `h${hour}_0` as keyof IScheduleItemHours,
    secondHalfKey: `h${hour}_1` as keyof IScheduleItemHours,
  };
});

const SLOT_VALUE_TO_POWER_STATE: Record<
  DtekSlotValue,
  { firstHalf: PowerState; secondHalf: PowerState }
> = {
  yes: { firstHalf: PowerState.On, secondHalf: PowerState.On },
  no: { firstHalf: PowerState.Off, secondHalf: PowerState.Off },
  maybe: { firstHalf: PowerState.MaybeOff, secondHalf: PowerState.MaybeOff },
  first: { firstHalf: PowerState.Off, secondHalf: PowerState.On },
  second: { firstHalf: PowerState.On, secondHalf: PowerState.Off },
  mfirst: { firstHalf: PowerState.MaybeOff, secondHalf: PowerState.On },
  msecond: { firstHalf: PowerState.On, secondHalf: PowerState.MaybeOff },
};

export type DtekSlotValue =
  | 'yes'
  | 'no'
  | 'maybe'
  | 'first'
  | 'second'
  | 'mfirst'
  | 'msecond';

type DtekDaySlots = Record<string, DtekSlotValue>;

export const createDefaultScheduleHours = (state: PowerState = PowerState.On): IScheduleItemHours => {
  return HALF_HOUR_KEYS.reduce((acc, key) => {
    acc[key as keyof IScheduleItemHours] = state;
    return acc;
  }, {} as IScheduleItemHours);
};

export const normalizeDtekDaySlots = (slots?: DtekDaySlots): IScheduleItemHours | null => {
  if (!slots) {
    return null;
  }

  const hours = createDefaultScheduleHours();

  SLOT_TO_HALF_HOUR_KEYS.forEach(({ slot, firstHalfKey, secondHalfKey }) => {
    const slotValue = slots[slot] as DtekSlotValue | undefined;
    if (!slotValue) {
      return;
    }

    const mapping = SLOT_VALUE_TO_POWER_STATE[slotValue];
    if (!mapping) {
      return;
    }

    hours[firstHalfKey] = mapping.firstHalf;
    hours[secondHalfKey] = mapping.secondHalf;
  });

  return hours;
};

export const isAllPowerOn = (hours: IScheduleItemHours): boolean => {
  return Object.values(hours).every((state) => state === PowerState.On);
};
