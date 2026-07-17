import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Client, Prisma } from '@prisma/client';
import type {
  AuditLogEntry,
  ClientSummary,
  ConversationMessage,
  Paginated,
} from '@assistant/shared';
import { GoogleOAuthService } from '../integrations/google/google-oauth.service';
import { TelegramConnectionService } from '../integrations/telegram/telegram-connection.service';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeReminderLeads } from '../tenancy/client-scoped-repository';

function summarize(c: Client): ClientSummary {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    timezone: c.timezone,
    assistantName: c.assistantName,
    email: c.email,
    telegramConnected: Boolean(c.telegramBotTokenEnc),
    telegramBotUsername: c.telegramBotUsername,
    telegramDeepLink:
      c.telegramBotUsername && c.telegramBindCode
        ? `https://t.me/${c.telegramBotUsername}?start=${c.telegramBindCode}`
        : null,
    telegramChatBound: Boolean(c.telegramChatId),
    googleConnected: Boolean(c.googleOAuthEnc),
    googleNeedsReauth: c.googleNeedsReauth,
    reminderLeads: c.reminderLeads,
    defaultMeetingMinutes: c.defaultMeetingMinutes,
    dailyBriefHour: c.dailyBriefHour,
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
    // Capped + index-backed (Client.createdAt). The admin manages tens of
    // clients; a hard cap keeps this bounded if the roster ever grows large.
    const clients = await this.prisma.client.findMany({
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
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
    reminderLeads?: number[];
    defaultMeetingMinutes?: number;
    dailyBriefHour?: number;
  }): Promise<ClientSummary> {
    this.assertValidTimezone(data.timezone);
    // Seed homeTimezone from the initial zone so travel detection + "back home"
    // work immediately for new clients (the migration backfills existing rows).
    const client = await this.prisma.client.create({
      data: {
        ...data,
        homeTimezone: data.timezone,
        ...(data.reminderLeads ? { reminderLeads: normalizeReminderLeads(data.reminderLeads) } : {}),
      },
    });
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
      reminderLeads: number[];
      defaultMeetingMinutes: number;
      dailyBriefHour: number;
    }>,
  ): Promise<ClientSummary> {
    if (data.timezone) this.assertValidTimezone(data.timezone);
    try {
      // An admin setting the timezone is authoritatively (re)setting the base
      // zone → keep homeTimezone in step so "back home" and away-detection align.
      const client = await this.prisma.client.update({
        where: { id },
        data: {
          ...data,
          ...(data.timezone ? { homeTimezone: data.timezone } : {}),
          ...(data.reminderLeads ? { reminderLeads: normalizeReminderLeads(data.reminderLeads) } : {}),
        },
      });
      return summarize(client);
    } catch {
      throw new NotFoundException('Client not found');
    }
  }

  /** Connect a client's Telegram bot (admin-only — the admin holds the token). */
  async connectTelegram(id: string, botToken: string): Promise<{ botUsername: string }> {
    return this.telegramConnection.connect(id, botToken);
  }

  /** Clear the bound Telegram chat so the intended client can (re)bind. */
  async resetTelegramBinding(id: string): Promise<void> {
    const client = await this.prisma.client.findUnique({ where: { id } });
    if (!client) throw new NotFoundException('Client not found');
    await this.telegramConnection.resetChatBinding(id);
  }

  /**
   * Permanently delete a client and ALL their data (tasks, messages, memories,
   * and audit history). Deliberate and irreversible — the UI confirms first.
   * Silences the client's bot, then deletes atomically. Audit rows are removed
   * inside the transaction (the RESTRICT FK guards against accidental cascade,
   * not against this explicit, owner-initiated removal).
   */
  async deleteClient(id: string): Promise<void> {
    const client = await this.prisma.client.findUnique({ where: { id } });
    if (!client) throw new NotFoundException('Client not found');

    // Delete first — only silence the bot AFTER the delete actually commits, so
    // a rolled-back transaction never leaves a live client with a dead webhook.
    await this.prisma.$transaction([
      this.prisma.auditLog.deleteMany({ where: { clientId: id } }),
      // Tasks, memories, messages cascade on client delete.
      this.prisma.client.delete({ where: { id } }),
    ]);
    await this.telegramConnection.removeWebhook(client.telegramBotTokenEnc);
    this.logger.warn(`Client permanently deleted: ${id} (${client.name})`);
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

  /** Cursor-paginated conversation history (newest first) for a client — the
   * admin's window into how clients actually talk to the assistant, to improve
   * it. Same (createdAt, id) keyset pattern as the audit log. */
  async conversation(
    id: string,
    opts: { cursor?: string; limit?: number },
  ): Promise<Paginated<ConversationMessage>> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: Prisma.MessageWhereInput = { clientId: id };
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
    const rows = await this.prisma.message.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        direction: r.direction,
        content: r.content,
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
