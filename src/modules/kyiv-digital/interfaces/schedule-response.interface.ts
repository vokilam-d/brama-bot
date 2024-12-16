export enum ScheduleHourType {
  On = 0,
  Half = 1,
  Off = 2,
}

export interface IScheduleItem {
  "day_of_week": number,
  "hours": {
    "h00": ScheduleHourType,
    "h01": ScheduleHourType,
    "h02": ScheduleHourType,
    "h03": ScheduleHourType,
    "h04": ScheduleHourType,
    "h05": ScheduleHourType,
    "h06": ScheduleHourType,
    "h07": ScheduleHourType,
    "h08": ScheduleHourType,
    "h09": ScheduleHourType,
    "h10": ScheduleHourType,
    "h11": ScheduleHourType,
    "h12": ScheduleHourType,
    "h13": ScheduleHourType,
    "h14": ScheduleHourType,
    "h15": ScheduleHourType,
    "h16": ScheduleHourType,
    "h17": ScheduleHourType,
    "h18": ScheduleHourType,
    "h19": ScheduleHourType,
    "h20": ScheduleHourType,
    "h21": ScheduleHourType,
    "h22": ScheduleHourType,
    "h23": ScheduleHourType,
  }
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
