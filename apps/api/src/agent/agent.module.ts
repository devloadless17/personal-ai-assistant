import { Module } from '@nestjs/common';
import { AnthropicService } from '../integrations/anthropic/anthropic.service';
import { AgentService } from './agent.service';

@Module({
  providers: [AgentService, AnthropicService],
  exports: [AgentService],
})
export class AgentModule {}
