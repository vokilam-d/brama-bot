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
}

export const BotSentMessageSchema = SchemaFactory.createForClass(BotSentMessage);
