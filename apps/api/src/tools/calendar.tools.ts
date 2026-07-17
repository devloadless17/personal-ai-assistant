import { z } from 'zod';
import { defineTool } from './tool.types';
import type { CalendarEvent, ToolContext } from './tool.types';
import { repeatBaseSchema, repeatToFields, repeatToRRule } from './tasks.tools';
import { formatInTz, isoDateTime } from './time';

const NOT_CONNECTED =
  'ERROR: Google Calendar is not connected for this client yet. Tell the client their calendar isn\'t linked and that the administrator can send them a connection link. Do NOT claim any calendar action succeeded.';

function renderEvent(e: CalendarEvent, tz: string): string {
  const when = e.allDay
    ? `all day ${formatInTz(e.start, tz).split(',').slice(0, 2).join(',')}`
    : `${formatInTz(e.start, tz)} → ${formatInTz(e.end, tz)}`;
  const bits = [`[id:${e.id}] ${e.title} — ${when}`];
  if (e.recurring) bits.push('(recurring)');
  if (e.location) bits.push(`at ${e.location}`);
  if (e.attendees && e.attendees.length > 0) bits.push(`with ${e.attendees.join(', ')}`);
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
  const tz = ctx.client.timezone;
  let out = renderConflicts(conflicts, tz);

  // SMART SCHEDULING: proactively offer concrete alternatives in the SAME
  // result — the assistant presents them directly instead of having to
  // re-derive with find_free_time. Search around the requested time for the
  // nearest open slots of the same duration.
  const durationMinutes = Math.max(5, Math.round((end.getTime() - start.getTime()) / 60_000));
  const searchFrom = start.getTime() > ctx.now.getTime() ? start : ctx.now;
  const searchTo = new Date(end.getTime() + 3 * 24 * 60 * 60_000); // look up to ~3 days out
  const slots = await ctx.calendar.findFreeSlots({
    from: searchFrom,
    to: searchTo,
    durationMinutes,
    limit: 3,
  });
  if (slots.length > 0) {
    out +=
      '\nNearest open times:\n' +
      slots.map((s) => `- ${formatInTz(s.start, tz)} → ${formatInTz(s.end, tz)}`).join('\n');
  }
  return out;
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
      limit: input.limit ?? 5,
    });
    // No working-hours filter by design: the client schedules at ANY hour. Slots
    // are earliest-first within the window the client asked about, so the window
    // itself (e.g. "tomorrow afternoon") scopes the suggestions.
    if (slots.length === 0) return 'No open slots of that length in that window.';
    return slots.map((s) => `- ${formatInTz(s.start, tz)} → ${formatInTz(s.end, tz)}`).join('\n');
  },
});

export const createCalendarEvent = defineTool({
  name: 'create_calendar_event',
  description:
    "Create an event on the client's Google Calendar. ONLY for meetings and genuinely time-blocked important events — ordinary tasks belong in create_task. Automatically refuses double-bookings unless allow_conflict is true (set it only after the client explicitly confirms). Set reminder_minutes_before to also send the client a Telegram reminder before the meeting — use their default lead time unless they say otherwise. Add attendees to include other people; set send_invites ONLY when the client explicitly asks to invite/notify them.",
  schema: z.object({
    title: z.string().min(1).max(300),
    start: isoDateTime.describe('Event start (ISO 8601).'),
    end: isoDateTime.describe('Event end (ISO 8601). Must be after start.'),
    description: z.string().max(2000).optional(),
    location: z.string().max(300).optional(),
    attendees: z
      .array(z.string().email())
      .max(50)
      .optional()
      .describe('Guest email addresses to add to the event — only ones the client explicitly gave you; never invent or guess an address.'),
    send_invites: z
      .boolean()
      .optional()
      .describe(
        'Email the attendees an invite. Default false (added silently). Set true ONLY when the client explicitly says to invite/notify them ("and invite them").',
      ),
    repeat: repeatBaseSchema
      .optional()
      .describe(
        'Make it a RECURRING meeting ("every Saturday", "every weekday", "monthly") — creates a native repeating Google Calendar event.',
      ),
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
    // Conflict-check only the FIRST occurrence (recurring series can't be fully
    // pre-checked); still catches the common "this slot is taken" case.
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
      attendees: input.attendees,
      sendInvites: input.send_invites,
      recurrence: input.repeat ? repeatToRRule(input.repeat) : undefined,
    });

    let reminderNote = '';
    if (input.reminder_minutes_before && input.reminder_minutes_before > 0) {
      // A companion reminder in our DB drives the Telegram ping via the same
      // reliable reminder cron the tasks use (the calendar itself is not
      // polled). Keyed on the SERIES master id so it moves/cancels with the event.
      const reminderAt = new Date(input.start.getTime() - input.reminder_minutes_before * 60_000);
      if (reminderAt.getTime() > ctx.now.getTime()) {
        // A recurring meeting gets a RECURRING companion reminder (ping before
        // EACH occurrence) — unless the pattern is one our DB cron can't
        // represent (weekly interval>1 with weekdays), where it's one-shot.
        const rep = input.repeat;
        const companionRec =
          rep && !(rep.freq === 'weekly' && (rep.interval ?? 1) > 1 && (rep.weekdays?.length ?? 0) > 0)
            ? { ...repeatToFields(rep), recurrenceAnchor: reminderAt }
            : null;
        try {
          await ctx.repo.createTask({
            title: input.title, // the cron prefixes "⏰ Reminder:" — don't double it
            type: 'reminder',
            reminderAt,
            sourceEventId: event.seriesId ?? event.id,
            reminderLeadMinutes: input.reminder_minutes_before,
            ...(companionRec ?? {}),
          });
          // Only say "each time" when the ping actually recurs.
          reminderNote = ` I'll remind you ${input.reminder_minutes_before} min before${companionRec ? ' each time' : ''}.`;
        } catch {
          // The event IS on the calendar; only the companion reminder failed.
          // Degrade honestly rather than reporting total failure (which would
          // make the client re-book → duplicate event).
          reminderNote =
            " (The meeting is on your calendar, but I couldn't set the Telegram reminder — ask me to add it again.)";
        }
      } else {
        // The lead time is already in the past (e.g. booking a meeting that
        // starts in under `reminder_minutes_before`). Never claim a reminder we
        // didn't set — tell the client plainly.
        reminderNote = ` (The meeting is under ${input.reminder_minutes_before} min away, so I didn't set a separate reminder.)`;
      }
    }
    let inviteNote = '';
    if (input.attendees && input.attendees.length > 0) {
      inviteNote = input.send_invites
        ? ` Invites emailed to ${input.attendees.join(', ')}.`
        : ` ${input.attendees.join(', ')} added as guest(s) — no invite emailed (say "invite them" to notify).`;
    }
    return `Created on calendar: ${renderEvent(event, ctx.client.timezone)}.${reminderNote}${inviteNote}`;
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
    attendees: z
      .array(z.string().email())
      .max(50)
      .optional()
      .describe('Replace the full guest list with these emails — only ones the client explicitly gave you; never invent or guess an address.'),
    send_invites: z
      .boolean()
      .optional()
      .describe('Email attendees about the change. Default false; true ONLY when the client says to invite/notify them.'),
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
    const { event_id, allow_conflict, reminder_minutes_before, start, end, attendees, send_invites, ...rest } =
      input;

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
    const event = await ctx.calendar.updateEvent(event_id, {
      ...rest,
      start,
      end,
      ...(attendees !== undefined ? { attendees } : {}),
      ...(send_invites !== undefined ? { sendInvites: send_invites } : {}),
    });

    // Keep the companion reminder correct. Resolve the SERIES master id so a
    // recurring instance still matches its (series-keyed) companion.
    const seriesId = event.seriesId ?? event_id;
    let reminderNote = '';
    let desiredLead: number | null | undefined;
    // Read the existing companion up front so a move can PRESERVE its recurrence.
    const existingReminder = await ctx.repo.getEventReminder(seriesId);
    if (reminder_minutes_before !== undefined) desiredLead = reminder_minutes_before;
    else if (start !== undefined) desiredLead = existingReminder?.reminderLeadMinutes ?? undefined;
    if (desiredLead !== undefined) {
      try {
        await ctx.repo.deleteEventReminders(seriesId);
        if (desiredLead && desiredLead > 0) {
          const remAt = new Date(event.start.getTime() - desiredLead * 60_000);
          if (remAt.getTime() > ctx.now.getTime()) {
            // Preserve recurrence on a move so a recurring meeting keeps pinging
            // before EVERY occurrence, not just the next one.
            const rec = existingReminder?.recurrenceFreq
              ? {
                  recurrenceFreq: existingReminder.recurrenceFreq,
                  recurrenceInterval: existingReminder.recurrenceInterval ?? 1,
                  recurrenceWeekdays: existingReminder.recurrenceWeekdays,
                  recurrenceUntil: existingReminder.recurrenceUntil,
                  recurrenceAnchor: remAt,
                }
              : {};
            await ctx.repo.createTask({
              title: event.title,
              type: 'reminder',
              reminderAt: remAt,
              sourceEventId: seriesId,
              reminderLeadMinutes: desiredLead,
              ...rec,
            });
            reminderNote = ` Reminder set ${desiredLead} min before${existingReminder?.recurrenceFreq ? ' each time' : ''}.`;
          } else if (event.start.getTime() > ctx.now.getTime()) {
            reminderNote = ` (Heads up: ${desiredLead} min before is already past, so I didn't set a separate reminder for it.)`;
          }
        } else if (reminder_minutes_before === 0) {
          reminderNote = ' Reminder removed.';
        }
      } catch {
        // Google move landed; only the companion DB work failed — degrade honestly.
        reminderNote =
          " (The event was updated, but I couldn't adjust its Telegram reminder — ask me to set it again.)";
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
      // Still clear any orphaned companion reminder (by series id), then report.
      await ctx.repo.deleteEventReminders(input.event_id);
      return `ERROR: no calendar event with id ${input.event_id} exists (already removed?). Nothing to delete.`;
    }
    await ctx.calendar.deleteEvent(input.event_id);
    // Cancel the companion reminder keyed on the SERIES master id — otherwise a
    // recurring meeting's reminder keeps firing forever after cancellation.
    await ctx.repo.deleteEventReminders(existing.seriesId ?? input.event_id);
    return `Deleted calendar event: ${existing.title}.`;
  },
});
