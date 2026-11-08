import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { PowerScheduleProviderId } from '../interfaces/schedule.interface';

/** Single document: the last emergency shutdowns state sent, shared by all providers. */
@Schema({ collection: 'processed-emergency-shutdowns' })
export class ProcessedEmergencyShutdowns {
  /** Provider that reported the state. */
  @Prop({ required: true, enum: PowerScheduleProviderId })
  providerId: PowerScheduleProviderId;

  @Prop({ required: true })
  isActive: boolean;

  /** Outage group the state was reported for, e.g. `35.1`. */
  @Prop()
  groupKey?: string;

  /**
   * Latest time the state was reported in effect: the provider's own update time, or the check
   * time for a provider that has none.
   */
  @Prop({ required: true })
  updatedAt: Date;
}

export const ProcessedEmergencyShutdownsSchema = SchemaFactory.createForClass(ProcessedEmergencyShutdowns);
