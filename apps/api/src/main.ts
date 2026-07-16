import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { Env } from './config/env.validation';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('API_PORT', { infer: true });
  const webUrl = config.get('PUBLIC_WEB_URL', { infer: true });

  // Only the admin dashboard origin may call the API from a browser.
  app.enableCors({ origin: webUrl, credentials: true });

  await app.listen(port);
  new Logger('Bootstrap').log(`API listening on port ${port}`);
}

void bootstrap();
