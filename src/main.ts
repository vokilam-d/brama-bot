import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import * as dotenv from 'dotenv';

const logger = new Logger('main.ts');

async function bootstrap() {
  dotenv.config();
  // Dynamic imports to ensure env vars are used _after_ they are loaded
  const { AppModule } = await import('./app.module');
  const { CONFIG } = await import('./config');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.setGlobalPrefix(`/brama-bot/api/v1`);

  await app.listen(CONFIG.port, '0.0.0.0');

  logger.log(`Server running on port ${CONFIG.port}`);
}
bootstrap().then();
