import { BotMessageText } from '../../bot/helpers/bot-message-text.helper';
import { IScheduleItemHours, PowerState } from '../interfaces/schedule.interface';
import { getMonthName } from '../../../helpers/get-month-name.helper';
import { getDayName } from '../../../helpers/get-day-name.helper';

export function buildScheduleTitleLine(date: Date, isNew: boolean): string {
  const title = isNew ? `Новий графік` : `Графік`;
  return `🗓 ${title} на ${date.getDate()} ${getMonthName(date)}, ${getDayName(date)}`;
}

export function buildDayScheduleMessage(
  hours: IScheduleItemHours,
  date: Date,
): BotMessageText {
  const halfHours = Object.keys(hours).sort() as (keyof IScheduleItemHours)[];

  const powerStatesWithRanges: {
    powerState: PowerState;
    ranges: { startHalfHour: string; endHalfHour?: string }[];
  }[] = [];

  for (let i = 0; i < halfHours.length; i++) {
    const halfHour = halfHours[i];
    const powerState = hours[halfHour];
    const lastPowerStateWithRanges = powerStatesWithRanges.at(-1);
    const lastRange = lastPowerStateWithRanges?.ranges.at(-1);
    const isLastRangeEnded = Boolean(lastRange?.endHalfHour);

    const handleOffPowerState = (state: PowerState) => {
      if (!lastPowerStateWithRanges) {
        powerStatesWithRanges.push({ powerState: state, ranges: [{ startHalfHour: halfHour }] });
      } else if (lastPowerStateWithRanges.powerState !== state) {
        if (lastRange && !isLastRangeEnded) {
          lastRange.endHalfHour = halfHour;
        }
        powerStatesWithRanges.push({ powerState: state, ranges: [{ startHalfHour: halfHour }] });
      } else if (isLastRangeEnded) {
        lastPowerStateWithRanges.ranges.push({ startHalfHour: halfHour });
      }
    };

    if (powerState === PowerState.On) {
      if (lastRange && !isLastRangeEnded) {
        lastRange.endHalfHour = halfHour;
      }
    } else if (powerState === PowerState.Off || powerState === PowerState.MaybeOff) {
      handleOffPowerState(powerState);
    }
  }

  const messageText = new BotMessageText();

  if (powerStatesWithRanges.length === 0) {
    messageText.addLine(`Світло буде весь день`);
    return messageText;
  }

  const lastRange = powerStatesWithRanges.at(-1).ranges.at(-1);
  if (!lastRange.endHalfHour) {
    lastRange.endHalfHour = 'h00_0';
  }

  const buildReadableHalfHour = (halfHourStr: string): string => {
    const match = halfHourStr.match(/^h(\d{2})_([01])$/);
    if (!match) {
      return halfHourStr;
    }
    const hour = match[1];
    const halfHourIndex = match[2];
    const halfHour = halfHourIndex === '1' ? '30' : '00';
    return `${hour}:${halfHour}`;
  };

  for (const powerStateWithRanges of powerStatesWithRanges) {
    if (powerStateWithRanges.powerState === PowerState.Off) {
      messageText.addLine(`Світло буде відсутнє:`);
    } else if (powerStateWithRanges.powerState === PowerState.MaybeOff) {
      messageText.addLine(`Можливе відключення:`);
    }
    for (const range of powerStateWithRanges.ranges) {
      const start = buildReadableHalfHour(range.startHalfHour);
      const end = buildReadableHalfHour(range.endHalfHour);
      messageText.addLine(`з ${start} до ${end}`);
    }
  }

  return messageText;
}
