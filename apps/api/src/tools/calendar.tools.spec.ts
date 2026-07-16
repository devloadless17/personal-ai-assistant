import type { Client } from '@prisma/client';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvents,
  updateCalendarEvent,
} from './calendar.tools';
import type { CalendarEvent, CalendarGateway, ToolContext } from './tool.types';
import type { ClientScopedRepository } from '../tenancy/client-scoped-repository';

const CLIENT = { id: 'c1', timezone: 'UTC', name: 'T', assistantName: 'A' } as Client;

function makeGateway(existing: CalendarEvent[]): CalendarGateway & { created: CalendarEvent[] } {
  const created: CalendarEvent[] = [];
  return {
    created,
    listEvents: jest.fn().mockResolvedValue(existing),
    createEvent: jest.fn().mockImplementation((p: { title: string; start: Date; end: Date }) => {
      const e: CalendarEvent = { id: `ev-${created.length + 1}`, allDay: false, ...p };
      created.push(e);
      return Promise.resolve(e);
    }),
    updateEvent: jest
      .fn()
      .mockImplementation((id: string, p: Partial<CalendarEvent>) =>
        Promise.resolve({ id, title: 'x', start: new Date(), end: new Date(), allDay: false, ...p }),
      ),
    deleteEvent: jest.fn().mockResolvedValue(undefined),
    findConflicts: jest
      .fn()
      .mockImplementation((start: Date, end: Date, exclude?: string) =>
        Promise.resolve(
          existing.filter((e) => e.id !== exclude && !e.allDay && e.start < end && e.end > start),
        ),
      ),
    findFreeSlots: jest.fn().mockResolvedValue([]),
  };
}

function ctxWith(gateway?: CalendarGateway): ToolContext {
  const repo = {
    createTask: jest.fn().mockResolvedValue({}),
    deleteEventReminders: jest.fn().mockResolvedValue(undefined),
    getEventReminderLead: jest.fn().mockResolvedValue(null),
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
