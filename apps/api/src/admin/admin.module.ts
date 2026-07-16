import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { GoogleModule } from '../integrations/google/google.module';
import { TelegramModule } from '../integrations/telegram/telegram.module';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminClientsService } from './admin-clients.service';
import { AdminController } from './admin.controller';
import type { Env } from '../config/env.validation';

@Module({
  imports: [
    TelegramModule,
    GoogleModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: { expiresIn: '12h' },
      }),
    }),
  ],
  controllers: [AdminController],
  providers: [AdminAuthService, AdminAuthGuard, AdminClientsService],
})
export class AdminModule {}
