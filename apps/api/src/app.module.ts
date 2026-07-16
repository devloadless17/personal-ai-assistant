import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
    PrismaModule,
    CryptoModule,
    TenancyModule,
    AgentModule,
    TelegramModule,
    GoogleModule,
    JobsModule,
    HealthModule,
    // Dev-only chat harness — never registered outside development.
    ...(process.env.NODE_ENV === 'development' ? [DevModule] : []),
  ],
})
export class AppModule {}
