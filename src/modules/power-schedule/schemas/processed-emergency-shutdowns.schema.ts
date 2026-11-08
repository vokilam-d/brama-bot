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

  @Prop({ required: true })
  updatedAt: Date;
}

export const ProcessedEmergencyShutdownsSchema = SchemaFactory.createForClass(ProcessedEmergencyShutdowns);
