import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class BotIncomingMessage {
  @Prop()
  message: any;
}

export const BotIncomingMessageSchema = SchemaFactory.createForClass(BotIncomingMessage);
