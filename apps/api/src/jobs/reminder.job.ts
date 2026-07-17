import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Client, Task } from '@prisma/client';
import { mapWithConcurrency } from '../common/concurrency';
import { CryptoService } from '../crypto/crypto.service';
import { TelegramService } from '../integrations/telegram/telegram.service';
import { PrismaService } from '../prisma/prisma.service';
import { formatInTz, nextOccurrence } from '../tools/time';
import { AdminAlertService } from './admin-alert.service';

/**
 * Every minute: deliver due, unsent task reminders to each client's Telegram.
 *
 * Duplicate-safety: each reminder is CLAIMED first with an atomic
 * `updateMany(... reminderSent:false → true)`; only a successful claim sends.
 * If the send fails, the claim is reverted so the next tick retries.
 * A missed tick (restart, crash) is caught on the next one — `reminderAt <=
 * now` has no lower bound. The query is index-backed (reminderSent,
 * reminderAt): constant-time regardless of task history.
 */
@Injectable()
export class ReminderJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReminderJob.name);

  // Heartbeat/observability — surfaced by GET /admin/diagnostics so we can see
  // from the live API whether the cron is actually ticking in production.
  lastTickAt: Date | null = null;
  lastDueCount = 0;
  lastSentCount = 0;
  lastError: string | null = null;
  ticks = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly crypto: CryptoService,
    private readonly alerts: AdminAlertService,
  ) {}

  /** Catch up on any overdue reminders immediately on boot (e.g. after a
   * restart/redeploy), instead of waiting up to a minute for the first tick. */
  async onApplicationBootstrap(): Promise<void> {
    await this.tick();
  }

  /** Lease window: a claimed-but-unconfirmed reminder is re-claimable after
   * this long (covers a crash between claim and send). */
  private static readonly LEASE_MS = 3 * 60_000;
  /** Reminders delivered in parallel per batch. */
  private static readonly CONCURRENCY = 10;
  /** Rows claimed per batch; the tick drains multiple batches until empty. */
  private static readonly BATCH = 500;
  /** Wall-clock budget for one tick's drain; leftovers roll to the next tick. */
  private static readonly DRAIN_BUDGET_MS = 45_000;
  /** Prevents a long tick from overlapping the next — avoids doubled load and
   * heartbeat clobber. */
  private running = false;

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.warn('Previous reminder tick still running — skipping this one.');
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
        `Reminder tick failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      await this.alerts.alert('reminder-tick', 'Reminder job tick failed — check API logs.');
    } finally {
      this.running = false;
    }
  }

  async run(now: Date): Promise<void> {
    const leaseCutoff = new Date(now.getTime() - ReminderJob.LEASE_MS);
    const deadline = now.getTime() + ReminderJob.DRAIN_BUDGET_MS;
    this.lastDueCount = 0;
    this.lastSentCount = 0;
    // DRAIN loop: keep claiming batches until nothing is due (or the wall-clock
    // budget is hit — leftovers roll to the next tick). Prevents a burst of
    // reminders that all come due at the same minute from shipping late. Each
    // batch's rows are independently leased, so larger batches stay safe.
    for (;;) {
      const due = await this.prisma.task.findMany({
        where: {
          reminderSent: false,
          reminderAt: { lte: now },
          status: 'open',
          client: { status: 'active', telegramChatId: { not: null } },
          // Skip reminders another live tick just claimed; re-claim stale leases.
          OR: [{ reminderClaimedAt: null }, { reminderClaimedAt: { lt: leaseCutoff } }],
        },
        include: { client: true },
        take: ReminderJob.BATCH,
        orderBy: { reminderAt: 'asc' },
      });
      if (due.length === 0) break;
      this.lastDueCount += due.length;
      await mapWithConcurrency(due, ReminderJob.CONCURRENCY, (task) =>
        this.deliver(task, now, leaseCutoff),
      );
      if (due.length < ReminderJob.BATCH || Date.now() >= deadline) break;
    }
  }

  private async deliver(
    task: Task & { client: Client },
    now: Date,
    leaseCutoff: Date,
  ): Promise<void> {
    // Atomic LEASE (not a final commit): claim only if still unsent and not
    // freshly claimed by a concurrent tick. reminderSent stays false until
    // delivery is CONFIRMED, so a crash after this point loses nothing — a
    // later tick re-claims the expired lease. At-least-once by design.
    const { count } = await this.prisma.task.updateMany({
      where: {
        id: task.id,
        reminderSent: false,
        OR: [{ reminderClaimedAt: null }, { reminderClaimedAt: { lt: leaseCutoff } }],
      },
      data: { reminderClaimedAt: now },
    });
    if (count === 0) return;

    const { client } = task;
    try {
      const botToken = client.telegramBotTokenEnc
        ? this.crypto.decrypt(client.telegramBotTokenEnc)
        : null;
      if (!botToken || !client.telegramChatId) {
        throw new Error('client has no bot token or bound chat');
      }
      const when = task.dueAt ? ` (due ${formatInTz(task.dueAt, client.timezone)})` : '';
      await this.telegram.sendMessage(
        botToken,
        client.telegramChatId,
        `⏰ Reminder: ${task.title}${when}`,
      );
      // Delivery CONFIRMED — recurring reminders roll forward to their next
      // occurrence; one-shots are marked permanently sent.
      await this.advanceOrComplete(task, client.timezone, now);
      this.lastSentCount += 1;
      this.logger.log(`Reminder sent for task ${task.id} (client ${client.id})`);
    } catch (err) {
      // KEEP the lease (do NOT null it): reminderSent stays false, but the row
      // stays claimed so it's excluded until the lease expires (~3 min) — natural
      // backoff. Nulling it here would let the same-tick drain loop re-fetch the
      // failing batch immediately and hot-spin for the whole budget, starving
      // other due reminders. At-least-once still holds (retry after lease expiry).
      this.logger.error(
        `Reminder send failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.alerts.alert(
        `reminder-${client.id}`,
        `Reminder delivery failing for client "${client.name}" — check their bot token/chat.`,
      );
    }
  }

  /**
   * After a confirmed send: a recurring reminder re-arms the SAME row to its
   * next occurrence (reminderSent back to false, lease cleared); a one-shot (or
   * a series that has passed `recurrenceUntil`) is marked permanently sent.
   * Any failure to compute the next occurrence falls back to marking sent, so a
   * row can never get stuck re-sending.
   */
  private async advanceOrComplete(task: Task, timezone: string, now: Date): Promise<void> {
    let computeFailed = false;
    try {
      if (task.recurrenceFreq && task.reminderAt) {
        // Advance to the FIRST occurrence strictly after now — so an outage that
        // skipped many occurrences fires ONE ping (this send) and re-arms for the
        // future, not a burst of stale pings. Bounded by a hard cap.
        let next = nextOccurrence(
          task.reminderAt,
          task.recurrenceFreq,
          task.recurrenceInterval ?? 1,
          task.recurrenceWeekdays,
          timezone,
          task.recurrenceAnchor,
        );
        for (let i = 0; i < 1000 && next.getTime() <= now.getTime(); i++) {
          const after = nextOccurrence(
            next,
            task.recurrenceFreq,
            task.recurrenceInterval ?? 1,
            task.recurrenceWeekdays,
            timezone,
            task.recurrenceAnchor,
          );
          if (after.getTime() <= next.getTime()) break; // safety: no progress
          next = after;
        }
        const beyondUntil =
          task.recurrenceUntil != null && next.getTime() > task.recurrenceUntil.getTime();
        if (!beyondUntil && next.getTime() > task.reminderAt.getTime()) {
          const deltaMs = next.getTime() - task.reminderAt.getTime();
          await this.prisma.task.updateMany({
            where: { id: task.id },
            data: {
              reminderAt: next,
              ...(task.dueAt ? { dueAt: new Date(task.dueAt.getTime() + deltaMs) } : {}),
              reminderSent: false,
              reminderClaimedAt: null,
            },
          });
          return;
        }
      }
    } catch (err) {
      computeFailed = true;
      this.logger.error(
        `Failed to compute next occurrence for recurring task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Don't silently convert a recurring series into a one-shot on a compute
      // error (e.g. a bad timezone): mark this send done but KEEP the recurrence
      // fields intact and alert the admin so it can be repaired, not lost.
      await this.alerts.alert(
        'reminder-recurrence',
        `Couldn't compute the next occurrence for a recurring reminder (task ${task.id}) — its recurrence is paused; check the client's timezone.`,
      );
    }
    // One-shot fired, or a recurring SERIES that has ended (past `until`). A
    // finished series is also marked done + recurrence cleared so it doesn't
    // linger as a perpetual open item — but NOT on a compute failure, where we
    // preserve the recurrence for repair.
    await this.prisma.task.updateMany({
      where: { id: task.id },
      data: task.recurrenceFreq && !computeFailed
        ? { reminderSent: true, status: 'done', recurrenceFreq: null }
        : { reminderSent: true },
    });
  }
}
