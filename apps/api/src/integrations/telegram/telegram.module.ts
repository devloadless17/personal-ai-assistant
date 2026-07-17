import { Module } from '@nestjs/common';
import { AgentModule } from '../../agent/agent.module';
import { TimezoneModule } from '../../timezone/timezone.module';
import { OpenAiTranscriptionService } from '../openai/openai-transcription.service';
import { TelegramConnectionService } from './telegram-connection.service';
import { TelegramController } from './telegram.controller';
import { TelegramUpdateProcessor } from './telegram-update.processor';
import { TelegramService } from './telegram.service';

@Module({
  imports: [AgentModule, TimezoneModule],
  controllers: [TelegramController],
  providers: [
    TelegramService,
    TelegramUpdateProcessor,
    TelegramConnectionService,
    OpenAiTranscriptionService,
  ],
  exports: [TelegramService, TelegramConnectionService],
})
export class TelegramModule {}
