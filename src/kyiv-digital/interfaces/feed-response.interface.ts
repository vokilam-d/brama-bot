export interface IFeedResponse {
  "feed": {
    "data": {
      "id": string;
      "type": number;
      "icon": string;
      "sub_icon": null,
      "read": boolean;
      "title": string;
      "description": string;
      "value_sum": null;
      "clickable": boolean;
      "created_at": number;
      "payload": null
    }[],
    "meta": {
      "cursor": {
        "current": number;
        "prev": null,
        "next": null,
        "count": number;
      }
    }
  },
  "unread_count": number;
}
