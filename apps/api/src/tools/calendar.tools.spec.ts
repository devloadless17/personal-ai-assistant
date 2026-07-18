import type { Client } from '@prisma/client';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvents,
  updateCalendarEvent,
} from './calendar.tools';
import type { CalendarEvent, CalendarGateway, ToolContext } from './tool.types';
import type { ClientScopedRepository } from '../tenancy/client-scoped-repository';

const CLIENT = {
  id: 'c1',
  timezone: 'UTC',
  name: 'T',
  assistantName: 'A',
  defaultMeetingMinutes: 90,
  reminderLeads: [] as number[],
} as Client;

function makeGateway(
  existing: CalendarEvent[],
  freeSlots: { start: Date; end: Date }[] = [],
): CalendarGateway & {
  created: CalendarEvent[];
  updated: { id: string; params: Partial<CalendarEvent> }[];
  deleted: string[];
} {
  const created: CalendarEvent[] = [];
  const updated: { id: string; params: Partial<CalendarEvent> }[] = [];
  const deleted: string[] = [];
  return {
    created,
    updated,
    deleted,
    listEvents: jest.fn().mockResolvedValue(existing),
    getEvent: jest
      .fn()
      .mockImplementation((id: string) => Promise.resolve(existing.find((e) => e.id === id) ?? null)),
    createEvent: jest
      .fn()
      .mockImplementation(
        (p: { title: string; start: Date; end: Date; attendees?: string[]; sendInvites?: boolean }) => {
          const e: CalendarEvent = { id: `ev-${created.length + 1}`, allDay: false, ...p };
          created.push(e);
          return Promise.resolve(e);
        },
      ),
    updateEvent: jest.fn().mockImplementation((id: string, p: Partial<CalendarEvent>) => {
      updated.push({ id, params: p });
      const src = existing.find((e) => e.id === id);
      return Promise.resolve({
        id,
        title: p.title ?? src?.title ?? 'x',
        start: p.start ?? src?.start ?? new Date(),
        end: p.end ?? src?.end ?? new Date(),
        allDay: false,
        seriesId: src?.seriesId,
        recurring: src?.recurring,
      });
    }),
    deleteEvent: jest.fn().mockImplementation((id: string) => {
      deleted.push(id);
      return Promise.resolve(undefined);
    }),
    findConflicts: jest
      .fn()
      .mockImplementation((start: Date, end: Date, exclude?: string) =>
        Promise.resolve(
          existing.filter((e) => e.id !== exclude && !e.allDay && e.start < end && e.end > start),
        ),
      ),
    findFreeSlots: jest.fn().mockResolvedValue(freeSlots),
  };
}

function ctxWith(gateway?: CalendarGateway): ToolContext {
  const repo = {
    createTask: jest.fn().mockResolvedValue({}),
    deleteEventReminders: jest.fn().mockResolvedValue(undefined),
    setEventReminderPolicyPinned: jest.fn().mockResolvedValue(undefined),
    renameEventReminders: jest.fn().mockResolvedValue(undefined),
    getEventReminderLead: jest.fn().mockResolvedValue(null),
    getEventReminder: jest.fn().mockResolvedValue(null),
    getEventReminders: jest.fn().mockResolvedValue([]),
  } as unknown as ClientScopedRepository;
  return {
    repo,
    client: CLIENT,
    now: new Date('2026-07-16T09:00:00Z'),
    calendar: gateway,
  };
}

const MEETING: CalendarEvent = {
  id: 'busy-1',
  title: 'Board meeting',
  start: new Date('2026-07-17T10:00:00Z'),
  end: new Date('2026-07-17T11:00:00Z'),
  allDay: false,
};

describe('calendar tools — conflict gating & honesty', () => {
  it('refuses to double-book and names the clash; nothing is created', async () => {
    const gw = makeGateway([MEETING]);
    const result = await createCalendarEvent.execute(
      {
        title: 'Overlap',
        start: new Date('2026-07-17T10:30:00Z'),
        end: new Date('2026-07-17T11:30:00Z'),
      },
      ctxWith(gw),
    );
    expect(result).toContain('CONFLICT');
    expect(result).toContain('Board meeting');
    expect(gw.created).toHaveLength(0);
  });

  it('a conflict result proactively includes concrete alternative open slots', async () => {
    const gw = makeGateway([MEETING], [
      { start: new Date('2026-07-17T12:00:00Z'), end: new Date('2026-07-17T13:00:00Z') },
      { start: new Date('2026-07-17T16:00:00Z'), end: new Date('2026-07-17T17:00:00Z') },
    ]);
    const result = await createCalendarEvent.execute(
      {
        title: 'Overlap',
        start: new Date('2026-07-17T10:30:00Z'),
        end: new Date('2026-07-17T11:30:00Z'),
      },
      ctxWith(gw),
    );
    expect(result).toContain('CONFLICT');
    expect(result).toContain('Nearest open times');
    expect(gw.created).toHaveLength(0);
  });

  it('does NOT drop a recurring meeting reminder when its first ping is already past', async () => {
    // Regression: a daily meeting whose first reminder (start-lead) is in the
    // past must still arm the companion at the next FUTURE occurrence.
    const created: Record<string, unknown>[] = [];
    const gw = makeGateway([]);
    const ctx = {
      repo: {
        createTask: jest.fn((d: Record<string, unknown>) => {
          created.push(d);
          return Promise.resolve({});
        }),
        deleteEventReminders: jest.fn().mockResolvedValue(undefined),
        setEventReminderPolicyPinned: jest.fn().mockResolvedValue(undefined),
        getEventReminder: jest.fn().mockResolvedValue(null),
      } as unknown as ClientScopedRepository,
      client: CLIENT, // UTC
      now: new Date('2026-07-16T09:00:00Z'),
      calendar: gw,
    } as ToolContext;
    const res = await createCalendarEvent.execute(
      {
        title: 'Standup',
        start: new Date('2026-07-16T09:05:00Z'), // first reminder 08:50 = past
        end: new Date('2026-07-16T09:20:00Z'),
        repeat: { freq: 'daily' },
        reminder_minutes_before: [15],
      },
      ctx,
    );
    expect(created).toHaveLength(1); // companion NOT dropped
    // Armed at the next future occurrence (tomorrow 08:50Z), pinned to the zone.
    expect(created[0]?.reminderAt).toEqual(new Date('2026-07-17T08:50:00Z'));
    expect(created[0]?.recurrenceFreq).toBe('DAILY');
    expect(created[0]?.recurrenceTimezone).toBe('UTC');
    expect(res).toContain('each time');
  });

  // Capturing ctx: records every companion reminder createTask receives.
  function capturingCtx(
    clientOver: Partial<Client>,
    gw: CalendarGateway,
  ): { ctx: ToolContext; created: Record<string, unknown>[] } {
    const created: Record<string, unknown>[] = [];
    const ctx = {
      repo: {
        createTask: jest.fn((d: Record<string, unknown>) => {
          created.push(d);
          return Promise.resolve({});
        }),
        deleteEventReminders: jest.fn().mockResolvedValue(undefined),
        setEventReminderPolicyPinned: jest.fn().mockResolvedValue(undefined),
        getEventReminders: jest.fn().mockResolvedValue([]),
      } as unknown as ClientScopedRepository,
      client: { ...CLIENT, ...clientOver },
      now: new Date('2026-07-16T09:00:00Z'),
      calendar: gw,
    } as ToolContext;
    return { ctx, created };
  }

  it('applies the client DEFAULT reminders to a meeting (one ping per lead), code-enforced', async () => {
    const gw = makeGateway([]);
    const { ctx, created } = capturingCtx({ reminderLeads: [60, 10] }, gw);
    const res = await createCalendarEvent.execute(
      { title: 'Sync', start: new Date('2026-07-16T15:00:00Z'), end: new Date('2026-07-16T16:00:00Z') },
      ctx, // note: reminder_minutes_before OMITTED — must still apply the default
    );
    expect(created).toHaveLength(2);
    expect(created.find((c) => c.reminderLeadMinutes === 60)?.reminderAt).toEqual(
      new Date('2026-07-16T14:00:00Z'),
    );
    expect(created.find((c) => c.reminderLeadMinutes === 10)?.reminderAt).toEqual(
      new Date('2026-07-16T14:50:00Z'),
    );
    expect(res).toContain('1 hour and 10 min before');
  });

  it('a cross-midnight lead on a weekly meeting recurs the reminder on the ANCHOR weekday', async () => {
    // Weekly Monday 08:00 meeting, "remind me the day before" (1440) → the ping
    // must recur on SUNDAY, not snap back to Monday every week (the HIGH bug).
    const gw = makeGateway([]);
    const { ctx, created } = capturingCtx({ reminderLeads: [] }, gw);
    await createCalendarEvent.execute(
      {
        title: "Team sync",
        start: new Date("2026-07-20T08:00:00Z"), // Monday (UTC)
        end: new Date("2026-07-20T09:00:00Z"),
        repeat: { freq: "weekly", weekdays: [1] }, // Mon
        reminder_minutes_before: [1440], // 1 day before
      },
      ctx,
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.recurrenceFreq).toBe("WEEKLY");
    expect(created[0]?.recurrenceWeekdays).toEqual([0]); // Sunday, not Monday
    // First ping = the Sunday before the first Monday.
    expect(created[0]?.reminderAt).toEqual(new Date("2026-07-19T08:00:00Z"));
  });

  it('a per-meeting reminder list overrides the default', async () => {
    const gw = makeGateway([]);
    const { ctx, created } = capturingCtx({ reminderLeads: [60, 10] }, gw);
    await createCalendarEvent.execute(
      {
        title: 'Sync',
        start: new Date('2026-07-16T15:00:00Z'),
        end: new Date('2026-07-16T16:00:00Z'),
        reminder_minutes_before: [30],
      },
      ctx,
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.reminderLeadMinutes).toBe(30);
  });

  it('reminder_minutes_before [] turns reminders off for this meeting', async () => {
    const gw = makeGateway([]);
    const { ctx, created } = capturingCtx({ reminderLeads: [60, 10] }, gw);
    await createCalendarEvent.execute(
      {
        title: 'Sync',
        start: new Date('2026-07-16T15:00:00Z'),
        end: new Date('2026-07-16T16:00:00Z'),
        reminder_minutes_before: [],
      },
      ctx,
    );
    expect(created).toHaveLength(0);
  });

  it('recognizes a same-title clash as an EXISTING duplicate, not a scheduling conflict', async () => {
    const existing: CalendarEvent = {
      id: 'e1',
      title: 'Meeting with Ali',
      start: new Date('2026-07-17T21:00:00Z'),
      end: new Date('2026-07-17T22:00:00Z'),
      allDay: false,
    };
    const gw = makeGateway([existing], [
      { start: new Date('2026-07-17T22:00:00Z'), end: new Date('2026-07-17T23:00:00Z') },
    ]);
    const res = await createCalendarEvent.execute(
      // Same title (different case/spacing), same time → duplicate, not a clash.
      { title: 'meeting with  ali', start: new Date('2026-07-17T21:00:00Z'), end: new Date('2026-07-17T22:00:00Z') },
      ctxWith(gw),
    );
    expect(res).toContain('ALREADY EXISTS');
    expect(res).not.toContain('Nearest open times'); // don't offer slots for a dupe
    expect(gw.created).toHaveLength(0);
  });

  it('applies the client default meeting length when no end is given', async () => {
    const gw = makeGateway([]);
    await createCalendarEvent.execute(
      { title: 'Quick sync', start: new Date('2026-07-18T09:00:00Z') }, // no end
      ctxWith(gw),
    );
    expect(gw.created).toHaveLength(1);
    // start + defaultMeetingMinutes (90) — computed server-side, not by the model.
    expect(gw.created[0]?.end).toEqual(new Date('2026-07-18T10:30:00Z'));
  });

  it('a per-event duration_minutes overrides the client default', async () => {
    const gw = makeGateway([]);
    await createCalendarEvent.execute(
      { title: 'Standup', start: new Date('2026-07-18T09:00:00Z'), duration_minutes: 30 },
      ctxWith(gw),
    );
    expect(gw.created[0]?.end).toEqual(new Date('2026-07-18T09:30:00Z'));
  });

  it('stamps the event with the client live timezone', async () => {
    const gw = makeGateway([]);
    await createCalendarEvent.execute(
      { title: 'Zoned', start: new Date('2026-07-18T09:00:00Z'), end: new Date('2026-07-18T10:00:00Z') },
      ctxWith(gw),
    );
    // makeGateway spreads the create params into `created`, so the stamped
    // timeZone is captured there.
    const first = gw.created[0] as unknown as { timeZone?: string } | undefined;
    expect(first?.timeZone).toBe('UTC');
  });

  it('books cleanly when the slot is free', async () => {
    const gw = makeGateway([MEETING]);
    const result = await createCalendarEvent.execute(
      {
        title: 'Free slot',
        start: new Date('2026-07-17T12:00:00Z'),
        end: new Date('2026-07-17T13:00:00Z'),
      },
      ctxWith(gw),
    );
    expect(result).toContain('Created on calendar');
    expect(gw.created).toHaveLength(1);
  });

  it('books over a conflict only with explicit allow_conflict', async () => {
    const gw = makeGateway([MEETING]);
    const result = await createCalendarEvent.execute(
      {
        title: 'Confirmed overlap',
        start: new Date('2026-07-17T10:30:00Z'),
        end: new Date('2026-07-17T11:30:00Z'),
        allow_conflict: true,
      },
      ctxWith(gw),
    );
    expect(result).toContain('Created on calendar');
    expect(gw.created).toHaveLength(1);
  });

  it('rejects end <= start without creating anything', async () => {
    const gw = makeGateway([]);
    const result = await createCalendarEvent.execute(
      {
        title: 'Backwards',
        start: new Date('2026-07-17T11:00:00Z'),
        end: new Date('2026-07-17T10:00:00Z'),
      },
      ctxWith(gw),
    );
    expect(result).toContain('ERROR');
    expect(gw.created).toHaveLength(0);
  });

  it('moving an event ignores its own slot but catches other clashes', async () => {
    const other: CalendarEvent = {
      ...MEETING,
      id: 'busy-2',
      title: 'Other meeting',
      start: new Date('2026-07-17T14:00:00Z'),
      end: new Date('2026-07-17T15:00:00Z'),
    };
    const gw = makeGateway([MEETING, other]);
    // Move busy-1 onto itself: no conflict (excluded)…
    const ok = await updateCalendarEvent.execute(
      {
        event_id: 'busy-1',
        start: new Date('2026-07-17T10:15:00Z'),
        end: new Date('2026-07-17T11:15:00Z'),
      },
      ctxWith(gw),
    );
    expect(ok).toContain('Updated on calendar');
    // …but moving it onto busy-2 is refused.
    const clash = await updateCalendarEvent.execute(
      {
        event_id: 'busy-1',
        start: new Date('2026-07-17T14:30:00Z'),
        end: new Date('2026-07-17T15:30:00Z'),
      },
      ctxWith(gw),
    );
    expect(clash).toContain('CONFLICT');
    expect(clash).toContain('Other meeting');
  });

  it('a SINGLE-SIDED time change still runs the conflict check (fills the missing side)', async () => {
    const other: CalendarEvent = {
      ...MEETING,
      id: 'busy-2',
      title: 'Other meeting',
      start: new Date('2026-07-17T14:00:00Z'),
      end: new Date('2026-07-17T15:00:00Z'),
    };
    const gw = makeGateway([MEETING, other]); // busy-1 is 10:00–11:00
    // Extend busy-1 by setting ONLY end to 14:30 → it now spans into busy-2.
    // Without fetching the current start, the conflict gate would be skipped.
    const clash = await updateCalendarEvent.execute(
      { event_id: 'busy-1', end: new Date('2026-07-17T14:30:00Z') },
      ctxWith(gw),
    );
    expect(clash).toContain('CONFLICT');
    expect(clash).toContain('Other meeting');
  });

  it('a single-sided move that produces end <= start is rejected, not sent to Google', async () => {
    const gw = makeGateway([MEETING]); // busy-1 is 10:00–11:00
    // Move only start to 11:30 (past the unchanged 11:00 end).
    const res = await updateCalendarEvent.execute(
      { event_id: 'busy-1', start: new Date('2026-07-17T11:30:00Z') },
      ctxWith(gw),
    );
    expect(res).toContain('ERROR');
  });

  it('adds named guests SILENTLY by default (no invite email)', async () => {
    const gw = makeGateway([]);
    const result = await createCalendarEvent.execute(
      {
        title: 'Sync',
        start: new Date('2026-07-18T10:00:00Z'),
        end: new Date('2026-07-18T11:00:00Z'),
        attendees: ['sara@example.com'],
      },
      ctxWith(gw),
    );
    expect(gw.created[0]?.attendees).toEqual(['sara@example.com']);
    expect((gw.created[0] as { sendInvites?: boolean }).sendInvites).toBeFalsy();
    expect(result).toContain('no invite emailed');
  });

  it('emails invites only when send_invites is set', async () => {
    const gw = makeGateway([]);
    const result = await createCalendarEvent.execute(
      {
        title: 'Sync',
        start: new Date('2026-07-18T10:00:00Z'),
        end: new Date('2026-07-18T11:00:00Z'),
        attendees: ['sara@example.com'],
        send_invites: true,
      },
      ctxWith(gw),
    );
    expect((gw.created[0] as { sendInvites?: boolean }).sendInvites).toBe(true);
    expect(result).toContain('Invites emailed');
  });

  it('creates a RECURRING meeting as a native Google recurring event + recurring companion reminder', async () => {
    const gw = makeGateway([]);
    const ctx = ctxWith(gw);
    const created: Record<string, unknown>[] = [];
    (ctx.repo as unknown as { createTask: jest.Mock }).createTask = jest
      .fn()
      .mockImplementation((d: Record<string, unknown>) => {
        created.push(d);
        return Promise.resolve({});
      });
    const result = await createCalendarEvent.execute(
      {
        title: 'Dev team meeting',
        start: new Date('2026-07-18T12:00:00Z'),
        end: new Date('2026-07-18T13:00:00Z'),
        repeat: { freq: 'weekly', weekdays: [6] },
        reminder_minutes_before: [15],
      },
      ctx,
    );
    // Native recurring Google event.
    expect((gw.created[0] as { recurrence?: string[] }).recurrence).toEqual([
      'RRULE:FREQ=WEEKLY;BYDAY=SA',
    ]);
    expect(result).toContain('Created on calendar');
    // Companion reminder is itself recurring, anchored to the ping time.
    expect(created[0]?.recurrenceFreq).toBe('WEEKLY');
    expect(created[0]?.recurrenceWeekdays).toEqual([6]);
  });

  it('updating a recurring event changes the WHOLE series (targets the master id)', async () => {
    const instance: CalendarEvent = {
      id: 'evt_20260719T160000Z',
      seriesId: 'evt',
      title: 'Sales sync',
      start: new Date('2026-07-19T16:00:00Z'),
      end: new Date('2026-07-19T17:00:00Z'),
      allDay: false,
      recurring: true,
    };
    const gw = makeGateway([instance]);
    const res = await updateCalendarEvent.execute(
      { event_id: 'evt_20260719T160000Z', end: new Date('2026-07-19T18:00:00Z') },
      ctxWith(gw),
    );
    // Patched the SERIES MASTER, not the single instance.
    expect(gw.updated[0]?.id).toBe('evt');
    expect(res).toContain('whole recurring series');
  });

  it('a single-instance edit (apply_to:this_event) targets only that instance', async () => {
    const instance: CalendarEvent = {
      id: 'evt_20260719T160000Z',
      seriesId: 'evt',
      title: 'Sales sync',
      start: new Date('2026-07-19T16:00:00Z'),
      end: new Date('2026-07-19T17:00:00Z'),
      allDay: false,
      recurring: true,
    };
    const gw = makeGateway([instance]);
    await updateCalendarEvent.execute(
      {
        event_id: 'evt_20260719T160000Z',
        apply_to: 'this_event',
        end: new Date('2026-07-19T18:00:00Z'),
      },
      ctxWith(gw),
    );
    expect(gw.updated[0]?.id).toBe('evt_20260719T160000Z'); // the instance, not master
  });

  it('cancelling a recurring event deletes the WHOLE series by default', async () => {
    const instance: CalendarEvent = {
      id: 'evt_20260719T160000Z',
      seriesId: 'evt',
      title: 'Sales sync',
      start: new Date('2026-07-19T16:00:00Z'),
      end: new Date('2026-07-19T17:00:00Z'),
      allDay: false,
      recurring: true,
    };
    const gw = makeGateway([instance]);
    const res = await deleteCalendarEvent.execute({ event_id: 'evt_20260719T160000Z' }, ctxWith(gw));
    expect(gw.deleted).toEqual(['evt']); // the master series, not the instance
    expect(res).toContain('whole recurring series');
  });

  it('deleting a recurring instance clears the companion reminder by SERIES id', async () => {
    const instance: CalendarEvent = {
      id: 'evt_20260725T090000Z',
      seriesId: 'evt',
      title: 'Standup',
      start: new Date('2026-07-25T09:00:00Z'),
      end: new Date('2026-07-25T09:15:00Z'),
      allDay: false,
      recurring: true,
    };
    const gw = makeGateway([instance]);
    const ctx = ctxWith(gw);
    const delCalls: string[] = [];
    (ctx.repo as unknown as { deleteEventReminders: jest.Mock }).deleteEventReminders = jest
      .fn()
      .mockImplementation((id: string) => {
        delCalls.push(id);
        return Promise.resolve();
      });
    await deleteCalendarEvent.execute({ event_id: 'evt_20260725T090000Z' }, ctx);
    // Cleared by the SERIES master id, so a recurring reminder stops firing.
    expect(delCalls).toContain('evt');
  });

  it('cancelling ONE occurrence (apply_to:this_event) does NOT wipe the whole series reminders', async () => {
    const instance: CalendarEvent = {
      id: 'evt_20260725T090000Z',
      seriesId: 'evt',
      title: 'Standup',
      start: new Date('2026-07-25T09:00:00Z'),
      end: new Date('2026-07-25T09:15:00Z'),
      allDay: false,
      recurring: true,
    };
    const gw = makeGateway([instance]);
    const ctx = ctxWith(gw);
    const delCalls: string[] = [];
    (ctx.repo as unknown as { deleteEventReminders: jest.Mock }).deleteEventReminders = jest
      .fn()
      .mockImplementation((id: string) => {
        delCalls.push(id);
        return Promise.resolve();
      });
    await deleteCalendarEvent.execute(
      { event_id: 'evt_20260725T090000Z', apply_to: 'this_event' },
      ctx,
    );
    expect(gw.deleted).toEqual(['evt_20260725T090000Z']); // only the instance in Google
    expect(delCalls).toEqual([]); // series companions LEFT INTACT (the bug fix)
  });

  it('editing ONE occurrence (apply_to:this_event) does NOT rewrite the series reminders', async () => {
    const instance: CalendarEvent = {
      id: 'evt_20260725T090000Z',
      seriesId: 'evt',
      title: 'Standup',
      start: new Date('2026-07-25T09:00:00Z'),
      end: new Date('2026-07-25T09:15:00Z'),
      allDay: false,
      recurring: true,
    };
    const gw = makeGateway([instance]);
    const created: unknown[] = [];
    const del: string[] = [];
    const ctx = {
      repo: {
        createTask: jest.fn((d: unknown) => {
          created.push(d);
          return Promise.resolve({});
        }),
        setEventReminderPolicyPinned: jest.fn().mockResolvedValue(undefined),
        deleteEventReminders: jest.fn((id: string) => {
          del.push(id);
          return Promise.resolve();
        }),
        getEventReminders: jest.fn().mockResolvedValue([
          { reminderLeadMinutes: 60, recurrenceFreq: 'DAILY', recurrenceInterval: 1, recurrenceWeekdays: [], recurrenceUntil: null, recurrenceTimezone: 'UTC' },
        ]),
      } as unknown as ClientScopedRepository,
      client: CLIENT,
      now: new Date('2026-07-24T09:00:00Z'),
      calendar: gw,
    } as ToolContext;
    await updateCalendarEvent.execute(
      {
        event_id: 'evt_20260725T090000Z',
        apply_to: 'this_event',
        start: new Date('2026-07-25T11:00:00Z'),
        end: new Date('2026-07-25T11:15:00Z'),
      },
      ctx,
    );
    expect(del).toEqual([]); // series companions untouched
    expect(created).toEqual([]); // not re-anchored to the moved instance
  });

  it('syncs the companion reminder title when a meeting is renamed (no time/reminder change)', async () => {
    // Regression: renaming a meeting must update its reminder so the ping shows
    // the CURRENT name, not the stale title the companion was first armed with.
    const evt: CalendarEvent = {
      id: 'ev-rename',
      title: 'Meeting with Ali, Ismael and Hasanberg',
      start: new Date('2026-07-17T18:00:00Z'),
      end: new Date('2026-07-17T19:00:00Z'),
      allDay: false,
    };
    const gw = makeGateway([evt]);
    const renamed: { id: string; title: string }[] = [];
    const del: string[] = [];
    const ctx = {
      repo: {
        createTask: jest.fn().mockResolvedValue({}),
        renameEventReminders: jest.fn((id: string, title: string) => {
          renamed.push({ id, title });
          return Promise.resolve();
        }),
        setEventReminderPolicyPinned: jest.fn().mockResolvedValue(undefined),
        deleteEventReminders: jest.fn((id: string) => {
          del.push(id);
          return Promise.resolve();
        }),
        getEventReminders: jest.fn().mockResolvedValue([
          { reminderLeadMinutes: 15, recurrenceFreq: null, recurrenceInterval: null, recurrenceWeekdays: [], recurrenceUntil: null, recurrenceTimezone: null },
        ]),
      } as unknown as ClientScopedRepository,
      client: CLIENT,
      now: new Date('2026-07-17T09:00:00Z'),
      calendar: gw,
    } as ToolContext;
    await updateCalendarEvent.execute(
      { event_id: 'ev-rename', title: 'Meeting with Ali Shmayssani and Hussein Bdeir' },
      ctx,
    );
    // Title synced onto the companion; companions NOT torn down (no re-arm).
    expect(renamed).toEqual([{ id: 'ev-rename', title: 'Meeting with Ali Shmayssani and Hussein Bdeir' }]);
    expect(del).toEqual([]);
  });

  it('every calendar tool answers honestly when Google is not connected', async () => {
    const ctx = ctxWith(undefined);
    const results = await Promise.all([
      getCalendarEvents.execute(
        { from: new Date(), to: new Date(Date.now() + 86_400_000) },
        ctx,
      ),
      createCalendarEvent.execute(
        { title: 'x', start: new Date(), end: new Date(Date.now() + 3_600_000) },
        ctx,
      ),
      updateCalendarEvent.execute({ event_id: 'e' }, ctx),
      deleteCalendarEvent.execute({ event_id: 'e' }, ctx),
    ]);
    for (const r of results) {
      expect(r).toContain('not connected');
      expect(r).toContain('Do NOT claim');
    }
  });
});
