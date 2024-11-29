export interface IScheduleItem {
  "day_of_week": number,
  "hours": {
    "h00": 0 | 1 | 2, // 0 - on, 2 - off
    "h01": 0 | 1 | 2,
    "h02": 0 | 1 | 2,
    "h03": 0 | 1 | 2,
    "h04": 0 | 1 | 2,
    "h05": 0 | 1 | 2,
    "h06": 0 | 1 | 2,
    "h07": 0 | 1 | 2,
    "h08": 0 | 1 | 2,
    "h09": 0 | 1 | 2,
    "h10": 0 | 1 | 2,
    "h11": 0 | 1 | 2,
    "h12": 0 | 1 | 2,
    "h13": 0 | 1 | 2,
    "h14": 0 | 1 | 2,
    "h15": 0 | 1 | 2,
    "h16": 0 | 1 | 2,
    "h17": 0 | 1 | 2,
    "h18": 0 | 1 | 2,
    "h19": 0 | 1 | 2,
    "h20": 0 | 1 | 2,
    "h21": 0 | 1 | 2,
    "h22": 0 | 1 | 2,
    "h23": 0 | 1 | 2
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
