import { ReminderJob } from './reminder.job';
import type { PrismaService } from '../prisma/prisma.service';
import type { TelegramService } from '../integrations/telegram/telegram.service';
import type { CryptoService } from '../crypto/crypto.service';
import type { AdminAlertService } from './admin-alert.service';
import type { ClientNotifierService } from './client-notifier.service';

const CLIENT = {
  id: 'c1',
  name: 'Test',
  status: 'active',
  timezone: 'UTC',
  telegramBotTokenEnc: 'enc',
  telegramChatId: '777',
};

function makeJob(opts?: {
  sendFails?: boolean;
  claimFails?: boolean;
  recurring?: boolean;
  reminderAt?: Date;
}): {
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
          reminderAt: opts?.reminderAt ?? new Date('2026-07-16T09:55:00Z'),
          reminderSent: false,
          reminderClaimedAt: null,
          recurrenceFreq: opts?.recurring ? 'DAILY' : null,
          recurrenceInterval: 1,
          recurrenceWeekdays: [],
          recurrenceUntil: null,
          recurrenceAnchor: null,
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

  return { job: new ReminderJob(prisma, telegram, crypto, alertsSvc, {
      send: jest.fn((_c: unknown, text: string) => {
        if (opts?.sendFails) return Promise.reject(new Error('telegram down'));
        sent.push(text);
        return Promise.resolve(undefined);
      }),
      record: jest.fn().mockResolvedValue(undefined),
    } as unknown as ClientNotifierService), sent, updates, alerts };
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

  it('a RECURRING reminder re-arms to the next occurrence instead of marking sent', async () => {
    const { job, sent, updates } = makeJob({ recurring: true });
    await job.run(new Date('2026-07-16T10:00:00Z'));
    expect(sent).toHaveLength(1);
    // Final update rolls the row forward: new reminderAt (next day), re-armed.
    const last = updates[updates.length - 1] as { data: Record<string, unknown> };
    expect(last.data.reminderSent).toBe(false);
    expect(last.data.reminderClaimedAt).toBeNull();
    // DAILY from 2026-07-16T09:55Z (client tz UTC) → 2026-07-17T09:55Z.
    expect((last.data.reminderAt as Date).toISOString()).toBe('2026-07-17T09:55:00.000Z');
  });

  it('after downtime, a recurring reminder sends ONCE and skips to the next future occurrence', async () => {
    // reminderAt 5 days ago, DAILY. Should send one ping and re-arm to a FUTURE time.
    const { job, sent, updates } = makeJob({
      recurring: true,
      reminderAt: new Date('2026-07-11T09:55:00Z'),
    });
    const now = new Date('2026-07-16T10:00:00Z');
    await job.run(now);
    expect(sent).toHaveLength(1); // ONE ping, not five
    const last = updates[updates.length - 1] as { data: Record<string, unknown> };
    expect((last.data.reminderAt as Date).getTime()).toBeGreaterThan(now.getTime());
  });

  it('does not send when the lease is lost (a concurrent tick holds it)', async () => {
    const { job, sent } = makeJob({ claimFails: true });
    await job.run(new Date('2026-07-16T10:00:00Z'));
    expect(sent).toHaveLength(0);
  });

  it('KEEPS the lease on send failure (backoff, never lost) and alerts', async () => {
    const { job, sent, updates, alerts } = makeJob({ sendFails: true });
    await job.run(new Date('2026-07-16T10:00:00Z'));
    expect(sent).toHaveLength(0);
    // The only write is the lease CLAIM; on failure we do NOT null the lease
    // (that would let the drain loop hot-spin the same failing batch). The row
    // stays claimed → excluded until the lease expires → natural backoff.
    expect(updates).toHaveLength(1);
    expect((updates[0]?.data as { reminderClaimedAt?: Date }).reminderClaimedAt).toBeInstanceOf(Date);
    // reminderSent is NEVER set true → at-least-once holds (retry after expiry).
    expect(updates.some((u) => (u.data as { reminderSent?: boolean }).reminderSent === true)).toBe(
      false,
    );
    expect(alerts).toHaveLength(1);
  });
});
