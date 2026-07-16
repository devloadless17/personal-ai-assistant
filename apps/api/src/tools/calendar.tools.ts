import { z } from 'zod';
import { defineTool } from './tool.types';
import type { CalendarEvent, ToolContext } from './tool.types';
import { formatInTz, isoDateTime } from './time';

const NOT_CONNECTED =
  'ERROR: Google Calendar is not connected for this client yet. Tell the client their calendar isn\'t linked and that the administrator can send them a connection link. Do NOT claim any calendar action succeeded.';

function renderEvent(e: CalendarEvent, tz: string): string {
  const when = e.allDay
    ? `all day ${formatInTz(e.start, tz).split(',').slice(0, 2).join(',')}`
    : `${formatInTz(e.start, tz)} → ${formatInTz(e.end, tz)}`;
  const bits = [`[id:${e.id}] ${e.title} — ${when}`];
  if (e.location) bits.push(`at ${e.location}`);
  if (e.description) bits.push(`(${e.description})`);
  return bits.join(' ');
}

function renderConflicts(conflicts: CalendarEvent[], tz: string): string {
  return conflicts.map((c) => `- ${renderEvent(c, tz)}`).join('\n');
}

export const getCalendarEvents = defineTool({
  name: 'get_calendar_events',
  description:
    'Read the client\'s REAL Google Calendar for a time window — live, includes everything on it regardless of how it was added (by you or directly in the Calendar app). Call this before answering any schedule question and before creating/moving events.',
  schema: z.object({
    from: isoDateTime.describe('Window start (ISO 8601).'),
    to: isoDateTime.describe('Window end (ISO 8601).'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50).'),
  }),
  async execute(input, ctx) {
    if (!ctx.calendar) return NOT_CONNECTED;
    const events = await ctx.calendar.listEvents({
      from: input.from,
      to: input.to,
      limit: input.limit,
    });
    if (events.length === 0) return 'No calendar events in that window.';
    const tz = ctx.client.timezone;
    return events.map((e) => renderEvent(e, tz)).join('\n');
  },
});

async function conflictWarning(
  ctx: ToolContext,
  start: Date,
  end: Date,
  excludeEventId?: string,
): Promise<string | null> {
  if (!ctx.calendar) return null;
  const conflicts = await ctx.calendar.findConflicts(start, end, excludeEventId);
  if (conflicts.length === 0) return null;
  return renderConflicts(conflicts, ctx.client.timezone);
}

export const findFreeTime = defineTool({
  name: 'find_free_time',
  description:
    'Find open time slots on the client\'s live calendar within a window. Use this to propose alternatives when a requested time is busy, or when the client asks "when am I free?". Returns the earliest open slots first.',
  schema: z.object({
    from: isoDateTime.describe('Earliest time to consider (ISO 8601).'),
    to: isoDateTime.describe('Latest time to consider (ISO 8601).'),
    duration_minutes: z
      .number()
      .int()
      .min(5)
      .max(1440)
      .describe('How long the slot needs to be, in minutes.'),
    limit: z.number().int().min(1).max(10).optional().describe('Max slots to return (default 5).'),
  }),
  async execute(input, ctx) {
    if (!ctx.calendar) return NOT_CONNECTED;
    if (input.to <= input.from) return 'ERROR: "to" must be after "from".';
    // Never propose times in the past.
    const from = input.from.getTime() < ctx.now.getTime() ? ctx.now : input.from;
    if (input.to <= from) return 'That window is already in the past.';
    const tz = ctx.client.timezone;
    const slots = await ctx.calendar.findFreeSlots({
      from,
      to: input.to,
      durationMinutes: input.duration_minutes,
      limit: 20,
    });
    // Prefer sensible waking hours (8am–9pm local); fall back to any slot only
    // if daytime is fully booked, so we never lead with a 2 AM suggestion.
    const localHour = (d: Date): number =>
      Number(
        new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(d),
      );
    const daytime = slots.filter((s) => {
      const h = localHour(s.start);
      return h >= 8 && h < 21;
    });
    const chosen = (daytime.length > 0 ? daytime : slots).slice(0, input.limit ?? 5);
    if (chosen.length === 0) return 'No open slots of that length in that window.';
    return chosen.map((s) => `- ${formatInTz(s.start, tz)} → ${formatInTz(s.end, tz)}`).join('\n');
  },
});

export const createCalendarEvent = defineTool({
  name: 'create_calendar_event',
  description:
    "Create an event on the client's Google Calendar. ONLY for meetings and genuinely time-blocked important events — ordinary tasks belong in create_task. Automatically refuses double-bookings unless allow_conflict is true (set it only after the client explicitly confirms). Set reminder_minutes_before to also send the client a Telegram reminder before the meeting — use their default lead time unless they say otherwise.",
  schema: z.object({
    title: z.string().min(1).max(300),
    start: isoDateTime.describe('Event start (ISO 8601).'),
    end: isoDateTime.describe('Event end (ISO 8601). Must be after start.'),
    description: z.string().max(2000).optional(),
    location: z.string().max(300).optional(),
    reminder_minutes_before: z
      .number()
      .int()
      .min(0)
      .max(10080)
      .optional()
      .describe(
        "Minutes before the meeting to send a Telegram reminder. Use the client's default lead time unless they specify otherwise; omit or 0 for no reminder.",
      ),
    allow_conflict: z
      .boolean()
      .optional()
      .describe('Set true ONLY after the client explicitly confirmed a double-booking.'),
  }),
  async execute(input, ctx) {
    if (!ctx.calendar) return NOT_CONNECTED;
    if (input.end <= input.start) return 'ERROR: end must be after start. Nothing was created.';
    if (!input.allow_conflict) {
      const conflicts = await conflictWarning(ctx, input.start, input.end);
      if (conflicts) {
        return `CONFLICT — nothing was created. The requested time overlaps:\n${conflicts}\nAsk the client whether to pick another time or book anyway (then retry with allow_conflict=true).`;
      }
    }
    const event = await ctx.calendar.createEvent({
      title: input.title,
      start: input.start,
      end: input.end,
      description: input.description,
      location: input.location,
    });

    let reminderNote = '';
    if (input.reminder_minutes_before && input.reminder_minutes_before > 0) {
      // A companion reminder in our DB drives the Telegram ping via the same
      // reliable reminder cron the tasks use (the calendar itself is not
      // polled). It's linked to the event id so it moves/cancels with it.
      const reminderAt = new Date(input.start.getTime() - input.reminder_minutes_before * 60_000);
      if (reminderAt.getTime() > ctx.now.getTime()) {
        await ctx.repo.createTask({
          title: `Reminder: ${input.title}`,
          type: 'reminder',
          reminderAt,
          sourceEventId: event.id,
          reminderLeadMinutes: input.reminder_minutes_before,
        });
        reminderNote = ` I'll remind you ${input.reminder_minutes_before} min before.`;
      } else {
        // The lead time is already in the past (e.g. booking a meeting that
        // starts in under `reminder_minutes_before`). Never claim a reminder we
        // didn't set — tell the client plainly.
        reminderNote = ` (The meeting is under ${input.reminder_minutes_before} min away, so I didn't set a separate reminder.)`;
      }
    }
    return `Created on calendar: ${renderEvent(event, ctx.client.timezone)}.${reminderNote}`;
  },
});

export const updateCalendarEvent = defineTool({
  name: 'update_calendar_event',
  description:
    'Update/move/rename an existing calendar event. Get the event id from get_calendar_events first. Moving an event re-checks conflicts unless allow_conflict is true.',
  schema: z.object({
    event_id: z.string().min(1).describe('The event id from get_calendar_events.'),
    title: z.string().min(1).max(300).optional(),
    start: isoDateTime.optional().describe('New start (ISO 8601). Provide end too when moving.'),
    end: isoDateTime.optional().describe('New end (ISO 8601).'),
    description: z.string().max(2000).optional(),
    location: z.string().max(300).optional(),
    reminder_minutes_before: z
      .number()
      .int()
      .min(0)
      .max(10080)
      .optional()
      .describe('Change the Telegram reminder lead (0 to remove it). If omitted, an existing reminder is kept and moves with the event.'),
    allow_conflict: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    if (!ctx.calendar) return NOT_CONNECTED;
    const { event_id, allow_conflict, reminder_minutes_before, start, end, ...rest } = input;

    // A time change may set only start OR only end. To validate the ordering
    // and re-check conflicts we need BOTH sides, so fetch the current event and
    // fill in whichever side wasn't provided. Without this, a single-sided move
    // ("push my 3pm to 4") would skip the conflict gate → silent double-book.
    const timeChanging = start !== undefined || end !== undefined;
    let effStart = start;
    let effEnd = end;
    if (timeChanging && (start === undefined || end === undefined)) {
      const current = await ctx.calendar.getEvent(event_id);
      if (!current) {
        return `ERROR: no calendar event with id ${event_id} exists. Nothing was changed.`;
      }
      effStart = start ?? current.start;
      effEnd = end ?? current.end;
    }
    if (effStart && effEnd && effEnd <= effStart) {
      return 'ERROR: end must be after start. Nothing was changed.';
    }
    if (timeChanging && effStart && effEnd && !allow_conflict) {
      const conflicts = await conflictWarning(ctx, effStart, effEnd, event_id);
      if (conflicts) {
        return `CONFLICT — nothing was changed. The new time overlaps:\n${conflicts}\nAsk the client whether to pick another time or move anyway (then retry with allow_conflict=true).`;
      }
    }
    const event = await ctx.calendar.updateEvent(event_id, { ...rest, start, end });

    // Keep the companion reminder correct: explicit lead wins; otherwise a
    // moved event preserves its existing lead; a title-only edit leaves it be.
    let reminderNote = '';
    let desiredLead: number | null | undefined;
    if (reminder_minutes_before !== undefined) desiredLead = reminder_minutes_before;
    else if (start !== undefined) desiredLead = await ctx.repo.getEventReminderLead(event_id);
    if (desiredLead !== undefined) {
      await ctx.repo.deleteEventReminders(event_id);
      if (desiredLead && desiredLead > 0) {
        const remAt = new Date(event.start.getTime() - desiredLead * 60_000);
        if (remAt.getTime() > ctx.now.getTime()) {
          await ctx.repo.createTask({
            title: `Reminder: ${event.title}`,
            type: 'reminder',
            reminderAt: remAt,
            sourceEventId: event_id,
            reminderLeadMinutes: desiredLead,
          });
          reminderNote = ` Reminder set ${desiredLead} min before.`;
        } else if (event.start.getTime() > ctx.now.getTime()) {
          // Lead time already past but the event is still upcoming — never drop
          // the reminder silently; say so plainly so the reply can't imply one.
          reminderNote = ` (Heads up: ${desiredLead} min before is already past, so I didn't set a separate reminder for it.)`;
        }
      } else if (reminder_minutes_before === 0) {
        reminderNote = ' Reminder removed.';
      }
    }
    return `Updated on calendar: ${renderEvent(event, ctx.client.timezone)}.${reminderNote}`;
  },
});

export const deleteCalendarEvent = defineTool({
  name: 'delete_calendar_event',
  description:
    'Delete a calendar event. Only when the client explicitly asks to cancel/remove it. Get the event id from get_calendar_events first.',
  schema: z.object({
    event_id: z.string().min(1).describe('The event id from get_calendar_events.'),
  }),
  async execute(input, ctx) {
    if (!ctx.calendar) return NOT_CONNECTED;
    // Confirm it exists first so "cancel lunch" on an already-removed event
    // gives a clean, quotable message instead of a raw Google 404/410.
    const existing = await ctx.calendar.getEvent(input.event_id);
    if (!existing) {
      // Still clear any orphaned companion reminder, then report honestly.
      await ctx.repo.deleteEventReminders(input.event_id);
      return `ERROR: no calendar event with id ${input.event_id} exists (already removed?). Nothing to delete.`;
    }
    await ctx.calendar.deleteEvent(input.event_id);
    // Cancel any Telegram reminder tied to this event so it never fires late.
    await ctx.repo.deleteEventReminders(input.event_id);
    return `Deleted calendar event: ${existing.title}.`;
  },
});
