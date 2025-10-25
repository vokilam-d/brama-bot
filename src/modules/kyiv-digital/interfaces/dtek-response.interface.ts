export interface IDtekObject {
  "id": number;
  "sub_title": string;
  "title": string;
  "status": {
    "type": number;
    "text": string;
  }
}

export interface IDtekObjectsResponse {
  "objects": IDtekObject[];
  "list_hash": string;
  "schedule_state": number;
}
