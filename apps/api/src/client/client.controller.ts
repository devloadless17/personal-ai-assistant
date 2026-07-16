import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import type { ClientMe, PortalEvent, PortalMemory, PortalTask } from '@assistant/shared';
import { GoogleCalendarGateway } from '../integrations/google/google-calendar.gateway';
import { describeRecurrence } from '../tools/tasks.tools';
import { GoogleOAuthService } from '../integrations/google/google-oauth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenancyService } from '../tenancy/tenancy.service';
import type { Env } from '../config/env.validation';
import { ClientAuthGuard, type ClientRequest } from './client-auth.guard';
import { ClientAuthService } from './client-auth.service';

const rangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

// The client controls their own reminder lead time and daily-summary hour.
const preferencesSchema = z
  .object({
    defaultReminderMinutes: z.number().int().min(0).max(1440).optional(),
    dailyBriefHour: z.number().int().min(0).max(23).optional(),
  })
  .refine((v) => v.defaultReminderMinutes !== undefined || v.dailyBriefHour !== undefined, {
    message: 'Provide at least one preference to update.',
  });

const memoryUpdateSchema = z
  .object({
    value: z.string().min(1).max(2000).optional(),
    category: z.enum(['PROFILE', 'PREFERENCE', 'LONGTERM']).optional(),
  })
  .refine((v) => v.value !== undefined || v.category !== undefined, {
    message: 'Provide a value or category to update.',
  });

/**
 * Client self-service portal API. Every data route is guarded and reads the
 * clientId from the verified token — never from a path/param — so a client
 * can only ever see and change their OWN account.
 */
@Controller('client')
export class ClientController {
  constructor(
    private readonly auth: ClientAuthService,
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly google: GoogleOAuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ── Auth (Sign in with Google) ─────────────────────────────────────────────

  // Bounded per-IP: enough for real logins, a wall against state-map flooding.
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Get('auth/google/start')
  start(): { url: string } {
    return { url: this.auth.buildLoginUrl() };
  }

  /** Google redirects here; we mint a session token and hand off to the portal. */
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Get('auth/google/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const webUrl = this.config.get('PUBLIC_WEB_URL', { infer: true });
    if (error || !code || !state) {
      res.redirect(`${webUrl}/portal/login?error=${encodeURIComponent(error ?? 'cancelled')}`);
      return;
    }
    try {
      const { token } = await this.auth.completeLogin(code, state);
      // Token in the URL fragment: never sent to servers or written to logs.
      res.redirect(`${webUrl}/portal/auth#token=${encodeURIComponent(token)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      res.redirect(`${webUrl}/portal/login?error=${encodeURIComponent(msg)}`);
    }
  }

  // ── Portal data (all scoped to the authenticated client) ───────────────────

  @UseGuards(ClientAuthGuard)
  @Get('me')
  async me(@Req() req: ClientRequest): Promise<ClientMe> {
    const client = await this.prisma.client.findUnique({ where: { id: req.client.sub } });
    if (!client) throw new NotFoundException('Account not found');
    return {
      id: client.id,
      name: client.name,
      assistantName: client.assistantName,
      timezone: client.timezone,
      telegramConnected: Boolean(client.telegramBotTokenEnc),
      telegramBotUsername: client.telegramBotUsername,
      telegramDeepLink:
        client.telegramBotUsername && client.telegramBindCode
          ? `https://t.me/${client.telegramBotUsername}?start=${client.telegramBindCode}`
          : null,
      telegramChatBound: Boolean(client.telegramChatId),
      googleConnected: Boolean(client.googleOAuthEnc),
      googleNeedsReauth: client.googleNeedsReauth,
      defaultReminderMinutes: client.defaultReminderMinutes,
      dailyBriefHour: client.dailyBriefHour,
    };
  }

  /** The client sets their own reminder lead time and daily-summary hour. */
  @UseGuards(ClientAuthGuard)
  @Patch('preferences')
  async updatePreferences(@Req() req: ClientRequest, @Body() body: unknown): Promise<ClientMe> {
    const prefs = preferencesSchema.parse(body);
    await this.prisma.client.update({ where: { id: req.client.sub }, data: prefs });
    return this.me(req);
  }

  @UseGuards(ClientAuthGuard)
  @Get('tasks')
  async tasks(@Req() req: ClientRequest): Promise<PortalTask[]> {
    const repo = this.tenancy.repoFor(req.client.sub);
    const { tasks } = await repo.findTasks({ status: 'open', limit: 100 });
    return tasks.map((t) => ({
      id: t.id,
      title: t.title,
      type: t.type,
      status: t.status,
      dueAt: t.dueAt?.toISOString() ?? null,
      reminderAt: t.reminderAt?.toISOString() ?? null,
      notes: t.notes,
      recurrence: t.recurrenceFreq ? describeRecurrence(t) : null,
      recurrenceFreq: t.recurrenceFreq,
      recurrenceInterval: t.recurrenceInterval ?? 1,
      recurrenceWeekdays: t.recurrenceWeekdays,
      recurrenceUntil: t.recurrenceUntil?.toISOString() ?? null,
      recurrenceAnchor: t.recurrenceAnchor?.toISOString() ?? null,
    }));
  }

  // ── Memory (what the assistant knows — the client can view/edit/forget it) ──

  @UseGuards(ClientAuthGuard)
  @Get('memory')
  async memory(@Req() req: ClientRequest): Promise<PortalMemory[]> {
    const repo = this.tenancy.repoFor(req.client.sub);
    const memories = await repo.getMemories(200);
    return memories.map((m) => ({
      id: m.id,
      key: m.key,
      value: m.value,
      category: m.category,
    }));
  }

  @UseGuards(ClientAuthGuard)
  @Patch('memory/:id')
  async updateMemory(
    @Req() req: ClientRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PortalMemory> {
    const data = memoryUpdateSchema.parse(body);
    const repo = this.tenancy.repoFor(req.client.sub);
    const updated = await repo.updateMemory(id, data);
    if (!updated) throw new NotFoundException('Memory not found');
    return { id: updated.id, key: updated.key, value: updated.value, category: updated.category };
  }

  @UseGuards(ClientAuthGuard)
  @Delete('memory/:id')
  @HttpCode(200)
  async deleteMemory(
    @Req() req: ClientRequest,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    const repo = this.tenancy.repoFor(req.client.sub);
    const removed = await repo.deleteMemoryById(id);
    if (!removed) throw new NotFoundException('Memory not found');
    return { ok: true };
  }

  @UseGuards(ClientAuthGuard)
  @Get('calendar')
  async calendar(
    @Req() req: ClientRequest,
    @Query() query: unknown,
  ): Promise<{ connected: boolean; events: PortalEvent[] }> {
    const { from, to } = rangeSchema.parse(query);
    const client = await this.prisma.client.findUnique({ where: { id: req.client.sub } });
    if (!client) throw new NotFoundException('Account not found');

    const auth = await this.google.authorizedClientFor(client);
    if (!auth) return { connected: false, events: [] };

    const now = new Date();
    const start = from ? new Date(from) : now;
    const end = to ? new Date(to) : new Date(now.getTime() + 7 * 24 * 60 * 60_000);
    const gateway = new GoogleCalendarGateway(auth, client.timezone);
    const events = await gateway.listEvents({ from: start, to: end, limit: 50 });
    return {
      connected: true,
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start.toISOString(),
        end: e.end.toISOString(),
        allDay: e.allDay,
        location: e.location ?? null,
        attendees: e.attendees ?? [],
        recurring: e.recurring ?? false,
      })),
    };
  }

}
