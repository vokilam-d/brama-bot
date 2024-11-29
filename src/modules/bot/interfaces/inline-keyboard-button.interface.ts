export interface ITelegramInlineKeyboardButton {
  text: string;
  url?: string;
  login_url?: any;
  callback_data?: string;
  switch_inline_query?: string;
  switch_inline_query_current_chat?: string;
  callback_game?: any;
  pay?: boolean;
}
