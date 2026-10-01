import { ITelegramMessageEntity } from '../interfaces/telegram-message-entity.interface';
import { ITelegramUser } from '../interfaces/user.interface';

/**
 * Formats for bot message text.
 * 'b' - bold
 * 'i' - italic
 * 'c' - code block
 * 'ic' - inline code
 * 'q' - block quote
 * 'l' - link (URL)
 * 'm' - mention (user ID)
 * 't' - simple text
 */
export type BotMessageTextFormatType = 'b' | 'i' | 'c' | 'ic' | 'q' | 'l' | 'm' | 't';
export type BotMessageNonformattedText = string | number | boolean;
export type BotMessageMaybeFormattedText = BotMessageNonformattedText | BotMessageFormattedText;
export type BotMessageTextLine = BotMessageFormattedText[];
type MaybeArray<T> = T | T[];

export interface ITelegramMessageTextAndEntities {
  text: string;
  entities: ITelegramMessageEntity[];
}

/**
 * A piece of text with the formats applied to it.
 * Formats stack, so that e.g. bold(inlineCode(text)) produces both entities over the same text.
 */
export class BotMessageFormattedText {
  types: BotMessageTextFormatType[] = [];
  text: string;
  url?: string;
  userId?: number;
  codeLanguage?: string;

  constructor(options: Pick<BotMessageFormattedText, 'text'> & Partial<BotMessageFormattedText>) {
    Object.assign(this, options);
  }

  clone(): BotMessageFormattedText {
    return new BotMessageFormattedText({ ...this, types: [...this.types] });
  }

  getLength(): number {
    return this.text.length;
  }
}

/**
 * Builds a message as text plus telegram entities, so that nothing has to be escaped
 * and any text can be sent as is.
 *
 * Instance methods return "this" for chaining
 */
export class BotMessageText {
  private messageTextLines: BotMessageTextLine[] = [[]];

  private static newLineSeparator = '\n';

  constructor(text?: BotMessageMaybeFormattedText);
  constructor(texts?: BotMessageMaybeFormattedText[]);
  constructor(textOrTexts?: MaybeArray<BotMessageMaybeFormattedText>) {
    if (textOrTexts !== undefined) {
      this.add(textOrTexts as BotMessageMaybeFormattedText);
    }
  }

  private getLastLine(): BotMessageTextLine {
    return this.messageTextLines[this.messageTextLines.length - 1];
  }

  private isLastLineEmpty(): boolean {
    return !this.getLastLine().some(text => text.getLength() > 0);
  }

  add(text: BotMessageMaybeFormattedText): this;
  add(texts: BotMessageMaybeFormattedText[]): this;
  add(textOrTexts: MaybeArray<BotMessageMaybeFormattedText>): this {
    this.getLastLine().push(...BotMessageText.normalizeTextArray(textOrTexts));
    return this;
  }

  addLine(text: BotMessageMaybeFormattedText): this;
  addLine(texts: BotMessageMaybeFormattedText[]): this;
  addLine(textOrTexts: MaybeArray<BotMessageMaybeFormattedText>): this {
    if (!this.isLastLineEmpty()) {
      this.newLine();
    }
    this.add(textOrTexts as BotMessageMaybeFormattedText);
    this.newLine();
    return this;
  }

  prependToFirstLine(text: BotMessageMaybeFormattedText): this;
  prependToFirstLine(texts: BotMessageMaybeFormattedText[]): this;
  prependToFirstLine(textOrTexts: MaybeArray<BotMessageMaybeFormattedText>): this {
    this.messageTextLines[0].unshift(...BotMessageText.normalizeTextArray(textOrTexts));
    return this;
  }

  prependToLastLine(text: BotMessageMaybeFormattedText): this;
  prependToLastLine(texts: BotMessageMaybeFormattedText[]): this;
  prependToLastLine(textOrTexts: MaybeArray<BotMessageMaybeFormattedText>): this {
    this.getLastLine().unshift(...BotMessageText.normalizeTextArray(textOrTexts));
    return this;
  }

  newLine(): this {
    this.messageTextLines.push([]);
    return this;
  }

  /** Appends the first line of the added text to the current line, the rest as new lines */
  merge(messageTextToAdd: BotMessageText): this {
    const [firstLineToAdd, ...restLinesToAdd] = messageTextToAdd.cloneLines();
    this.add(firstLineToAdd);
    this.messageTextLines.push(...restLinesToAdd);
    return this;
  }

  clear(): this {
    this.messageTextLines = [[]];
    return this;
  }

  clone(): BotMessageText {
    const messageText = new BotMessageText();
    messageText.messageTextLines = this.cloneLines();
    return messageText;
  }

  toTelegramTextAndEntities(): ITelegramMessageTextAndEntities {
    const result: ITelegramMessageTextAndEntities = { text: '', entities: [] };

    this.messageTextLines.forEach((line, lineIndex) => {
      if (lineIndex > 0) {
        result.text += BotMessageText.newLineSeparator;
      }

      for (const linePart of line) {
        for (const entity of BotMessageText.buildTextEntities(linePart)) {
          // Offsets are in UTF-16 code units, which is what the length of a JS string is
          entity.offset = result.text.length;
          result.entities.push(entity);
        }

        result.text += linePart.text;
      }
    });

    return result;
  }

  toString(): string {
    return this.messageTextLines
      .map(line => line.map(text => text.text).join(''))
      .join(BotMessageText.newLineSeparator);
  }

  getLength(): number {
    return this.toString().length;
  }

  /**
   * Splits into several messages, each no longer than the given size.
   * Formatting is kept, a text that does not fit is carried over to the next message.
   */
  splitBySize(maxMessageTextSize: number): BotMessageText[] {
    const result: BotMessageText[] = [];
    let currentMessageText = new BotMessageText();

    const dumpCurrentToResult = (): void => {
      if (currentMessageText.getLength() === 0) {
        return;
      }
      result.push(currentMessageText);
      currentMessageText = new BotMessageText();
    };

    this.messageTextLines.forEach((line, lineIndex) => {
      if (lineIndex > 0) {
        const lengthWithSeparator = currentMessageText.getLength() + BotMessageText.newLineSeparator.length;
        if (lengthWithSeparator > maxMessageTextSize) {
          dumpCurrentToResult();
        } else {
          currentMessageText.newLine();
        }
      }

      for (const linePart of line) {
        let restText = linePart.text;

        while (restText.length > 0) {
          const freeSize = maxMessageTextSize - currentMessageText.getLength();
          if (freeSize <= 0) {
            dumpCurrentToResult();
            continue;
          }

          const chunk = linePart.clone();
          chunk.text = restText.slice(0, freeSize);
          restText = restText.slice(freeSize);

          currentMessageText.add(chunk);
        }
      }
    });

    dumpCurrentToResult();

    return result;
  }

  /**
   * Normalizes anything sendable into the messages to send:
   * a built message is split by size, a text with entities taken from telegram is sent as is
   */
  static toTextAndEntitiesParts(
    text: BotMessageText | ITelegramMessageTextAndEntities,
    maxMessageTextSize: number,
  ): ITelegramMessageTextAndEntities[] {
    if (text instanceof BotMessageText) {
      return text
        .splitBySize(maxMessageTextSize)
        .map(messageText => messageText.toTelegramTextAndEntities());
    }

    return text?.text ? [text] : [];
  }

  static toPlainText(text: BotMessageText | ITelegramMessageTextAndEntities): string {
    return text instanceof BotMessageText ? text.toString() : text?.text;
  }

  private cloneLines(): BotMessageTextLine[] {
    return this.messageTextLines.map(line => line.map(text => text.clone()));
  }

  private static normalizeTextArray(
    textOrTexts: MaybeArray<BotMessageMaybeFormattedText>,
  ): BotMessageFormattedText[] {
    return Array.isArray(textOrTexts)
      ? textOrTexts.map(text => this.normalizeText(text))
      : [this.normalizeText(textOrTexts)];
  }

  private static normalizeText(text: BotMessageMaybeFormattedText): BotMessageFormattedText {
    return text instanceof BotMessageFormattedText ? text : this.simpleText(text);
  }

  private static buildTextEntities(text: BotMessageFormattedText): ITelegramMessageEntity[] {
    if (!text.getLength()) {
      return [];
    }

    const entities: ITelegramMessageEntity[] = [];

    for (const type of text.types) {
      const entity: ITelegramMessageEntity = {
        type: null,
        offset: 0,
        length: text.getLength(),
      };

      switch (type) {
        case 'b':
          entity.type = 'bold';
          break;
        case 'i':
          entity.type = 'italic';
          break;
        case 'c':
          entity.type = 'pre';
          entity.language = text.codeLanguage;
          break;
        case 'ic':
          entity.type = 'code';
          break;
        case 'q':
          entity.type = 'blockquote';
          break;
        case 'l':
          entity.type = 'text_link';
          entity.url = text.url;
          break;
        case 'm':
          entity.type = 'text_mention';
          entity.user = { id: text.userId } as ITelegramUser;
          break;
        case 't':
        default:
          continue;
      }

      entities.push(entity);
    }

    return entities;
  }

  private static withFormat(
    text: BotMessageMaybeFormattedText,
    type: BotMessageTextFormatType,
    options: Partial<BotMessageFormattedText> = {},
  ): BotMessageFormattedText {
    const formattedText = BotMessageText.normalizeText(text).clone();

    if (!formattedText.types.includes(type)) {
      formattedText.types.push(type);
    }
    Object.assign(formattedText, options);

    return formattedText;
  }

  static bold(text: BotMessageMaybeFormattedText): BotMessageFormattedText {
    return BotMessageText.withFormat(text, 'b');
  }

  static italic(text: BotMessageMaybeFormattedText): BotMessageFormattedText {
    return BotMessageText.withFormat(text, 'i');
  }

  static link(url: string, text?: BotMessageMaybeFormattedText): BotMessageFormattedText {
    return BotMessageText.withFormat(text ?? url, 'l', { url });
  }

  static mention(userId: number, text: BotMessageMaybeFormattedText): BotMessageFormattedText {
    return BotMessageText.withFormat(text, 'm', { userId });
  }

  /**
   * `'text'` leaves the language off the entity, which is what telegram wants for a block that is
   * not code
   */
  static code(code: BotMessageMaybeFormattedText, type: 'json' | 'text'): BotMessageFormattedText {
    return BotMessageText.withFormat(code, 'c', {
      codeLanguage: type === 'text' ? undefined : type,
    });
  }

  static inlineCode(code: BotMessageMaybeFormattedText): BotMessageFormattedText {
    return BotMessageText.withFormat(code, 'ic');
  }

  static quote(text: BotMessageMaybeFormattedText): BotMessageFormattedText {
    return BotMessageText.withFormat(text, 'q');
  }

  static simpleText(text: BotMessageNonformattedText): BotMessageFormattedText {
    return new BotMessageFormattedText({ types: [], text: `${text}` });
  }
}
