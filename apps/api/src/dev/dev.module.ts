import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { DevController } from './dev.controller';

/** Registered by app.module.ts ONLY when NODE_ENV=development. */
@Module({
  imports: [AgentModule],
  controllers: [DevController],
})
export class DevModule {}
