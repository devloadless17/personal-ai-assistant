import { Injectable, Logger } from '@nestjs/common';
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
export class ReminderJob {
  private readonly logger = new Logger(ReminderJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly crypto: CryptoService,
    private readonly alerts: AdminAlertService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    try {
      await this.run(new Date());
    } catch (err) {
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
