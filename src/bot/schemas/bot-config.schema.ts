import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class BotConfig {
  @Prop([Number])
  ownerIds: number[];

  @Prop()
  channelId: number;
}

export const BotConfigSchema = SchemaFactory.createForClass(BotConfig);