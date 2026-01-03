import { Body, Controller, Post } from '@nestjs/common';
import { PowerSensorService } from '../services/power-sensor.service';
import { PowerSensorDto } from '../dto/power-sensor.dto';

@Controller('power-sensor')
export class PowerSensorController {
  constructor(private readonly powerSensorService: PowerSensorService) {}

  @Post()
  async handlePowerSensorUpdate(@Body() dto: PowerSensorDto): Promise<{ data: true; }> {
    await this.powerSensorService.onPowerSensorMessage(dto);

    return {
      data: true,
    };
  }
}

