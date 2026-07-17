import { z } from 'zod';
import { defineTool } from './tool.types';
import type { CalendarEvent, ToolContext } from './tool.types';
import { repeatBaseSchema, repeatToFields, repeatToRRule } from './tasks.tools';
import { firstFutureOccurrence, formatInTz, isoDateTime, isoInTz, withClientOffset } from './time';

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
    end: isoDateTime
      .optional()
      .describe(
        'Event end (ISO 8601). OMIT it when the client only gave a start — the system then applies their default meeting length (or duration_minutes). Provide it only when they gave an explicit end time.',
      ),
    duration_minutes: z
      .number()
      .int()
      .min(5)
      .max(1440)
      .optional()
      .describe(
        'Meeting length in minutes when the client states a duration for THIS event ("just 30 minutes", "a 2-hour workshop"). Overrides the client default. Ignored if end is given.',
      ),
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
    // End is resolved SERVER-SIDE: explicit end wins; else start + this event's
    // duration; else the client's configurable default meeting length. The model
    // never has to do the arithmetic (and the client default is applied here).
    const end =
      input.end ??
      new Date(
        input.start.getTime() +
          (input.duration_minutes ?? ctx.client.defaultMeetingMinutes) * 60_000,
      );
    if (end <= input.start) return 'ERROR: end must be after start. Nothing was created.';
    // Conflict-check only the FIRST occurrence (recurring series can't be fully
    // pre-checked); still catches the common "this slot is taken" case.
    if (!input.allow_conflict) {
      const conflicts = await conflictWarning(ctx, input.start, end);
      if (conflicts) {
        return `CONFLICT — nothing was created. The requested time overlaps:\n${conflicts}\nAsk the client whether to pick another time or book anyway (then retry with allow_conflict=true).`;
      }
    }
    const event = await ctx.calendar.createEvent({
      title: input.title,
      start: input.start,
      end,
      description: input.description,
      location: input.location,
      attendees: input.attendees,
      sendInvites: input.send_invites,
      recurrence: input.repeat ? repeatToRRule(input.repeat) : undefined,
      // Stamp the client's LIVE zone so a same-turn travel switch is reflected.
      timeZone: ctx.client.timezone,
    });

    let reminderNote = '';
    if (input.reminder_minutes_before && input.reminder_minutes_before > 0) {
      // A companion reminder in our DB drives the Telegram ping via the same
      // reliable reminder cron the tasks use (the calendar itself is not
      // polled). Keyed on the SERIES master id so it moves/cancels with the event.
      const firstAnchor = new Date(input.start.getTime() - input.reminder_minutes_before * 60_000);
      // A recurring meeting gets a RECURRING companion (ping before EACH
      // occurrence) — unless the pattern is one our DB cron can't represent.
      const rep = input.repeat;
      const companionRec =
        rep && !(rep.freq === 'weekly' && (rep.interval ?? 1) > 1 && (rep.weekdays?.length ?? 0) > 0)
          ? repeatToFields(rep)
          : null;
      // For a recurring companion whose FIRST reminder is already past (e.g. the
      // series' first occurrence is today and the lead has elapsed), arm the next
      // FUTURE occurrence instead of dropping every future ping.
      const reminderAt = companionRec
        ? firstFutureOccurrence(
            firstAnchor,
            companionRec.recurrenceFreq,
            companionRec.recurrenceInterval,
            companionRec.recurrenceWeekdays,
            ctx.client.timezone,
            ctx.now,
            companionRec.recurrenceUntil,
          )
        : firstAnchor.getTime() > ctx.now.getTime()
          ? firstAnchor
          : null;
      if (reminderAt) {
        try {
          await ctx.repo.createTask({
            title: input.title, // the cron prefixes "⏰ Reminder:" — don't double it
            type: 'reminder',
            reminderAt,
            sourceEventId: event.seriesId ?? event.id,
            reminderLeadMinutes: input.reminder_minutes_before,
            // Pin the companion to the event's zone so its pings don't drift
            // relative to the meeting when the client travels across a DST change.
            ...(companionRec
              ? { ...companionRec, recurrenceAnchor: firstAnchor, recurrenceTimezone: ctx.client.timezone }
              : {}),
          });
          reminderNote = ` I'll remind you ${input.reminder_minutes_before} min before${companionRec ? ' each time' : ''}.`;
        } catch {
          // The event IS on the calendar; only the companion reminder failed.
          // Degrade honestly rather than reporting total failure (which would
          // make the client re-book → duplicate event).
          reminderNote =
            " (The meeting is on your calendar, but I couldn't set the Telegram reminder — ask me to add it again.)";
        }
      } else {
        // Non-recurring meeting whose lead time is already past — never claim a
        // reminder we didn't set.
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
    'Update/move/rename an existing calendar event. Get the event id from get_calendar_events first. For a RECURRING event this changes the WHOLE series by default (all occurrences) — pass apply_to:"this_event" only when the client says to change just one occurrence. Moving re-checks conflicts unless allow_conflict is true.',
  schema: z.object({
    event_id: z.string().min(1).describe('The event id from get_calendar_events.'),
    apply_to: z
      .enum(['series', 'this_event'])
      .optional()
      .describe(
        'For a recurring event: "series" (DEFAULT) changes every occurrence; "this_event" changes only the single instance. Use this_event ONLY when the client says "just this one / only next X".',
      ),
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
    const { event_id, apply_to, allow_conflict, reminder_minutes_before, start, end, attendees, send_invites, ...rest } =
      input;
    const tz = ctx.client.timezone;

    // Fetch the current event once — needed to fill a single-sided time change
    // AND to detect recurrence + resolve the SERIES master id.
    const current = await ctx.calendar.getEvent(event_id);
    if (!current) {
      return `ERROR: no calendar event with id ${event_id} exists. Nothing was changed.`;
    }
    // For a recurring event, default to updating the WHOLE series (the master),
    // so a change like "make it 2 hours" applies to every occurrence — not just
    // the one instance the id refers to. Only touch a single instance when the
    // client explicitly asked ("just this one").
    const applyToSeries = (current.recurring ?? false) && apply_to !== 'this_event';
    const targetId = applyToSeries ? (current.seriesId ?? event_id) : event_id;

    const timeChanging = start !== undefined || end !== undefined;
    // Fill a single-sided time change from the current event so ordering +
    // conflict checks have both sides.
    const effStart = start ?? (timeChanging ? current.start : undefined);
    const effEnd = end ?? (timeChanging ? current.end : undefined);
    if (effStart && effEnd && effEnd <= effStart) {
      return 'ERROR: end must be after start. Nothing was changed.';
    }
    if (timeChanging && effStart && effEnd && !allow_conflict) {
      // Exclude the event's OWN occurrence (the instance id we're editing) so it
      // doesn't flag itself as a clash.
      const conflicts = await conflictWarning(ctx, effStart, effEnd, event_id);
      if (conflicts) {
        return `CONFLICT — nothing was changed. The new time overlaps:\n${conflicts}\nAsk the client whether to pick another time or move anyway (then retry with allow_conflict=true).`;
      }
    }

    // What start/end to write. For a SERIES time change, apply the new
    // time-of-day + duration to the MASTER's own date, so every occurrence
    // shifts to the new time and NO occurrences are dropped (patching the master
    // with an instance's absolute date would re-anchor/prune the series).
    let patchStart = start;
    let patchEnd = end;
    if (applyToSeries && timeChanging && effStart && effEnd) {
      const master =
        current.seriesId && current.seriesId !== current.id
          ? ((await ctx.calendar.getEvent(current.seriesId)) ?? current)
          : current;
      const masterDate = isoInTz(master.start, tz).slice(0, 10); // YYYY-MM-DD (master's day)
      const newTime = isoInTz(effStart, tz).slice(11, 19); // HH:MM:SS (requested time-of-day)
      patchStart = new Date(withClientOffset(`${masterDate}T${newTime}`, tz));
      patchEnd = new Date(patchStart.getTime() + (effEnd.getTime() - effStart.getTime()));
    }

    const event = await ctx.calendar.updateEvent(targetId, {
      ...rest,
      start: patchStart,
      end: patchEnd,
      // Stamp the client's live zone so a moved event reflects a same-turn
      // travel switch (only applied by the gateway when start/end change).
      timeZone: tz,
      ...(attendees !== undefined ? { attendees } : {}),
      ...(send_invites !== undefined ? { sendInvites: send_invites } : {}),
    });

    // Keep the companion reminder correct, keyed on the SERIES master id.
    const seriesId = event.seriesId ?? targetId;
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
          const firstAnchor = new Date(event.start.getTime() - desiredLead * 60_000);
          const recFreq = existingReminder?.recurrenceFreq;
          // Preserve recurrence so a recurring meeting keeps pinging before EVERY
          // occurrence. For a series whose master (DTSTART) is in the PAST — the
          // common case when adding a reminder to an established standup — arm the
          // next FUTURE occurrence rather than dropping the whole reminder series.
          const remAt = recFreq
            ? firstFutureOccurrence(
                firstAnchor,
                recFreq,
                existingReminder.recurrenceInterval ?? 1,
                existingReminder.recurrenceWeekdays,
                ctx.client.timezone,
                ctx.now,
                existingReminder.recurrenceUntil,
              )
            : firstAnchor.getTime() > ctx.now.getTime()
              ? firstAnchor
              : null;
          if (remAt) {
            const rec = recFreq
              ? {
                  recurrenceFreq: recFreq,
                  recurrenceInterval: existingReminder.recurrenceInterval ?? 1,
                  recurrenceWeekdays: existingReminder.recurrenceWeekdays,
                  recurrenceUntil: existingReminder.recurrenceUntil,
                  recurrenceAnchor: firstAnchor,
                  recurrenceTimezone: ctx.client.timezone,
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
            reminderNote = ` Reminder set ${desiredLead} min before${recFreq ? ' each time' : ''}.`;
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
    const scopeNote = applyToSeries
      ? ' — applied to the whole recurring series'
      : current.recurring
        ? ' — this occurrence only'
        : '';
    return `Updated on calendar: ${renderEvent(event, ctx.client.timezone)}${scopeNote}.${reminderNote}`;
  },
});

export const deleteCalendarEvent = defineTool({
  name: 'delete_calendar_event',
  description:
    'Delete a calendar event. Only when the client explicitly asks to cancel/remove it. Get the event id from get_calendar_events first. For a RECURRING event this cancels the WHOLE series by default — pass apply_to:"this_event" only when the client wants to cancel just one occurrence.',
  schema: z.object({
    event_id: z.string().min(1).describe('The event id from get_calendar_events.'),
    apply_to: z
      .enum(['series', 'this_event'])
      .optional()
      .describe(
        'For a recurring event: "series" (DEFAULT) cancels every occurrence; "this_event" cancels only the one instance. Use this_event ONLY when the client says "just this one / only next X".',
      ),
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
    // For a recurring event, cancel the WHOLE series (the master) by default —
    // deleting an instance id removes only that one occurrence. Only delete a
    // single instance when the client explicitly asked.
    const applyToSeries = (existing.recurring ?? false) && input.apply_to !== 'this_event';
    const targetId = applyToSeries ? (existing.seriesId ?? input.event_id) : input.event_id;
    await ctx.calendar.deleteEvent(targetId);
    // Cancel the companion reminder keyed on the SERIES master id.
    await ctx.repo.deleteEventReminders(existing.seriesId ?? input.event_id);
    const scope = applyToSeries
      ? ' (whole recurring series)'
      : existing.recurring
        ? ' (this occurrence only)'
        : '';
    return `Deleted calendar event: ${existing.title}${scope}.`;
  },
});
