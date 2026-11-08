import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { PowerScheduleProviderId } from '../interfaces/schedule.interface';
import { ScheduleItemHours, ScheduleItemHoursSchema } from './schedule-item-hours.schema';
import { ChatMessageRef, ChatMessageRefSchema } from '../../bot/schemas/chat-message-ref.schema';

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

  @Prop()
  groupKey?: string;

  /** Latest group messages with the schedule for this date; the next one for the date replies to them. */
  @Prop({ type: [ChatMessageRefSchema] })
  sentMessages?: ChatMessageRef[];
}

export const ProcessedScheduleInfoSchema = SchemaFactory.createForClass(ProcessedScheduleInfo);
