import { ReminderJob } from './reminder.job';
import type { PrismaService } from '../prisma/prisma.service';
import type { TelegramService } from '../integrations/telegram/telegram.service';
import type { CryptoService } from '../crypto/crypto.service';
import type { AdminAlertService } from './admin-alert.service';

const CLIENT = {
  id: 'c1',
  name: 'Test',
  status: 'active',
  timezone: 'UTC',
  telegramBotTokenEnc: 'enc',
  telegramChatId: '777',
};

function makeJob(opts?: { sendFails?: boolean; claimFails?: boolean }): {
  job: ReminderJob;
  sent: string[];
  updates: { where: unknown; data: unknown }[];
  alerts: string[];
} {
  const sent: string[] = [];
  const updates: { where: unknown; data: unknown }[] = [];
  const alerts: string[] = [];

  const prisma = {
    task: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 't1',
          title: 'Call the bank',
          dueAt: new Date('2026-07-16T10:00:00Z'),
          reminderAt: new Date('2026-07-16T09:55:00Z'),
          reminderSent: false,
          client: CLIENT,
        },
      ]),
      updateMany: jest.fn().mockImplementation((args: { where: unknown; data: unknown }) => {
        updates.push(args);
        // The lease CLAIM sets reminderClaimedAt to a Date; simulate a lost race
        // (another tick already holds the lease) if claimFails.
        const data = args.data as { reminderClaimedAt?: Date | null };
        const isClaim = 'reminderClaimedAt' in data && data.reminderClaimedAt != null;
        return Promise.resolve({ count: isClaim && opts?.claimFails ? 0 : 1 });
      }),
    },
  } as unknown as PrismaService;

  const telegram = {
    sendMessage: jest.fn().mockImplementation((_t: string, _c: string, text: string) => {
      if (opts?.sendFails) return Promise.reject(new Error('telegram down'));
      sent.push(text);
      return Promise.resolve();
    }),
  } as unknown as TelegramService;

  const crypto = { decrypt: () => 'bot-token' } as unknown as CryptoService;
  const alertsSvc = {
    alert: jest.fn().mockImplementation((_k: string, msg: string) => {
      alerts.push(msg);
      return Promise.resolve();
    }),
  } as unknown as AdminAlertService;

  return { job: new ReminderJob(prisma, telegram, crypto, alertsSvc), sent, updates, alerts };
}

describe('ReminderJob — at-least-once lease/send/confirm', () => {
  it('leases the reminder, sends it, then confirms sent ONLY after delivery', async () => {
    const { job, sent, updates } = makeJob();
    await job.run(new Date('2026-07-16T10:00:00Z'));
    // First update = lease claim: sets reminderClaimedAt, NOT reminderSent, and
    // its WHERE is lease-aware (unsent + no/expired lease) so it's re-claimable.
    const claim = updates[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect((claim.data as { reminderClaimedAt?: Date }).reminderClaimedAt).toEqual(
      new Date('2026-07-16T10:00:00Z'),
    );
    expect((claim.where as { reminderSent?: boolean }).reminderSent).toBe(false);
    expect((claim.where as { OR?: unknown[] }).OR).toBeDefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Call the bank');
    // Delivery confirmed → reminderSent flips to true AFTER the send, never before.
    expect(updates[updates.length - 1]).toEqual({
      where: { id: 't1' },
      data: { reminderSent: true },
    });
  });

  it('does not send when the lease is lost (a concurrent tick holds it)', async () => {
    const { job, sent } = makeJob({ claimFails: true });
    await job.run(new Date('2026-07-16T10:00:00Z'));
    expect(sent).toHaveLength(0);
  });

  it('releases the lease (never marks sent) and alerts when the send fails', async () => {
    const { job, sent, updates, alerts } = makeJob({ sendFails: true });
    await job.run(new Date('2026-07-16T10:00:00Z'));
    expect(sent).toHaveLength(0);
    // Lease released so the next tick retries — reminderSent is NEVER set true,
    // so the reminder is not silently lost.
    expect(updates[updates.length - 1]).toEqual({
      where: { id: 't1', reminderSent: false },
      data: { reminderClaimedAt: null },
    });
    expect(updates.some((u) => (u.data as { reminderSent?: boolean }).reminderSent === true)).toBe(
      false,
    );
    expect(alerts).toHaveLength(1);
  });
});
