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
        // First call is the claim; simulate lost race if claimFails.
        const isClaim = (args.data as { reminderSent?: boolean }).reminderSent === true;
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

describe('ReminderJob — claim/send/revert', () => {
  it('claims atomically, then sends the reminder', async () => {
    const { job, sent, updates } = makeJob();
    await job.run(new Date('2026-07-16T10:00:00Z'));
    expect(updates[0]).toEqual({
      where: { id: 't1', reminderSent: false },
      data: { reminderSent: true },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Call the bank');
  });

  it('does not send when the claim is lost (duplicate/concurrent run)', async () => {
    const { job, sent } = makeJob({ claimFails: true });
    await job.run(new Date('2026-07-16T10:00:00Z'));
    expect(sent).toHaveLength(0);
  });

  it('reverts the claim and alerts the admin when the send fails', async () => {
    const { job, sent, updates, alerts } = makeJob({ sendFails: true });
    await job.run(new Date('2026-07-16T10:00:00Z'));
    expect(sent).toHaveLength(0);
    // claim … then revert
    expect(updates[updates.length - 1]).toEqual({
      where: { id: 't1' },
      data: { reminderSent: false },
    });
    expect(alerts).toHaveLength(1);
  });
});
