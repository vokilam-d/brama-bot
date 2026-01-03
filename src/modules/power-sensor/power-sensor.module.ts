import { Module } from '@nestjs/common';
import { PowerSensorController } from './controllers/power-sensor.controller';
import { PowerSensorService } from './services/power-sensor.service';
import { BotModule } from '../bot/bot.module';

@Module({
  imports: [BotModule],
  controllers: [PowerSensorController],
  providers: [PowerSensorService],
})
export class PowerSensorModule {}

