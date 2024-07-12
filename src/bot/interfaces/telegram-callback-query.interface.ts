import { ITelegramUser } from './user.interface';
import { ITelegramMessage } from './message.interface';

export interface ITelegramCallbackQuery {
  id: string; // Unique identifier for this query
  from: ITelegramUser; // Sender
  message: ITelegramMessage; // Message sent by the bot with the callback button that originated the query
  inline_message_id?: string; // Identifier of the message sent via the bot in inline mode, that originated the query.
  chat_instance: string; // Global identifier, uniquely corresponding to the chat to which the message with the callback button was sent. Useful for high scores in games.
  data?: string; // Data associated with the callback button. Be aware that the message originated the query can contain no callback buttons with this data.
  game_short_name?: string; // Short name of a Game to be returned, serves as the unique identifier for the game
}