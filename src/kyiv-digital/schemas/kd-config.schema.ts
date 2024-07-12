import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class KdConfig {
  @Prop()
  accessToken: string;

  @Prop()
  lastProcessedFeedId: string;
}

export const KdConfigSchema = SchemaFactory.createForClass(KdConfig);
