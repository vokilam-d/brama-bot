/**
 * Instance methods return "this" for chaining
 */
export class BotMessageText {
  private messageTextLines: string[] = [];

  private get lastTextLine(): string {
    return this.messageTextLines[this.messageTextLines.length - 1];
  }
  private set lastTextLine(text: string) {
    this.messageTextLines[this.messageTextLines.length - 1] = text;
  }

  private static newLineSeparator = '\n';

  constructor(initialText?: string) {
    this.newLine();
    this.add(initialText ?? '');
  }

  add(text: string): this {
    this.lastTextLine += text;
    return this;
  }

  addLine(text: string): this {
    if (this.lastTextLine) {
      this.newLine();
    }
    this.add(text);
    this.newLine();
    return this;
  }

  prependToFirstLine(text: string): this {
    let firstLine = this.messageTextLines[0];
    firstLine = `${text}${firstLine}`;
    this.messageTextLines[0] = firstLine;
    return this;
  }

  prependLine(text: string): this {
    this.messageTextLines.unshift(text);
    return this;
  }

  prependToLastLine(text: string): this {
    this.lastTextLine = `${text}${this.lastTextLine}`;
    return this;
  }

  newLine(): this {
    this.messageTextLines.push('');
    return this;
  }

  merge(messageTextToAdd: BotMessageText): this {
    const messageTextLinesToAdd = messageTextToAdd.toString().split(BotMessageText.newLineSeparator);
    this.messageTextLines.push(...messageTextLinesToAdd);
    return this;
  }

  clear(): this {
    this.messageTextLines = [];
    return this;
  }

  clone(): BotMessageText {
    const messageText = new BotMessageText();
    messageText.messageTextLines = JSON.parse(JSON.stringify(this.messageTextLines));
    return messageText;
  }

  get length(): number {
    return this.toString().length;
  }

  toString(): string {
    return this.messageTextLines.join(BotMessageText.newLineSeparator);
  }

  static bold(text: string | number): string {
    return `<b>${text}</b>`;
  }

  static italic(text: string): string {
    return `<i>${text}</i>`;
  }

  static link(urlInfo: { url?: string; userId?: number }, text?: string): string {
    const url = urlInfo.url || `tg://user?id=${urlInfo.userId}`;

    return `<a href="${url}">${text || url}</a>`;
  }

  static code(code: string, type: 'json'): string {
    return `<pre><code class="${type}">${code}</code></pre>`;
  }

  static inlineCode(code: string): string {
    return `<code>${code}</code>`;
  }
}