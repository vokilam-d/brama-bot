import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { config } from "./config";

const logger = new Logger('main.ts');

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter()
  );
  app.setGlobalPrefix(`/api/v1`);

  await app.listen(config.port, '0.0.0.0');

  logger.log(`Server running on port ${config.port}`);
}
bootstrap();
