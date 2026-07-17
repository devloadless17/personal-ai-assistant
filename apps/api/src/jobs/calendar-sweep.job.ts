import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import type { Client } from '@prisma/client';
import { mapWithConcurrency } from '../common/concurrency';
import { CryptoService } from '../crypto/crypto.service';
import { GoogleCalendarGateway } from '../integrations/google/google-calendar.gateway';
import { GoogleOAuthService } from '../integrations/google/google-oauth.service';
import { TelegramService } from '../integrations/telegram/telegram.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CalendarEvent } from '../tools/tool.types';
import { formatInTz } from '../tools/time';
import { AdminAlertService } from './admin-alert.service';

/** Look-ahead window for double-booking detection. */
const HORIZON_MS = 48 * 60 * 60_000;
/** How many clients to sweep in parallel (each does a live Google read). */
const CONCURRENCY = 6;
/** Shard clients across ticks: with a 10-min cron, each client is swept once
 * per SHARDS ticks (= hourly at 6), keeping steady-state Google load ~1/6. */
const SHARDS = 6;
/** Delete alert de-dup rows older than this (must exceed HORIZON so a live
 * conflict never loses its de-dup row and re-alerts). */
const ALERT_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Stable non-negative hash of a client id, for tick sharding. */
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Every ~10 min: read each Google-connected client's live calendar for the near
 * horizon and PROACTIVELY alert them on Telegram if two timed events overlap —
 * even if the conflicting event was added directly in the Google Calendar app
 * (which the on-demand booking check never sees until they next ask).
 *
 * Idempotent: each distinct conflict is de-duplicated by a unique
 * (clientId, conflictKey), so a persisting overlap is alerted ONCE, not every
 * tick. Reuses the "live reads, no mirror" model — no Google watch channels.
 */
@Injectable()
export class CalendarSweepJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(CalendarSweepJob.name);

  // Heartbeat/observability — surfaced by GET /admin/diagnostics.
  lastTickAt: Date | null = null;
  lastAlertCount = 0;
  lastError: string | null = null;
  ticks = 0;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleOAuthService,
    private readonly crypto: CryptoService,
    private readonly telegram: TelegramService,
    private readonly alerts: AdminAlertService,
  ) {}

  /** Run once on boot so double-bookings are surfaced right after a deploy and
   * the job is immediately observable — de-dup makes the re-scan safe. */
  async onApplicationBootstrap(): Promise<void> {
    await this.tick();
  }

  @Cron('*/10 * * * *')
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('Previous calendar-sweep tick still running — skipping this one.');
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
        `Calendar-sweep tick failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      await this.alerts.alert('sweep-tick', 'Calendar sweep job tick failed — check API logs.');
    } finally {
      this.running = false;
    }
  }

  async run(now: Date): Promise<void> {
    // Prune stale de-dup rows (older than retention) so the table can't grow
    // unbounded; index-backed by (alertedAt).
    await this.prisma.calendarConflictAlert.deleteMany({
      where: { alertedAt: { lt: new Date(now.getTime() - ALERT_RETENTION_MS) } },
    });

    // Two-phase for scale: phase 1 pulls only ids to pick this tick's shard,
    // phase 2 loads full rows (encrypted tokens/OAuth) for the shard only.
    const ids = await this.prisma.client.findMany({
      where: {
        status: 'active',
        telegramChatId: { not: null },
        googleOAuthEnc: { not: null },
      },
      select: { id: true },
    });
    // Shard across ticks: each tick sweeps only ~1/SHARDS of clients (every
    // client swept once per SHARDS ticks), so a large client base doesn't do a
    // full-base live-Google scan every 10 min.
    const slot = this.ticks % SHARDS;
    const mineIds = ids.filter((c) => hashId(c.id) % SHARDS === slot).map((c) => c.id);
    this.lastAlertCount = 0;
    if (mineIds.length === 0) return;
    const mine = await this.prisma.client.findMany({ where: { id: { in: mineIds } } });
    await mapWithConcurrency(mine, CONCURRENCY, (client) => this.sweepClient(client, now));
  }

  private async sweepClient(client: Client, now: Date): Promise<void> {
    try {
      const auth = await this.google.authorizedClientFor(client);
      if (!auth) return;
      const gateway = new GoogleCalendarGateway(auth, client.timezone);
      const pairs = await gateway.findOverlappingPairs(now, new Date(now.getTime() + HORIZON_MS));
      if (pairs.length === 0) return;

      const botToken = client.telegramBotTokenEnc
        ? this.crypto.decrypt(client.telegramBotTokenEnc)
        : null;
      if (!botToken || !client.telegramChatId) return;

      for (const { a, b } of pairs) {
        const conflictKey = this.conflictKey(a, b);
        // Atomic de-dup: unique(clientId, conflictKey). If we've already alerted
        // this exact conflict, the insert hits P2002 and we skip — one alert per
        // distinct overlap, never a per-tick repeat.
        try {
          await this.prisma.calendarConflictAlert.create({
            data: { clientId: client.id, conflictKey },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
          throw err;
        }
        const tz = client.timezone;
        const msg =
          `⚠️ Heads up — two things overlap on your calendar:\n` +
          `• ${a.title} (${formatInTz(a.start, tz)})\n` +
          `• ${b.title} (${formatInTz(b.start, tz)})\n` +
          `Want me to move one?`;
        await this.telegram.sendMessage(botToken, client.telegramChatId, msg);
        this.lastAlertCount += 1;
        this.logger.log(`Conflict alert sent to client ${client.id}`);
      }
    } catch (err) {
      this.logger.error(
        `Calendar sweep failed for client ${client.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Throttled admin alert (1/hr/key) so a client whose Google auth/read
      // persistently fails is surfaced, not silently un-swept.
      await this.alerts.alert(
        `sweep-${client.id}`,
        `Calendar sweep failing for client "${client.name}" — check their Google connection.`,
      );
    }
  }

  /** Stable key for a conflicting pair (order-independent), so it re-alerts only
   * if an event actually moves to a different time. */
  private conflictKey(a: CalendarEvent, b: CalendarEvent): string {
    return [`${a.id}@${a.start.toISOString()}`, `${b.id}@${b.start.toISOString()}`]
      .sort()
      .join('||');
  }
}
