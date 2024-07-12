import { Module } from '@nestjs/common';
import { KdService } from './services/kd.service';
import { KdController } from './controllers/kd.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { KdConfig, KdConfigSchema } from './schemas/kd-config.schema';
import { HttpModule } from '@nestjs/axios';
import { BotModule } from '../bot/bot.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: KdConfig.name, schema: KdConfigSchema, collection: 'kyiv-digital-config' }]),
    HttpModule,
    BotModule,
  ],
  providers: [KdService],
  controllers: [KdController]
})
export class KdModule {}
