import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { PowerScheduleProviderId } from '../interfaces/schedule.interface';
import { ScheduleItemHours, ScheduleItemHoursSchema } from './schedule-item-hours.schema';

@Schema({ collection: 'power-schedule-processed' })
export class ProcessedScheduleInfo {
  @Prop({ required: true })
  dateIso: string;

  @Prop({ required: true, enum: PowerScheduleProviderId })
  providerId: PowerScheduleProviderId;

  @Prop({ required: true })
  updatedAt: Date;

  @Prop({ type: ScheduleItemHoursSchema, required: true })
  scheduleItemHours: ScheduleItemHours;

  @Prop({ required: true })
  isSent: boolean;
}

export const ProcessedScheduleInfoSchema = SchemaFactory.createForClass(ProcessedScheduleInfo);
