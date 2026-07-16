import { Module, type OnModuleInit } from '@nestjs/common';
import type { Client } from '@prisma/client';
import { AgentModule } from '../../agent/agent.module';
import { AgentService } from '../../agent/agent.service';
import type { CalendarGateway } from '../../tools/tool.types';
import { GoogleCalendarGateway } from './google-calendar.gateway';
import { GoogleOAuthService } from './google-oauth.service';
import { GoogleController } from './google.controller';

/**
 * Wires the Google calendar gateway factory into the agent. The agent stays
 * decoupled: it only knows the CalendarGatewayFactory interface, so future
 * integrations (email, …) plug in the same way.
 */
@Module({
  imports: [AgentModule],
  controllers: [GoogleController],
  providers: [GoogleOAuthService],
  exports: [GoogleOAuthService],
})
export class GoogleModule implements OnModuleInit {
  constructor(
    private readonly oauth: GoogleOAuthService,
    private readonly agent: AgentService,
  ) {}

  onModuleInit(): void {
    this.agent.calendarFactory = {
      forClient: async (client: Client): Promise<CalendarGateway | null> => {
        const auth = await this.oauth.authorizedClientFor(client);
        if (!auth) return null;
        return new GoogleCalendarGateway(auth, client.timezone);
      },
    };
  }
}
