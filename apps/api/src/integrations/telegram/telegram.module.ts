import { Module } from '@nestjs/common';
import { AgentModule } from '../../agent/agent.module';
import { TelegramController } from './telegram.controller';
import { TelegramUpdateProcessor } from './telegram-update.processor';
import { TelegramService } from './telegram.service';

@Module({
  imports: [AgentModule],
  controllers: [TelegramController],
  providers: [TelegramService, TelegramUpdateProcessor],
  exports: [TelegramService],
})
export class TelegramModule {}
