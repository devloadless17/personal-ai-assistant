import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import type { ClientMe, PortalEvent, PortalTask } from '@assistant/shared';
import { GoogleCalendarGateway } from '../integrations/google/google-calendar.gateway';
import { GoogleOAuthService } from '../integrations/google/google-oauth.service';
import { TelegramConnectionService } from '../integrations/telegram/telegram-connection.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenancyService } from '../tenancy/tenancy.service';
import type { Env } from '../config/env.validation';
import { ClientAuthGuard, type ClientRequest } from './client-auth.guard';
import { ClientAuthService } from './client-auth.service';

const connectTelegramSchema = z.object({ botToken: z.string().min(20) });
const rangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
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
    private readonly telegramConnection: TelegramConnectionService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ── Auth (Sign in with Google) ─────────────────────────────────────────────

  @SkipThrottle()
  @Get('auth/google/start')
  start(): { url: string } {
    return { url: this.auth.buildLoginUrl() };
  }

  /** Google redirects here; we mint a session token and hand off to the portal. */
  @SkipThrottle()
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
      googleConnected: Boolean(client.googleOAuthEnc),
      googleNeedsReauth: client.googleNeedsReauth,
    };
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
    }));
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
      })),
    };
  }

  @UseGuards(ClientAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('telegram')
  async connectTelegram(
    @Req() req: ClientRequest,
    @Body() body: unknown,
  ): Promise<{ botUsername: string }> {
    const { botToken } = connectTelegramSchema.parse(body);
    return this.telegramConnection.connect(req.client.sub, botToken);
  }
}
