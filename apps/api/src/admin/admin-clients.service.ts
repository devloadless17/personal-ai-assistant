import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Client, Prisma } from '@prisma/client';
import type { AuditLogEntry, ClientSummary, Paginated } from '@assistant/shared';
import { GoogleOAuthService } from '../integrations/google/google-oauth.service';
import { TelegramConnectionService } from '../integrations/telegram/telegram-connection.service';
import { PrismaService } from '../prisma/prisma.service';

function summarize(c: Client): ClientSummary {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    timezone: c.timezone,
    assistantName: c.assistantName,
    email: c.email,
    telegramConnected: Boolean(c.telegramBotTokenEnc),
    googleConnected: Boolean(c.googleOAuthEnc),
    googleNeedsReauth: c.googleNeedsReauth,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Admin-side client management. Secrets go in encrypted, never come back out. */
@Injectable()
export class AdminClientsService {
  private readonly logger = new Logger(AdminClientsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramConnection: TelegramConnectionService,
    private readonly google: GoogleOAuthService,
  ) {}

  async list(): Promise<ClientSummary[]> {
    const clients = await this.prisma.client.findMany({ orderBy: { createdAt: 'desc' } });
    return clients.map(summarize);
  }

  async get(id: string): Promise<ClientSummary> {
    const client = await this.prisma.client.findUnique({ where: { id } });
    if (!client) throw new NotFoundException('Client not found');
    return summarize(client);
  }

  async create(data: {
    name: string;
    timezone: string;
    assistantName: string;
    email?: string;
    dailyBriefHour?: number;
  }): Promise<ClientSummary> {
    this.assertValidTimezone(data.timezone);
    const client = await this.prisma.client.create({ data });
    this.logger.log(`Client created: ${client.id} (${client.name})`);
    return summarize(client);
  }

  async update(
    id: string,
    data: Partial<{
      name: string;
      timezone: string;
      assistantName: string;
      email: string;
      status: 'active' | 'disabled';
      dailyBriefHour: number;
    }>,
  ): Promise<ClientSummary> {
    if (data.timezone) this.assertValidTimezone(data.timezone);
    try {
      const client = await this.prisma.client.update({ where: { id }, data });
      return summarize(client);
    } catch {
      throw new NotFoundException('Client not found');
    }
  }

  /** Connect a client's Telegram bot (shared with the client portal). */
  async connectTelegram(id: string, botToken: string): Promise<{ botUsername: string }> {
    return this.telegramConnection.connect(id, botToken);
  }

  /** Admin fetches this URL and sends it to the client (e.g. via their bot). */
  googleConnectUrl(id: string): { url: string } {
    if (!this.google.isConfigured) {
      throw new BadRequestException(
        'Google OAuth is not configured — set GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI.',
      );
    }
    return { url: this.google.buildConnectUrl(id) };
  }

  /** Cursor-paginated audit log — (createdAt, id) tiebreaker, never "all". */
  async auditLog(
    id: string,
    opts: { cursor?: string; limit?: number; success?: boolean },
  ): Promise<Paginated<AuditLogEntry>> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const where: Prisma.AuditLogWhereInput = { clientId: id };
    if (opts.success !== undefined) where.success = opts.success;

    if (opts.cursor) {
      const [ts, cid] = opts.cursor.split('|');
      if (!ts || !cid || Number.isNaN(Date.parse(ts))) {
        throw new BadRequestException('Malformed cursor');
      }
      where.OR = [
        { createdAt: { lt: new Date(ts) } },
        { createdAt: new Date(ts), id: { lt: cid } },
      ];
    }

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        toolName: r.toolName,
        input: r.input,
        result: r.result,
        success: r.success,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  }

  async usage(id: string): Promise<{
    messagesIn: number;
    messagesOut: number;
    toolCalls: number;
    toolFailures: number;
    lastActivity: string | null;
  }> {
    const [messagesIn, messagesOut, toolCalls, toolFailures, lastMsg] = await Promise.all([
      this.prisma.message.count({ where: { clientId: id, direction: 'inbound' } }),
      this.prisma.message.count({ where: { clientId: id, direction: 'outbound' } }),
      this.prisma.auditLog.count({ where: { clientId: id } }),
      this.prisma.auditLog.count({ where: { clientId: id, success: false } }),
      this.prisma.message.findFirst({
        where: { clientId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true },
      }),
    ]);
    return {
      messagesIn,
      messagesOut,
      toolCalls,
      toolFailures,
      lastActivity: lastMsg?.createdAt.toISOString() ?? null,
    };
  }

  private assertValidTimezone(tz: string): void {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      throw new BadRequestException(`Unknown IANA timezone: ${tz}`);
    }
  }
}
