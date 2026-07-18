import type { Client } from '@prisma/client';
import { DailyBriefJob } from './daily-brief.job';
import type { AdminAlertService } from './admin-alert.service';
import type { ClientNotifierService } from './client-notifier.service';
import type { CryptoService } from '../crypto/crypto.service';
import type { GoogleOAuthService } from '../integrations/google/google-oauth.service';
import type { TelegramService } from '../integrations/telegram/telegram.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TenancyService } from '../tenancy/tenancy.service';

/**
 * Regression guard for the SQL three-valued-logic trap that stopped the daily
 * brief from EVER firing: the atomic claim must match a client whose
 * lastBriefDate is NULL (never sent). The updateMany mock below emulates real
 * SQL — it only claims a null row when the WHERE explicitly allows null — so
 * the old `NOT: { lastBriefDate }` form would fail this test.
 */

const CLIENT: Client = {
  id: 'c1',
  name: 'Ali',
  status: 'active',
  timezone: 'Asia/Beirut',
  assistantName: 'A',
  email: null,
  telegramBotTokenEnc: 'enc',
  telegramChatId: 'chat-1',
  telegramWebhookSecretEnc: null,
  googleOAuthEnc: null,
  googleNeedsReauth: false,
  telegramBotUsername: null,
  telegramBindCode: null,
  defaultReminderMinutes: 15,
  dailyBriefHour: 8,
  lastBriefDate: null, // NEVER sent — the trap case
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Client;

function whereAllowsNull(where: { OR?: { lastBriefDate?: unknown }[] }): boolean {
  return Array.isArray(where.OR) && where.OR.some((c) => c.lastBriefDate === null);
}

describe('DailyBriefJob — first-ever brief is not skipped by NULL lastBriefDate', () => {
  it('claims and sends the brief for a client whose lastBriefDate is NULL', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const updateMany = jest.fn().mockImplementation((args: { where: { OR?: { lastBriefDate?: unknown }[] } }) =>
      // Emulate SQL: a NULL row is claimed ONLY if the WHERE explicitly allows null.
      Promise.resolve({ count: whereAllowsNull(args.where) ? 1 : 0 }),
    );
    const prisma = {
      client: { findMany: jest.fn().mockResolvedValue([CLIENT]), updateMany },
    } as unknown as PrismaService;
    const repo = { findTasks: jest.fn().mockResolvedValue({ tasks: [], more: 0 }) };
    const tenancy = { repoFor: () => repo } as unknown as TenancyService;
    const telegram = { sendMessage } as unknown as TelegramService;
    const crypto = { decrypt: () => 'bot-token' } as unknown as CryptoService;
    const google = { authorizedClientFor: jest.fn().mockResolvedValue(null) } as unknown as GoogleOAuthService;
    const alerts = { alert: jest.fn().mockResolvedValue(undefined) } as unknown as AdminAlertService;

    const job = new DailyBriefJob(prisma, tenancy, telegram, crypto, google, alerts, { send: sendMessage, record: jest.fn().mockResolvedValue(undefined) } as unknown as ClientNotifierService);
    // 09:00 UTC = 12:00 Beirut — well past the 08:00 brief hour.
    await job.run(new Date('2026-07-16T06:00:00Z')); // 09:00 Beirut — inside the 08:00 window

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), expect.any(String), 'brief');
    expect(job.lastSentCount).toBe(1);
  });

  it('does NOT send twice on the same day (already claimed)', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const already: Client = { ...CLIENT, lastBriefDate: '2026-07-16' };
    const prisma = {
      client: {
        findMany: jest.fn().mockResolvedValue([already]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    } as unknown as PrismaService;
    const job = new DailyBriefJob(
      prisma,
      { repoFor: () => ({ findTasks: jest.fn() }) } as unknown as TenancyService,
      { sendMessage } as unknown as TelegramService,
      { decrypt: () => 't' } as unknown as CryptoService,
      { authorizedClientFor: jest.fn().mockResolvedValue(null) } as unknown as GoogleOAuthService,
      { alert: jest.fn() } as unknown as AdminAlertService,
      { send: sendMessage, record: jest.fn().mockResolvedValue(undefined) } as unknown as ClientNotifierService,
    );
    await job.run(new Date('2026-07-16T06:00:00Z')); // 09:00 Beirut — inside the 08:00 window
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('DailyBriefJob — lastBriefAt guard (traveler date-shift)', () => {
  function jobFor(client: Client): { job: DailyBriefJob; sendMessage: jest.Mock } {
    const sendMessage = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      client: {
        findMany: jest.fn().mockResolvedValue([client]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaService;
    const repo = { findTasks: jest.fn().mockResolvedValue({ tasks: [], more: 0 }) };
    const job = new DailyBriefJob(
      prisma,
      { repoFor: () => repo } as unknown as TenancyService,
      { sendMessage } as unknown as TelegramService,
      { decrypt: () => 'bot-token' } as unknown as CryptoService,
      { authorizedClientFor: jest.fn().mockResolvedValue(null) } as unknown as GoogleOAuthService,
      { alert: jest.fn().mockResolvedValue(undefined) } as unknown as AdminAlertService,
      { send: sendMessage, record: jest.fn().mockResolvedValue(undefined) } as unknown as ClientNotifierService,
    );
    return { job, sendMessage };
  }

  it('does NOT re-send when a westward move makes the local date go backwards (< 20h since last)', async () => {
    // Brief already sent 2h ago for local date "2026-07-18" (was in Tokyo). Now
    // in LA the local date reads "2026-07-17" — the date check alone would let it
    // re-send; the 20h guard must block it.
    const now = new Date('2026-07-17T09:00:00Z'); // LA (PDT) local = 02:00, date 07-17
    const traveler = {
      ...CLIENT,
      timezone: 'America/Los_Angeles',
      dailyBriefHour: 0,
      lastBriefDate: '2026-07-18',
      lastBriefAt: new Date('2026-07-17T07:00:00Z'), // 2h before now
    } as unknown as Client;
    const { job, sendMessage } = jobFor(traveler);
    await job.run(now);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('DOES send the legitimate next-day brief', async () => {
    const now = new Date('2026-07-17T06:00:00Z'); // Beirut local = 09:00, date 07-17
    const client = {
      ...CLIENT,
      timezone: 'Asia/Beirut',
      dailyBriefHour: 8,
      lastBriefDate: '2026-07-16',
      lastBriefAt: new Date('2026-07-16T06:00:00Z'), // 24h before now
    } as unknown as Client;
    const { job, sendMessage } = jobFor(client);
    await job.run(now);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  /**
   * Production regression (Dr Wassim, 2026-07-18): a redeploy fired his 08:00
   * brief at 17:38 — nine hours late, "here's your day" once the day was over —
   * and that late send then sat inside the old 20h gap guard, silently
   * suppressing the NEXT morning's brief entirely.
   */
  it('SKIPS the brief once the catch-up window has passed (no stale evening digest)', async () => {
    const now = new Date('2026-07-17T14:38:00Z'); // Beirut 17:38 — 9h past the 08:00 hour
    const client = {
      ...CLIENT,
      timezone: 'Asia/Beirut',
      dailyBriefHour: 8,
      lastBriefDate: '2026-07-16',
      lastBriefAt: new Date('2026-07-16T05:00:00Z'),
    } as unknown as Client;
    const { job, sendMessage } = jobFor(client);
    await job.run(now);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a LATE brief yesterday must NOT suppress this morning’s brief', async () => {
    // Exactly the production failure: sent 17:38 yesterday, now 08:00 today.
    // Only ~14.4h apart — the old 20h guard blocked this and the client got
    // nothing. It must send.
    const now = new Date('2026-07-18T05:00:00Z'); // Beirut 08:00 on the 18th
    const client = {
      ...CLIENT,
      timezone: 'Asia/Beirut',
      dailyBriefHour: 8,
      lastBriefDate: '2026-07-17',
      lastBriefAt: new Date('2026-07-17T14:38:00Z'), // 17:38 Beirut yesterday
    } as unknown as Client;
    const { job, sendMessage } = jobFor(client);
    await job.run(now);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('still sends at the exact hour for a 23:00 brief (window never wraps midnight)', async () => {
    const now = new Date('2026-07-17T20:00:00Z'); // Beirut 23:00
    const client = {
      ...CLIENT,
      timezone: 'Asia/Beirut',
      dailyBriefHour: 23,
      lastBriefDate: '2026-07-16',
      lastBriefAt: new Date('2026-07-16T20:00:00Z'),
    } as unknown as Client;
    const { job, sendMessage } = jobFor(client);
    await job.run(now);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
