import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class PowerStatus {
  @Prop({ required: true })
  isPowerOn: boolean;

  @Prop({ required: true })
  timestamp: Date;
}

export const PowerStatusSchema = SchemaFactory.createForClass(PowerStatus);
