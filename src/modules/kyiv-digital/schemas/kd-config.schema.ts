import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class KdConfig {
  @Prop()
  accessToken: string;

  @Prop()
  lastProcessedFeedItemCreatedAtIso: string;
}

export const KdConfigSchema = SchemaFactory.createForClass(KdConfig);
