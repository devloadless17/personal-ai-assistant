import { Body, Controller, NotFoundException, Post } from '@nestjs/common';
import { z } from 'zod';
import { AgentService } from '../agent/agent.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenancyService } from '../tenancy/tenancy.service';

/**
 * DEVELOPMENT-ONLY test harness (module is registered only when
 * NODE_ENV=development — see app.module.ts). Lets you exercise the full
 * agent loop before Telegram is connected:
 *
 *   POST /dev/clients  {"name":"Ali","timezone":"Asia/Riyadh"}   → test client
 *   POST /dev/chat     {"clientId":"...","message":"add a task"} → agent reply
 */
const createClientSchema = z.object({
  name: z.string().min(1),
  timezone: z.string().min(1).default('UTC'),
  assistantName: z.string().min(1).default('Assistant'),
});

const chatSchema = z.object({
  clientId: z.string().min(1),
  message: z.string().min(1).max(4000),
});

@Controller('dev')
export class DevController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly agent: AgentService,
  ) {}

  @Post('clients')
  async createClient(@Body() body: unknown): Promise<{ id: string; name: string }> {
    const input = createClientSchema.parse(body);
    // Reject invalid IANA timezones up front — a bad tz breaks time rendering.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
    } catch {
      throw new NotFoundException(`Unknown IANA timezone: ${input.timezone}`);
    }
    const client = await this.prisma.client.create({
      data: { ...input, homeTimezone: input.timezone },
    });
    return { id: client.id, name: client.name };
  }

  @Post('chat')
  async chat(@Body() body: unknown): Promise<{ reply: string }> {
    const input = chatSchema.parse(body);
    const client = await this.tenancy.getActiveClient(input.clientId);
    if (!client) throw new NotFoundException('No active client with that id');

    const repo = this.tenancy.repoFor(client.id);
    await repo.saveMessage({ direction: 'inbound', content: input.message });
    const reply = await this.agent.respond(client);
    await repo.saveMessage({ direction: 'outbound', content: reply });
    return { reply };
  }
}
