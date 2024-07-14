import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export enum BotMessageGroupType {
  ChannelOrGroup = 'CHANNEL_OR_GROUP',
  SUPERGROUP = 'SUPERGROUP',
}

export class BotMessageGroup {
  @Prop({ enum: BotMessageGroupType })
  type: BotMessageGroupType;

  @Prop()
  id: number;

  @Prop()
  threadId?: number;
}

@Schema()
export class BotConfig {
  @Prop([Number])
  ownerIds: number[];

  @Prop([BotMessageGroup])
  groups: BotMessageGroup[];
}

export const BotConfigSchema = SchemaFactory.createForClass(BotConfig);
