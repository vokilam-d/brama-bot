export interface IMessageLink {
  /** `-100<id>` for a link to a private chat, `@<username>` for a public one. */
  chatId: string;
  messageId: number;
}

const MESSAGE_LINK_REGEX = /^(?:https?:\/\/)?t\.me\/(?:c\/(\d+)|(\w+))\/(?:\d+\/)?(\d+)\/?(?:[?#].*)?$/;

/**
 * Parses a Telegram message link: `t.me/<username>/<message id>` or `t.me/c/<chat id>/<message id>`,
 * with an optional topic id before the message id. Returns null for anything else.
 */
export function parseMessageLink(link: string): IMessageLink | null {
  const match = link.match(MESSAGE_LINK_REGEX);
  if (!match) {
    return null;
  }

  const [, privateChatId, username, messageId] = match;
  return {
    chatId: privateChatId ? `-100${privateChatId}` : `@${username}`,
    messageId: Number(messageId),
  };
}
