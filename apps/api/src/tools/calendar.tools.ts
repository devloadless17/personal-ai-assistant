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

export const createCalendarEvent = defineTool({
  name: 'create_calendar_event',
  description:
    'Create an event on the client\'s Google Calendar. ONLY for meetings and genuinely time-blocked important events — ordinary tasks belong in create_task. Automatically refuses double-bookings unless allow_conflict is true (set it only after the client explicitly confirms).',
  schema: z.object({
    title: z.string().min(1).max(300),
    start: isoDateTime.describe('Event start (ISO 8601).'),
    end: isoDateTime.describe('Event end (ISO 8601). Must be after start.'),
    description: z.string().max(2000).optional(),
    location: z.string().max(300).optional(),
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
    return `Created on calendar: ${renderEvent(event, ctx.client.timezone)}`;
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
    allow_conflict: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    if (!ctx.calendar) return NOT_CONNECTED;
    if (input.start && input.end && input.end <= input.start) {
      return 'ERROR: end must be after start. Nothing was changed.';
    }
    if (input.start && input.end && !input.allow_conflict) {
      const conflicts = await conflictWarning(ctx, input.start, input.end, input.event_id);
      if (conflicts) {
        return `CONFLICT — nothing was changed. The new time overlaps:\n${conflicts}\nAsk the client whether to pick another time or move anyway (then retry with allow_conflict=true).`;
      }
    }
    const { event_id, allow_conflict, ...changes } = input;
    void allow_conflict; // consumed by the conflict gate above
    const event = await ctx.calendar.updateEvent(event_id, changes);
    return `Updated on calendar: ${renderEvent(event, ctx.client.timezone)}`;
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
    await ctx.calendar.deleteEvent(input.event_id);
    return `Deleted calendar event ${input.event_id}.`;
  },
});
