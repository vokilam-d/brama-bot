import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IChatMessageRef } from '../interfaces/chat-message-ref.interface';

/** A message the bot sent, kept so a later message can reply to it or the message can be deleted. */
@Schema({ _id: false })
export class ChatMessageRef implements IChatMessageRef {
  @Prop({ required: true })
  chatId: number;

  @Prop({ required: true })
  messageId: number;
}

export const ChatMessageRefSchema = SchemaFactory.createForClass(ChatMessageRef);
