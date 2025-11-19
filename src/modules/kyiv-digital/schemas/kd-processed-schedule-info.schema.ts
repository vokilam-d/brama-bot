import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { IScheduleItemHours, PowerState } from '../interfaces/schedule-response.interface';

export class ScheduleItemHours implements IScheduleItemHours {
  @Prop({ required: true }) h00_0: PowerState;
  @Prop({ required: true }) h00_1: PowerState;
  @Prop({ required: true }) h01_0: PowerState;
  @Prop({ required: true }) h01_1: PowerState;
  @Prop({ required: true }) h02_0: PowerState;
  @Prop({ required: true }) h02_1: PowerState;
  @Prop({ required: true }) h03_0: PowerState;
  @Prop({ required: true }) h03_1: PowerState;
  @Prop({ required: true }) h04_0: PowerState;
  @Prop({ required: true }) h04_1: PowerState;
  @Prop({ required: true }) h05_0: PowerState;
  @Prop({ required: true }) h05_1: PowerState;
  @Prop({ required: true }) h06_0: PowerState;
  @Prop({ required: true }) h06_1: PowerState;
  @Prop({ required: true }) h07_0: PowerState;
  @Prop({ required: true }) h07_1: PowerState;
  @Prop({ required: true }) h08_0: PowerState;
  @Prop({ required: true }) h08_1: PowerState;
  @Prop({ required: true }) h09_0: PowerState;
  @Prop({ required: true }) h09_1: PowerState;
  @Prop({ required: true }) h10_0: PowerState;
  @Prop({ required: true }) h10_1: PowerState;
  @Prop({ required: true }) h11_0: PowerState;
  @Prop({ required: true }) h11_1: PowerState;
  @Prop({ required: true }) h12_0: PowerState;
  @Prop({ required: true }) h12_1: PowerState;
  @Prop({ required: true }) h13_0: PowerState;
  @Prop({ required: true }) h13_1: PowerState;
  @Prop({ required: true }) h14_0: PowerState;
  @Prop({ required: true }) h14_1: PowerState;
  @Prop({ required: true }) h15_0: PowerState;
  @Prop({ required: true }) h15_1: PowerState;
  @Prop({ required: true }) h16_0: PowerState;
  @Prop({ required: true }) h16_1: PowerState;
  @Prop({ required: true }) h17_0: PowerState;
  @Prop({ required: true }) h17_1: PowerState;
  @Prop({ required: true }) h18_0: PowerState;
  @Prop({ required: true }) h18_1: PowerState;
  @Prop({ required: true }) h19_0: PowerState;
  @Prop({ required: true }) h19_1: PowerState;
  @Prop({ required: true }) h20_0: PowerState;
  @Prop({ required: true }) h20_1: PowerState;
  @Prop({ required: true }) h21_0: PowerState;
  @Prop({ required: true }) h21_1: PowerState;
  @Prop({ required: true }) h22_0: PowerState;
  @Prop({ required: true }) h22_1: PowerState;
  @Prop({ required: true }) h23_0: PowerState;
  @Prop({ required: true }) h23_1: PowerState;
}

@Schema()
export class KdProcessedScheduleInfo {
  @Prop({ required: true })
  dateIso: string;

  @Prop({ required: true })
  scheduleItemHours: ScheduleItemHours;

  @Prop({ required: true })
  isSent: boolean;

  static collectionName = `kd-processed-schedule-info`;
}

export const KdProcessedScheduleInfoSchema = SchemaFactory.createForClass(KdProcessedScheduleInfo);
