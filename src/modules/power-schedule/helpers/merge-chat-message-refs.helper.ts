import { IChatMessageRef } from '../../bot/interfaces/chat-message-ref.interface';

/** Refs in `next` replace those of the same chat in `prev`; chats missing from `next` keep their `prev` ref. */
export function mergeChatMessageRefs(prev: IChatMessageRef[], next: IChatMessageRef[]): IChatMessageRef[] {
  const nextChatIds = new Set(next.map((ref) => ref.chatId));
  return [...prev.filter((ref) => !nextChatIds.has(ref.chatId)), ...next];
}
