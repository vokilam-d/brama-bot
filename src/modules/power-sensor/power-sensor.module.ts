import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PowerSensorController } from './controllers/power-sensor.controller';
import { PowerSensorService } from './services/power-sensor.service';
import { BotModule } from '../bot/bot.module';
import { PowerStatus, PowerStatusSchema } from './schemas/power-status.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PowerStatus.name, schema: PowerStatusSchema, collection: 'power-status' },
    ]),
    BotModule,
  ],
  controllers: [PowerSensorController],
  providers: [PowerSensorService],
})
export class PowerSensorModule {}

