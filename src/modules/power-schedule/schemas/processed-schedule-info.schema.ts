import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { PowerScheduleProviderId } from '../interfaces/schedule.interface';
import { ScheduleItemHours, ScheduleItemHoursSchema } from './schedule-item-hours.schema';

@Schema({ collection: 'processed-power-schedules' })
export class ProcessedScheduleInfo {
  @Prop({ required: true })
  dateIso: string;

  @Prop({ required: true, enum: PowerScheduleProviderId })
  providerId: PowerScheduleProviderId;

  @Prop({ required: true })
  updatedAt: Date;

  @Prop({ type: ScheduleItemHoursSchema, required: true })
  scheduleItemHours: ScheduleItemHours;
}

export const ProcessedScheduleInfoSchema = SchemaFactory.createForClass(ProcessedScheduleInfo);
