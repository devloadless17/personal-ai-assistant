import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AgentModule } from './agent/agent.module';
import { validateEnv } from './config/env.validation';
import { CryptoModule } from './crypto/crypto.module';
import { DevModule } from './dev/dev.module';
import { HealthModule } from './health/health.module';
import { GoogleModule } from './integrations/google/google.module';
import { TelegramModule } from './integrations/telegram/telegram.module';
import { JobsModule } from './jobs/jobs.module';
import { PrismaModule } from './prisma/prisma.module';
import { TenancyModule } from './tenancy/tenancy.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // .env lives at the repo root so api + docker share one source of truth
      envFilePath: ['../../.env', '.env'],
    }),
    // Global rate limit (per IP): generous for normal use, a wall for abuse.
    // Login gets a much tighter limit via @Throttle on the endpoint.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    CryptoModule,
    TenancyModule,
    AgentModule,
    TelegramModule,
    GoogleModule,
    JobsModule,
    AdminModule,
    HealthModule,
    // Dev-only chat harness — never registered outside development.
    ...(process.env.NODE_ENV === 'development' ? [DevModule] : []),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
