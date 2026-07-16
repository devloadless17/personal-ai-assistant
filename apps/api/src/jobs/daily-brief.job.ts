import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Client } from '@prisma/client';
import { mapWithConcurrency } from '../common/concurrency';
import { CryptoService } from '../crypto/crypto.service';
import { GoogleOAuthService } from '../integrations/google/google-oauth.service';
import { GoogleCalendarGateway } from '../integrations/google/google-calendar.gateway';
import { TelegramService } from '../integrations/telegram/telegram.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { endOfTodayInTz, formatInTz, startOfTodayInTz } from '../tools/time';
import { AdminAlertService } from './admin-alert.service';

/** How many clients to build+send briefs for in parallel. */
const BRIEF_CONCURRENCY = 6;

/**
 * Per-client, timezone-aware morning brief: today's LIVE calendar (including
 * events added directly in the Calendar app) + today's/overdue open tasks.
 *
 * Runs every 10 minutes; a client gets their brief in the first tick at or
 * after their local `dailyBriefHour`. Idempotency: `lastBriefDate` (local
 * "YYYY-MM-DD") is CLAIMED atomically before sending, and reverted if the
 * send fails — restarts and re-runs can never double-send.
 *
 * The brief is assembled deterministically (no LLM) — a scheduled factual
 * digest must be exactly right, every time.
 */
@Injectable()
export class DailyBriefJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(DailyBriefJob.name);

  // Heartbeat/observability — surfaced by GET /admin/diagnostics.
  lastTickAt: Date | null = null;
  lastSentCount = 0;
  lastError: string | null = null;
  ticks = 0;
  /** Prevents a slow tick from overlapping the next 10-minute tick. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly telegram: TelegramService,
    private readonly crypto: CryptoService,
    private readonly google: GoogleOAuthService,
    private readonly alerts: AdminAlertService,
  ) {}

  /** After any restart/redeploy, check briefs immediately — so a deploy landing
   * right at a client's brief hour doesn't skip that day's brief entirely. The
   * once-per-day claim keeps this from double-sending. */
  async onApplicationBootstrap(): Promise<void> {
    await this.tick();
  }

  @Cron('*/10 * * * *')
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('Previous daily-brief tick still running — skipping this one.');
      return;
    }
    this.running = true;
    this.lastTickAt = new Date();
    this.ticks += 1;
    try {
      await this.run(this.lastTickAt);
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Daily-brief tick failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      await this.alerts.alert('brief-tick', 'Daily brief job tick failed — check API logs.');
    } finally {
      this.running = false;
    }
  }

  async run(now: Date): Promise<void> {
    const clients = await this.prisma.client.findMany({
      where: { status: 'active', telegramChatId: { not: null } },
    });
    this.lastSentCount = 0;
    // Bounded concurrency: each due client does a live Google read + send, so
    // process several in parallel instead of serially (avoids overrunning the
    // 10-min tick as the client base grows). The atomic per-client claim keeps
    // this safe.
    await mapWithConcurrency(clients, BRIEF_CONCURRENCY, (client) => this.processClient(client, now));
  }

  private async processClient(client: Client, now: Date): Promise<void> {
    const localDate = this.localDate(now, client.timezone);
    const localHour = this.localHour(now, client.timezone);
    if (localHour < client.dailyBriefHour) return;
    if (client.lastBriefDate === localDate) return;

    // Atomic claim on (id, lastBriefDate != today). Must handle the never-sent
    // case EXPLICITLY: in SQL `NOT (lastBriefDate = today)` is NULL (not true)
    // when lastBriefDate IS NULL, so a `NOT: {...}` form would never match a
    // first-ever brief and the client would be skipped forever. The OR covers
    // both "never sent" and "sent on a previous day".
    const { count } = await this.prisma.client.updateMany({
      where: {
        id: client.id,
        OR: [{ lastBriefDate: null }, { lastBriefDate: { not: localDate } }],
      },
      data: { lastBriefDate: localDate },
    });
    if (count === 0) return;

    try {
      const text = await this.buildBrief(client, now);
      const botToken = client.telegramBotTokenEnc
        ? this.crypto.decrypt(client.telegramBotTokenEnc)
        : null;
      if (!botToken || !client.telegramChatId) {
        throw new Error('client has no bot token or bound chat');
      }
      await this.telegram.sendMessage(botToken, client.telegramChatId, text);
      this.lastSentCount += 1;
      this.logger.log(`Daily brief sent to client ${client.id} (${localDate})`);
    } catch (err) {
      // Revert the claim so a later tick today retries.
      await this.prisma.client.updateMany({
        where: { id: client.id, lastBriefDate: localDate },
        data: { lastBriefDate: client.lastBriefDate },
      });
      this.logger.error(
        `Daily brief failed for client ${client.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.alerts.alert(`brief-${client.id}`, `Daily brief failing for client "${client.name}".`);
    }
  }

  /** Deterministic brief: live calendar + open tasks, all in the client's tz. */
  private async buildBrief(client: Client, now: Date): Promise<string> {
    const tz = client.timezone;
    const dayStart = startOfTodayInTz(now, tz);
    const dayEnd = endOfTodayInTz(now, tz); // DST-exact (not a fixed +24h)
    const repo = this.tenancy.repoFor(client.id);

    // Greeting matches the LOCAL time the client scheduled their summary for —
    // "Good morning" is wrong for a 7 PM digest.
    const hour = this.localHour(now, tz);
    const greeting =
      hour < 12
        ? '☀️ Good morning'
        : hour < 18
          ? '👋 Good afternoon'
          : '🌆 Good evening';
    const lines: string[] = [`${greeting}, ${client.name}! Here's your day:`];

    // Calendar — live read; failure is stated, never hidden.
    try {
      const auth = await this.google.authorizedClientFor(client);
      if (auth) {
        const gateway = new GoogleCalendarGateway(auth, tz);
        const events = await gateway.listEvents({ from: dayStart, to: dayEnd, limit: 25 });
        lines.push('', '📅 Calendar:');
        if (events.length === 0) {
          lines.push('  Nothing scheduled — a clear calendar today.');
        } else {
          for (const e of events) {
            const time = e.allDay
              ? 'All day'
              : formatInTz(e.start, tz).split(', ').pop() ?? '';
            lines.push(`  • ${time} — ${e.title}${e.location ? ` (${e.location})` : ''}`);
          }
        }
      }
    } catch {
      lines.push('', '📅 Calendar: couldn’t be read right now — check it directly today.');
    }

    // Tasks — overdue and today fetched SEPARATELY (each capped), so a big
    // backlog of overdue items can never crowd today's tasks out of the window
    // (a single dueTo query orders oldest-first and would fill all 25 slots
    // with stale overdue, hiding today's — the exact bug this avoids).
    const [overdueRes, todayRes] = await Promise.all([
      repo.findTasks({ status: 'open', dueTo: dayStart, includeUndated: false, limit: 25 }),
      repo.findTasks({ status: 'open', dueFrom: dayStart, dueTo: dayEnd, includeUndated: false, limit: 25 }),
    ]);
    const overdue = overdueRes.tasks.filter((t) => t.dueAt && t.dueAt < dayStart);
    const today = todayRes.tasks.filter((t) => t.dueAt && t.dueAt >= dayStart);
    if (overdue.length > 0) {
      lines.push('', '⚠️ Overdue:');
      for (const t of overdue) lines.push(`  • ${t.title} (was due ${formatInTz(t.dueAt as Date, tz)})`);
    }
    lines.push('', '✅ Tasks due today:');
    if (today.length === 0) {
      lines.push('  None due today.');
    } else {
      for (const t of today) {
        const time = formatInTz(t.dueAt as Date, tz).split(', ').pop() ?? '';
        lines.push(`  • ${t.title} — ${time}`);
      }
    }

    return lines.join('\n');
  }

  private localDate(now: Date, tz: string): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }

  private localHour(now: Date, tz: string): number {
    return Number(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(
        now,
      ),
    );
  }
}
