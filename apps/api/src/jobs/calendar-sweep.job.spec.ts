import { CalendarSweepJob } from './calendar-sweep.job';
import type { PrismaService } from '../prisma/prisma.service';
import type { GoogleCalendarGateway } from '../integrations/google/google-calendar.gateway';
import type { CalendarEvent } from '../tools/tool.types';
import type { Client } from '@prisma/client';

/**
 * Reconciliation guarantee: a companion reminder must track the LIVE Google
 * event even when the client edited the meeting directly in the Google app
 * (bypassing the bot) — renamed → new title, moved → re-timed, deleted → cleared
 * — without ever losing a live reminder to a transient Google error.
 */

const NOW = new Date('2026-07-17T09:00:00Z');
const CLIENT = { id: 'c1', name: 'Test', timezone: 'UTC' } as unknown as Client;

/** Assert exactly one element and return it (typed, non-optional). */
function only<T>(arr: T[]): T {
  expect(arr).toHaveLength(1);
  return arr[0] as T;
}

type Companion = {
  id: string;
  title: string;
  sourceEventId: string;
  reminderAt: Date | null;
  reminderLeadMinutes: number | null;
  recurrenceFreq: string | null;
  reminderSent: boolean;
  status: string;
};

function makeJob(
  companions: Companion[],
  getEvent: (id: string) => Promise<CalendarEvent | null>,
): {
  reconcile: () => Promise<void>;
  updates: { where: unknown; data: Record<string, unknown> }[];
  deletes: { where: Record<string, unknown> }[];
  getEventMock: jest.Mock;
} {
  const updates: { where: unknown; data: Record<string, unknown> }[] = [];
  const deletes: { where: Record<string, unknown> }[] = [];
  const prisma = {
    task: {
      findMany: jest.fn().mockResolvedValue(companions),
      updateMany: jest.fn((args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        return Promise.resolve({ count: 1 });
      }),
      deleteMany: jest.fn((args: { where: Record<string, unknown> }) => {
        deletes.push(args);
        return Promise.resolve({ count: 1 });
      }),
    },
  } as unknown as PrismaService;
  const job = new CalendarSweepJob(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const getEventMock = jest.fn(getEvent);
  const gateway = { getEvent: getEventMock } as unknown as GoogleCalendarGateway;
  const reconcile = (): Promise<void> =>
    (job as unknown as {
      reconcileCompanions(c: Client, g: GoogleCalendarGateway, now: Date): Promise<void>;
    }).reconcileCompanions(CLIENT, gateway, NOW);
  return { reconcile, updates, deletes, getEventMock };
}

const ev = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'ev1',
  title: 'Meeting',
  start: new Date('2026-07-17T20:00:00Z'),
  end: new Date('2026-07-17T21:00:00Z'),
  allDay: false,
  ...over,
});

const oneOff = (over: Partial<Companion>): Companion => ({
  id: 't1',
  title: 'Meeting',
  sourceEventId: 'ev1',
  reminderAt: new Date('2026-07-17T19:50:00Z'), // 10 min before 20:00
  reminderLeadMinutes: 10,
  recurrenceFreq: null,
  reminderSent: false,
  status: 'open',
  ...over,
});

describe('CalendarSweepJob — companion reminder reconciliation', () => {
  it('syncs the reminder title when the meeting was renamed in Google', async () => {
    const { reconcile, updates, deletes } = makeJob(
      [oneOff({ title: 'Meeting with Ali, Ismael and Hasanberg' })],
      () => Promise.resolve(ev({ title: 'Meeting with Ali Shmayssani and Hussein Bdeir' })),
    );
    await reconcile();
    expect(only(updates).data).toEqual({ title: 'Meeting with Ali Shmayssani and Hussein Bdeir' });
    expect(deletes).toEqual([]);
  });

  it('re-times a one-off reminder when the meeting was moved in Google', async () => {
    // Meeting moved 20:00 → 15:00; a 10-min reminder must move 19:50 → 14:50.
    const { reconcile, updates } = makeJob(
      [oneOff({})],
      () => Promise.resolve(ev({ start: new Date('2026-07-17T15:00:00Z'), end: new Date('2026-07-17T16:00:00Z') })),
    );
    await reconcile();
    const u = only(updates);
    expect((u.data.reminderAt as Date).toISOString()).toBe('2026-07-17T14:50:00.000Z');
    expect(u.data.reminderClaimedAt).toBeNull();
  });

  it('deletes the orphaned reminder when the meeting was deleted in Google', async () => {
    const { reconcile, updates, deletes } = makeJob([oneOff({})], () => Promise.resolve(null));
    await reconcile();
    expect(only(deletes).where).toEqual({ clientId: 'c1', sourceEventId: 'ev1', reminderSent: false });
    expect(updates).toEqual([]);
  });

  it('for a RECURRING series, syncs the title but never re-times (the cron owns that)', async () => {
    // Event start differs from the companion's stored time, but because it's
    // recurring we must NOT rewrite reminderAt — only the title.
    const { reconcile, updates } = makeJob(
      [oneOff({ recurrenceFreq: 'DAILY', title: 'Old standup' })],
      () => Promise.resolve(ev({ title: 'New standup', start: new Date('2026-07-17T12:00:00Z') })),
    );
    await reconcile();
    const u = only(updates);
    expect(u.data).toEqual({ title: 'New standup' });
    expect(u.data.reminderAt).toBeUndefined();
  });

  it('makes NO write when the live event already matches (title + time)', async () => {
    const { reconcile, updates, deletes } = makeJob([oneOff({})], () => Promise.resolve(ev({})));
    await reconcile();
    expect(updates).toEqual([]);
    expect(deletes).toEqual([]);
  });

  it('a transient Google error propagates and NEVER deletes a live reminder', async () => {
    const { reconcile, deletes } = makeJob([oneOff({})], () =>
      Promise.reject(new Error('Google timeout')),
    );
    await expect(reconcile()).rejects.toThrow('Google timeout');
    expect(deletes).toEqual([]); // the safety guarantee
  });

  it('fetches each shared event only once (two companions, one meeting)', async () => {
    const { reconcile, getEventMock } = makeJob(
      [
        oneOff({ id: 't1', reminderLeadMinutes: 60, reminderAt: new Date('2026-07-17T19:00:00Z') }),
        oneOff({ id: 't2', reminderLeadMinutes: 10, reminderAt: new Date('2026-07-17T19:50:00Z') }),
      ],
      () => Promise.resolve(ev({})),
    );
    await reconcile();
    expect(getEventMock).toHaveBeenCalledTimes(1);
  });
});
