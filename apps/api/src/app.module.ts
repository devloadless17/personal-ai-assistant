import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // .env lives at the repo root so api + docker share one source of truth
      envFilePath: ['../../.env', '.env'],
    }),
    PrismaModule,
    HealthModule,
  ],
})
export class AppModule {}
