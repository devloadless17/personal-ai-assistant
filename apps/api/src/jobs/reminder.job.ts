import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CryptoService } from '../crypto/crypto.service';
import { TelegramService } from '../integrations/telegram/telegram.service';
import { PrismaService } from '../prisma/prisma.service';
import { formatInTz } from '../tools/time';
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

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
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
    }
  }

  async run(now: Date): Promise<void> {
    const due = await this.prisma.task.findMany({
      where: {
        reminderSent: false,
        reminderAt: { lte: now },
        status: 'open',
        client: { status: 'active', telegramChatId: { not: null } },
      },
      include: { client: true },
      take: 100,
      orderBy: { reminderAt: 'asc' },
    });
    this.lastDueCount = due.length;
    this.lastSentCount = 0;

    for (const task of due) {
      // Atomic claim — a concurrent/duplicate run can never double-send.
      const { count } = await this.prisma.task.updateMany({
        where: { id: task.id, reminderSent: false },
        data: { reminderSent: true },
      });
      if (count === 0) continue;

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
        this.lastSentCount += 1;
        this.logger.log(`Reminder sent for task ${task.id} (client ${client.id})`);
      } catch (err) {
        // Revert the claim so the next tick retries; alert on the failure.
        await this.prisma.task.updateMany({
          where: { id: task.id },
          data: { reminderSent: false },
        });
        this.logger.error(
          `Reminder send failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.alerts.alert(
          `reminder-${client.id}`,
          `Reminder delivery failing for client "${client.name}" — check their bot token/chat.`,
        );
      }
    }
  }
}
