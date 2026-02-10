import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { PowerScheduleProviderId } from '../interfaces/schedule.interface';

const defaultEnabledProviderIds = [
  PowerScheduleProviderId.Kd,
  PowerScheduleProviderId.Dtek,
  PowerScheduleProviderId.Yasno,
];

@Schema({ collection: 'power-schedule-config' })
export class PowerScheduleConfig {
  @Prop()
  appEnv: 'production' | 'development' = 'development';

  /** When false, orchestrator does not send schedule messages to groups. */
  @Prop({ default: true })
  scheduleSendingEnabled: boolean;

  /** Provider IDs that are enabled (polling runs). When missing/empty, all are enabled. */
  @Prop({
    type: [String],
    enum: PowerScheduleProviderId,
    default: defaultEnabledProviderIds,
  })
  enabledProviderIds: PowerScheduleProviderId[];
}

export const PowerScheduleConfigSchema = SchemaFactory.createForClass(PowerScheduleConfig);
