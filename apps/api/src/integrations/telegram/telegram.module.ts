import { Module } from '@nestjs/common';
import { AgentModule } from '../../agent/agent.module';
import { TelegramConnectionService } from './telegram-connection.service';
import { TelegramController } from './telegram.controller';
import { TelegramUpdateProcessor } from './telegram-update.processor';
import { TelegramService } from './telegram.service';

@Module({
  imports: [AgentModule],
  controllers: [TelegramController],
  providers: [TelegramService, TelegramUpdateProcessor, TelegramConnectionService],
  exports: [TelegramService, TelegramConnectionService],
})
export class TelegramModule {}
