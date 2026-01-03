import { Body, Controller, Get, Post } from '@nestjs/common';
import { PowerSensorService } from '../services/power-sensor.service';
import { PowerSensorDto } from '../dto/power-sensor.dto';

@Controller('power-sensor')
export class PowerSensorController {
  constructor(private readonly powerSensorService: PowerSensorService) {}

  @Get()
  async getPowerStatus(): Promise<PowerSensorDto> {
    return await this.powerSensorService.getCurrentPowerStatus();
  }

  @Post()
  async handlePowerSensorUpdate(@Body() dto: PowerSensorDto): Promise<{ data: PowerSensorDto; }> {
    await this.powerSensorService.onPowerSensorMessage(dto);

    return {
      data: dto,
    };
  }
}

