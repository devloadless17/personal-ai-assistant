import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module';
import { ZodExceptionFilter } from './common/zod-exception.filter';
import type { Env } from './config/env.validation';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  // Malformed request bodies (Zod parse) → 400 with field messages, not 500.
  app.useGlobalFilters(new ZodExceptionFilter());

  // Behind the reverse proxy: real client IPs for rate limiting/logs.
  app.set('trust proxy', 1);
  // Security headers on API responses (OAuth callback page included).
  app.use(helmet());
  // Telegram updates and admin payloads are small — cap bodies hard.
  app.use(json({ limit: '256kb' }));

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('API_PORT', { infer: true });
  const webUrl = config.get('PUBLIC_WEB_URL', { infer: true });

  // Only the admin dashboard origin may call the API from a browser.
  app.enableCors({ origin: webUrl, credentials: true });

  await app.listen(port);
  new Logger('Bootstrap').log(`API listening on port ${port}`);
}

void bootstrap();
