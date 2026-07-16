import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Client, Prisma } from '@prisma/client';
import type { AuditLogEntry, ClientSummary, Paginated } from '@assistant/shared';
import { CryptoService } from '../crypto/crypto.service';
import { GoogleOAuthService } from '../integrations/google/google-oauth.service';
import { TelegramService } from '../integrations/telegram/telegram.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.validation';

function summarize(c: Client): ClientSummary {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    timezone: c.timezone,
    assistantName: c.assistantName,
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
    private readonly crypto: CryptoService,
    private readonly telegram: TelegramService,
    private readonly google: GoogleOAuthService,
    private readonly config: ConfigService<Env, true>,
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

  /**
   * Connects a client's Telegram bot: validates the token against the real
   * Bot API, stores it encrypted, generates a webhook secret, and registers
   * the webhook. Fails loudly on any step — no half-connected states.
   */
  async connectTelegram(id: string, botToken: string): Promise<{ botUsername: string }> {
    const client = await this.prisma.client.findUnique({ where: { id } });
    if (!client) throw new NotFoundException('Client not found');

    let botUsername: string;
    try {
      botUsername = (await this.telegram.getMe(botToken)).username;
    } catch {
      throw new BadRequestException('Telegram rejected that bot token — check it with @BotFather.');
    }

    const publicApiUrl = this.config.get('PUBLIC_API_URL', { infer: true });
    if (publicApiUrl.includes('localhost')) {
      throw new BadRequestException(
        'PUBLIC_API_URL is a localhost URL — Telegram webhooks need the public HTTPS domain (deploy first, or use a tunnel).',
      );
    }
    const secret = randomBytes(32).toString('hex');
    await this.telegram.setWebhook(botToken, `${publicApiUrl}/telegram/${id}`, secret);

    await this.prisma.client.update({
      where: { id },
      data: {
        telegramBotTokenEnc: this.crypto.encrypt(botToken),
        telegramWebhookSecretEnc: this.crypto.encrypt(secret),
        telegramChatId: null, // rebind on the next first message
      },
    });
    this.logger.log(`Telegram connected for client ${id} (@${botUsername})`);
    return { botUsername };
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
