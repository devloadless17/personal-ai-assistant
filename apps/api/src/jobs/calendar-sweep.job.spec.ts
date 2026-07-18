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

  it('does NOT re-time a recurring companion even when the event start differs', async () => {
    const { reconcile, updates } = makeJob(
      [oneOff({ recurrenceFreq: 'WEEKLY', title: 'Standup' })],
      () => Promise.resolve(ev({ title: 'Standup', start: new Date('2026-07-17T09:00:00Z') })),
    );
    await reconcile();
    expect(updates).toEqual([]); // title matches, and time must be left alone
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

/**
 * Auto-arming: a meeting the client created DIRECTLY in the Google Calendar app
 * must get the same reminders as one booked through the bot — without ever
 * double-arming a bot-booked meeting or resurrecting reminders the client
 * explicitly turned off.
 */
function makeArmJob(opts: {
  events: CalendarEvent[];
  existing?: { sourceEventId: string }[];
  optOuts?: { eventId: string }[];
  reminderLeads?: number[];
}): {
  arm: () => Promise<void>;
  created: Record<string, unknown>[];
} {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    task: {
      findMany: jest.fn().mockResolvedValue(opts.existing ?? []),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve({});
      }),
    },
    eventReminderOptOut: {
      findMany: jest.fn().mockResolvedValue(opts.optOuts ?? []),
    },
  } as unknown as PrismaService;
  const job = new CalendarSweepJob(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const gateway = {
    listEvents: jest.fn().mockResolvedValue(opts.events),
  } as unknown as GoogleCalendarGateway;
  const client = { ...CLIENT, reminderLeads: opts.reminderLeads ?? [60, 10] };
  const arm = (): Promise<void> =>
    (job as unknown as {
      armMissingCompanions(c: Client, g: GoogleCalendarGateway, now: Date): Promise<void>;
    }).armMissingCompanions(client, gateway, NOW);
  return { arm, created };
}

describe('CalendarSweepJob — auto-arming Google-created meetings', () => {
  it('arms one reminder per lead for a meeting added in the Google app', async () => {
    const { arm, created } = makeArmJob({ events: [ev({ id: 'g1' })] });
    await arm();
    expect(created).toHaveLength(2); // [60, 10]
    expect(created.map((c) => c.reminderLeadMinutes).sort()).toEqual([10, 60]);
    // Keyed on the OCCURRENCE id so reconciliation re-times from the right event.
    expect(created.every((c) => c.sourceEventId === 'g1')).toBe(true);
    expect((created[0] as { reminderAt: Date }).reminderAt.toISOString()).toBe(
      '2026-07-17T19:00:00.000Z', // 60 min before 20:00
    );
  });

  it('does NOT double-arm a meeting the bot already booked (companion under series id)', async () => {
    const { arm, created } = makeArmJob({
      events: [ev({ id: 'occ-1', seriesId: 'master-1' })],
      existing: [{ sourceEventId: 'master-1' }],
    });
    await arm();
    expect(created).toEqual([]);
  });

  it('respects an explicit "no reminders for this meeting" opt-out', async () => {
    const { arm, created } = makeArmJob({
      events: [ev({ id: 'g2' })],
      optOuts: [{ eventId: 'g2' }],
    });
    await arm();
    expect(created).toEqual([]);
  });

  it('skips all-day events (a "1 hour before" ping is meaningless)', async () => {
    const { arm, created } = makeArmJob({ events: [ev({ id: 'g3', allDay: true })] });
    await arm();
    expect(created).toEqual([]);
  });

  it('arms nothing when the client wants no automatic reminders', async () => {
    const { arm, created } = makeArmJob({ events: [ev({ id: 'g4' })], reminderLeads: [] });
    await arm();
    expect(created).toEqual([]);
  });

  it('skips leads whose ping time has already passed', async () => {
    // Meeting in 20 minutes: the 60-min ping is in the past, the 10-min is not.
    const soon = ev({ id: 'g5', start: new Date(NOW.getTime() + 20 * 60_000) });
    const { arm, created } = makeArmJob({ events: [soon] });
    await arm();
    expect(created).toHaveLength(1);
    expect(created[0]?.reminderLeadMinutes).toBe(10);
  });
});
