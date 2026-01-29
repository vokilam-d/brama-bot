export enum PowerState {
  On = 0,
  MaybeOff = 1,
  Off = 2,
}

export interface IScheduleItemHours {
  h00_0: PowerState;
  h00_1: PowerState;
  h01_0: PowerState;
  h01_1: PowerState;
  h02_0: PowerState;
  h02_1: PowerState;
  h03_0: PowerState;
  h03_1: PowerState;
  h04_0: PowerState;
  h04_1: PowerState;
  h05_0: PowerState;
  h05_1: PowerState;
  h06_0: PowerState;
  h06_1: PowerState;
  h07_0: PowerState;
  h07_1: PowerState;
  h08_0: PowerState;
  h08_1: PowerState;
  h09_0: PowerState;
  h09_1: PowerState;
  h10_0: PowerState;
  h10_1: PowerState;
  h11_0: PowerState;
  h11_1: PowerState;
  h12_0: PowerState;
  h12_1: PowerState;
  h13_0: PowerState;
  h13_1: PowerState;
  h14_0: PowerState;
  h14_1: PowerState;
  h15_0: PowerState;
  h15_1: PowerState;
  h16_0: PowerState;
  h16_1: PowerState;
  h17_0: PowerState;
  h17_1: PowerState;
  h18_0: PowerState;
  h18_1: PowerState;
  h19_0: PowerState;
  h19_1: PowerState;
  h20_0: PowerState;
  h20_1: PowerState;
  h21_0: PowerState;
  h21_1: PowerState;
  h22_0: PowerState;
  h22_1: PowerState;
  h23_0: PowerState;
  h23_1: PowerState;
}

export interface INormalizedSchedule {
  date: Date;
  hours: IScheduleItemHours;
}

export enum PowerScheduleProviderId {
  Kd = 'kd',
  Dtek = 'dtek',
  Yasno = 'yasno',
}
