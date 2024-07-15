import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import * as mongoose from 'mongoose';

@Schema()
export class BotIncomingMessage {
  @Prop({ type: mongoose.Schema.Types.Mixed })
  message: any;
}

export const BotIncomingMessageSchema = SchemaFactory.createForClass(BotIncomingMessage);
