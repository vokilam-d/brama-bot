import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class KdProcessedFeedItem {
  @Prop()
  id: string;

  @Prop()
  title: string;

  @Prop()
  description: string;

  @Prop()
  createdAtIso: string;
}

export const KdProcessedFeedItemSchema = SchemaFactory.createForClass(KdProcessedFeedItem);
