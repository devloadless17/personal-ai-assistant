import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { GoogleModule } from '../integrations/google/google.module';
import { TelegramModule } from '../integrations/telegram/telegram.module';
import { ClientAuthGuard } from './client-auth.guard';
import { ClientAuthService } from './client-auth.service';
import { ClientController } from './client.controller';
import type { Env } from '../config/env.validation';

@Module({
  imports: [
    GoogleModule,
    TelegramModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: { expiresIn: '30d' }, // clients stay signed in longer than admins
      }),
    }),
  ],
  controllers: [ClientController],
  providers: [ClientAuthService, ClientAuthGuard],
})
export class ClientModule {}
