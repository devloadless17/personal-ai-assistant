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
import { TimezoneService } from '../timezone/timezone.service';
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
    private readonly timezone: TimezoneService,
  ) {}

  /** Run once on boot so double-bookings are surfaced right after a deploy and
   * the job is immediately observable — de-dup makes the re-scan safe. */
  onApplicationBootstrap(): void {
    // Detached: don't let a boot sweep (which reads Google) delay/block
    // app.listen() + the health check. The cron runs it regardless.
    void this.tick();
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
      // Piggyback the periodic timezone sync here (this job already reads each
      // connected client's Google hourly). On an auto-detected move, tell the
      // client and use the fresh zone for the rest of this sweep.
      const tz = await this.timezone.sync(client);
      if (tz.synced && tz.switched) {
        client = { ...client, timezone: tz.to };
        const botToken = client.telegramBotTokenEnc
          ? this.crypto.decrypt(client.telegramBotTokenEnc)
          : null;
        if (botToken && client.telegramChatId) {
          await this.telegram.sendMessage(
            botToken,
            client.telegramChatId,
            `🌍 Looks like you're on ${tz.to} time now — I've switched your daily brief, reminders and new scheduling to match. Already-booked events keep their original time. Reply "keep home time" to stay on your home zone instead.`,
          );
        }
      }

      const auth = await this.google.authorizedClientFor(client);
      if (!auth) return;
      const gateway = new GoogleCalendarGateway(auth, client.timezone);

      // Keep companion reminders in sync with the LIVE calendar even when the
      // client edited the meeting directly in the Google app (bypassing the
      // bot). Isolated try/catch so a reconcile hiccup never suppresses the
      // conflict alerts below.
      try {
        await this.reconcileCompanions(client, gateway, now);
      } catch (err) {
        this.logger.error(
          `Reminder reconcile failed for client ${client.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const pairs = await gateway.findOverlappingPairs(now, new Date(now.getTime() + HORIZON_MS));
      if (pairs.length === 0) return;

      const botToken = client.telegramBotTokenEnc
        ? this.crypto.decrypt(client.telegramBotTokenEnc)
        : null;
      if (!botToken || !client.telegramChatId) return;

      for (const { a, b } of pairs) {
        const conflictKey = this.conflictKey(a, b);
        // Skip conflicts we've ALREADY alerted (one alert per distinct overlap).
        const already = await this.prisma.calendarConflictAlert.findFirst({
          where: { clientId: client.id, conflictKey },
          select: { id: true },
        });
        if (already) continue;

        const tz = client.timezone;
        const msg =
          `⚠️ Heads up — two things overlap on your calendar:\n` +
          `• ${a.title} (${formatInTz(a.start, tz)})\n` +
          `• ${b.title} (${formatInTz(b.start, tz)})\n` +
          `Want me to move one?`;
        // Send FIRST, record the de-dup row only AFTER a confirmed send. If
        // Telegram is down/rate-limited, the send throws → no row is written →
        // the conflict re-alerts next tick, instead of being silently buried
        // forever (the bug of recording the dedup before the send). A rare
        // duplicate on the tiny send-ok/write-fail window beats a lost alert —
        // the same durability rule the reminder lease uses.
        await this.telegram.sendMessage(botToken, client.telegramChatId, msg);
        try {
          await this.prisma.calendarConflictAlert.create({
            data: { clientId: client.id, conflictKey },
          });
        } catch (err) {
          // A concurrent tick already recorded it — harmless.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
        }
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

  /** Max companions reconciled per client per sweep — bounds the live Google
   * getEvent calls; anything beyond is picked up on the next shard tick. */
  private static readonly RECONCILE_CAP = 50;

  /**
   * Reconcile a client's companion reminders against their LIVE Google calendar,
   * so a reminder stays correct even when the meeting was edited directly in the
   * Google app (which never routes through the bot):
   *   • renamed meeting     → sync the ping's title
   *   • moved (one-off)      → re-time the ping to (new start − lead)
   *   • deleted/cancelled    → remove the orphaned ping
   *
   * Scope is deliberately safe:
   * - Only NEAR-TERM companions (next fire within the sweep horizon) are checked;
   *   further-out ones reconcile as they approach (this client is swept hourly).
   * - RECURRING series get title + orphan handling ONLY — the reminder cron's
   *   recurrence math owns each occurrence's fire time, so we never rewrite those.
   * - Orphan deletion is safe because getEvent() returns null ONLY for a
   *   cancelled/404/410 event; a transient Google error THROWS (caught, skipped),
   *   so a network blip can never delete a live reminder.
   */
  private async reconcileCompanions(
    client: Client,
    gateway: GoogleCalendarGateway,
    now: Date,
  ): Promise<void> {
    const horizonEnd = new Date(now.getTime() + HORIZON_MS);
    const companions = await this.prisma.task.findMany({
      where: {
        clientId: client.id,
        sourceEventId: { not: null },
        reminderSent: false,
        status: 'open',
        reminderAt: { not: null, lte: horizonEnd },
      },
      orderBy: { reminderAt: 'asc' },
      take: CalendarSweepJob.RECONCILE_CAP,
    });
    if (companions.length === 0) return;

    // Cache getEvent per source id — a meeting's several companions (e.g. 1h +
    // 10m before) share one event, so we fetch it once.
    const cache = new Map<string, CalendarEvent | null>();
    for (const c of companions) {
      const eventId = c.sourceEventId as string;
      if (!cache.has(eventId)) cache.set(eventId, await gateway.getEvent(eventId));
      const ev = cache.get(eventId) ?? null;

      if (ev === null) {
        // Source event genuinely gone (cancelled/404/410) → clear its orphan
        // reminder(s). Scoped to unsent rows for this event only.
        const { count } = await this.prisma.task.deleteMany({
          where: { clientId: client.id, sourceEventId: eventId, reminderSent: false },
        });
        if (count > 0)
          this.logger.log(
            `Cleared ${count} orphaned reminder(s) for deleted event ${eventId} (client ${client.id})`,
          );
        continue;
      }

      const patch: Prisma.TaskUpdateManyMutationInput = {};
      // Title drift — applies to one-off AND recurring (a title is series-wide).
      if (ev.title && ev.title !== c.title) patch.title = ev.title;
      // Time drift — one-off only. (getEvent on a recurring master returns the
      // series' FIRST start, not this companion's occurrence, so re-timing a
      // recurring companion from it would be wrong; the cron owns those.)
      if (!c.recurrenceFreq && c.reminderLeadMinutes != null && c.reminderAt) {
        const expected = new Date(ev.start.getTime() - c.reminderLeadMinutes * 60_000);
        if (Math.abs(expected.getTime() - c.reminderAt.getTime()) > 60_000) {
          patch.reminderAt = expected;
          patch.reminderClaimedAt = null; // release any stale lease so it re-fires cleanly
        }
      }
      if (Object.keys(patch).length > 0) {
        await this.prisma.task.updateMany({
          where: { id: c.id, clientId: client.id },
          data: patch,
        });
        this.logger.log(`Reconciled reminder ${c.id} to live event ${eventId} (client ${client.id})`);
      }
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
