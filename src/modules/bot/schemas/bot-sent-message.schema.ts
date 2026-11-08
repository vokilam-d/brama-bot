import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class BotSentMessage {
  @Prop({ required: true })
  messageId: number;

  @Prop({ required: true })
  chatId: number;

  @Prop()
  messageThreadId?: number;

  @Prop({ required: true })
  text: string;

  @Prop({ required: true })
  sentAtIso: string;

  /** Shared by every copy of a message sent to all enabled groups, so the copies can be deleted together. */
  @Prop()
  broadcastId?: string;
}

export const BotSentMessageSchema = SchemaFactory.createForClass(BotSentMessage);
BotSentMessageSchema.index({ chatId: 1, messageId: 1 });
BotSentMessageSchema.index({ broadcastId: 1 }, { sparse: true });
