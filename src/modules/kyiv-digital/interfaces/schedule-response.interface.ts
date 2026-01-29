export {
  PowerState,
  IScheduleItemHours,
} from '../../power-schedule/interfaces/schedule.interface';

import type { IScheduleItemHours } from '../../power-schedule/interfaces/schedule.interface';

export interface IScheduleItem {
  "day_of_week": number,
  "hours": IScheduleItemHours;
}

export interface IScheduleResponse {
  "object": {
    "id": number;
    "sub_title": string;
    "title": string;
    "status": {
      "type": number;
      "text": string;
    }
  },
  "schedule": IScheduleItem[];
  "schedule_state": number,
  "notifications": {
    "enabled": boolean,
    "at_night": boolean
  },
  "faq_link": string;
  "pdf_schedule": string;
}
