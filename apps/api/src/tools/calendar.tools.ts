import { z } from 'zod';
import { defineTool } from './tool.types';
import type { CalendarEvent, ToolContext } from './tool.types';
import { repeatBaseSchema, repeatToFields, repeatToRRule, type RepeatInput } from './tasks.tools';
import {
  firstFutureOccurrence,
  isDayScaleSpan,
  nextOccurrence,
  formatInTz,
  formatLeads,
  isoDateTime,
  isoInTz,
  localWeekday,
  withClientOffset,
} from './time';

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
    'Read the client\'s REAL Google Calendar for a time window — live, includes everything on it regardless of how it was added (by you or directly in the Calendar app). Call this before answering any schedule question, and to get an event id before updating or deleting one. You do NOT need it before creating or moving an event — those tools check for clashes automatically, so an extra read just slows the client down.',
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

const normalizeTitle = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Full client-facing guidance when [start,end) clashes with existing events, or
 * null if it's free. Two shapes:
 * - DUPLICATE: a clash whose title matches `title` is almost certainly the SAME
 *   meeting (e.g. a re-ask after it already booked) — say that, don't offer new
 *   slots. This is a UX fix, not a scheduling clash.
 * - CLASH: a genuine overlap with a differently-named event → list it + the
 *   nearest open slots so the assistant can offer alternatives in one shot.
 * `verb` = "created" (create) or "changed" (move) so the message reads right.
 */
async function conflictWarning(
  ctx: ToolContext,
  start: Date,
  end: Date,
  opts: { verb: 'created' | 'changed'; excludeEventId?: string; title?: string },
): Promise<string | null> {
  if (!ctx.calendar) return null;
  const conflicts = await ctx.calendar.findConflicts(start, end, opts.excludeEventId);
  if (conflicts.length === 0) return null;
  const tz = ctx.client.timezone;

  if (opts.title) {
    const dup = conflicts.find((c) => normalizeTitle(c.title) === normalizeTitle(opts.title as string));
    if (dup) {
      return `ALREADY EXISTS — nothing was ${opts.verb}. "${dup.title}" is already on the calendar at ${formatInTz(dup.start, tz)} → ${formatInTz(dup.end, tz)}. This is almost certainly the SAME meeting (do NOT offer other times as if it were a clash). Tell the client they already have it, and ask whether they want to change that one or genuinely add a separate duplicate (only then retry with allow_conflict=true).`;
    }
  }

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
  const pickVerb = opts.verb === 'created' ? 'book' : 'move';
  const timeWord = opts.verb === 'created' ? 'requested' : 'new';
  return `CONFLICT — nothing was ${opts.verb}. The ${timeWord} time overlaps:\n${out}\nAsk the client whether to pick another time or ${pickVerb} anyway (then retry with allow_conflict=true).`;
}

/**
 * Arm ONE companion reminder per lead (minutes before) for a meeting — so a
 * client can have several pings (e.g. an hour before AND ten minutes before).
 * Each companion is an independent Task the reminder cron fires on its own, keyed
 * on the series master id so they all move/cancel with the event. Recurring
 * meetings get recurring companions (skipping any already-past first occurrence
 * via firstFutureOccurrence). Returns a human note listing the pings actually set.
 */
type CompanionRecurrence = ReturnType<typeof repeatToFields> | null;

/** A repeat spec → companion recurrence fields, unless it's a pattern our DB
 * cron can't represent (weekly interval>1 WITH weekdays), where it's one-shot. */
/**
 * Recover a MEETING's own weekdays from a companion's stored (already-shifted)
 * ones.
 *
 * armEventReminders stores weekdays shifted back by the lead's midnight-crossing
 * day-delta, so a 10h lead on a Monday 07:00 meeting is stored as Sunday. When an
 * update rebuilds the companions it must hand armEventReminders the MEETING's
 * weekdays, because that function applies the shift itself — feeding the stored
 * value straight back shifted it a SECOND time, moving every ping one more day
 * earlier on every single edit (Mon meeting → Sat ping, then Fri, …). Undoing the
 * shift with the companion's OWN lead yields the lead-independent meeting days,
 * which is also why the result can safely be reused for every other lead.
 */
function unshiftCompanionWeekdays(
  storedWeekdays: number[],
  leadMinutes: number | null,
  eventStart: Date,
  zone: string,
): number[] {
  if (storedWeekdays.length === 0 || !leadMinutes || leadMinutes <= 0) return storedWeekdays;
  const anchor = new Date(eventStart.getTime() - leadMinutes * 60_000);
  const shift = (localWeekday(eventStart, zone) - localWeekday(anchor, zone) + 7) % 7;
  if (shift === 0) return storedWeekdays;
  return storedWeekdays.map((w) => (((w + shift) % 7) + 7) % 7);
}

function companionRecurrenceFrom(repeat: RepeatInput | undefined): CompanionRecurrence {
  if (!repeat) return null;
  const unsupported =
    repeat.freq === 'weekly' && (repeat.interval ?? 1) > 1 && (repeat.weekdays?.length ?? 0) > 0;
  return unsupported ? null : repeatToFields(repeat);
}

/**
 * Cancelling ONE occurrence of a recurring meeting must not still ping for it.
 *
 * The series' companions are deliberately left intact (future occurrences still
 * need them), but the ping belonging to the occurrence that no longer exists has
 * to go: otherwise the client is reminded about a meeting they just cancelled.
 * A recurring companion is rolled forward to its next occurrence; a one-shot
 * companion armed for exactly that occurrence is removed.
 */
async function skipCancelledOccurrence(ctx: ToolContext, cancelled: CalendarEvent): Promise<void> {
  const seriesId = cancelled.seriesId ?? cancelled.id;
  const rows = await ctx.repo.getEventReminderRows(seriesId);
  for (const r of rows) {
    if (!r.reminderAt || r.reminderLeadMinutes == null) continue;
    // Does this pending ping belong to the cancelled occurrence?
    const pingForCancelled = cancelled.start.getTime() - r.reminderLeadMinutes * 60_000;
    if (Math.abs(r.reminderAt.getTime() - pingForCancelled) > 60_000) continue;
    if (!r.recurrenceFreq) {
      await ctx.repo.deleteTask(r.id);
      continue;
    }
    const zone = r.recurrenceTimezone ?? ctx.client.timezone;
    const next = nextOccurrence(
      r.reminderAt,
      r.recurrenceFreq,
      r.recurrenceInterval ?? 1,
      r.recurrenceWeekdays,
      zone,
      r.recurrenceAnchor,
    );
    await ctx.repo.updateTask(r.id, { reminderAt: next });
  }
}

async function armEventReminders(
  ctx: ToolContext,
  event: CalendarEvent,
  eventStart: Date,
  leads: number[],
  companionRec: CompanionRecurrence,
  pinnedZone?: string,
  /** True when the meeting recurs but its pattern can't be auto-repeated for
   * reminders (every-other-week + weekdays) — so the client is warned. */
  recurrenceDropped = false,
): Promise<string> {
  // The zone a recurring companion is pinned to: the event's original zone when
  // preserved across a move, else the client's current zone at creation.
  const zone = pinnedZone ?? ctx.client.timezone;
  const positive = Array.from(new Set(leads.filter((n) => Number.isInteger(n) && n > 0))).sort(
    (a, b) => b - a, // earliest ping first
  );
  if (positive.length === 0) return '';
  // An all-day / day-spanning event gets NO lead-based ping: "an hour before"
  // midnight is 23:00 the night before, so the client is woken at bedtime for
  // something that runs all of the next day. The daily brief already lists it.
  if (event.allDay || isDayScaleSpan(eventStart, event.end, pinnedZone ?? ctx.client.timezone)) {
    return " (It runs all day, so I didn't set a timed reminder — an \"hour before\" would land late the previous night. It'll appear in the daily summary that morning.)";
  }
  const seriesId = event.seriesId ?? event.id;
  const armed: number[] = [];
  let anyFailed = false;
  for (const lead of positive) {
    const firstAnchor = new Date(eventStart.getTime() - lead * 60_000);
    // For a WEEKLY-on-specific-weekdays meeting, a lead that crosses local
    // midnight puts the reminder on an EARLIER weekday than the meeting (e.g.
    // "day before" a Monday meeting = Sunday). Recur the companion on the
    // ANCHOR's weekday(s), shifted by the day-delta — otherwise nextOccurrence
    // snaps every future ping back onto the meeting's weekday (wrong day/time).
    let recForLead = companionRec;
    if (companionRec && companionRec.recurrenceFreq === 'WEEKLY' && companionRec.recurrenceWeekdays.length > 0) {
      const shift = (localWeekday(eventStart, zone) - localWeekday(firstAnchor, zone) + 7) % 7;
      if (shift !== 0) {
        recForLead = {
          ...companionRec,
          recurrenceWeekdays: companionRec.recurrenceWeekdays.map((w) => (((w - shift) % 7) + 7) % 7),
        };
      }
    }
    const reminderAt = recForLead
      ? firstFutureOccurrence(
          firstAnchor,
          recForLead.recurrenceFreq,
          recForLead.recurrenceInterval,
          recForLead.recurrenceWeekdays,
          zone,
          ctx.now,
          recForLead.recurrenceUntil,
        )
      : firstAnchor.getTime() > ctx.now.getTime()
        ? firstAnchor
        : null; // one-off whose ping is already past — skip just this lead
    if (!reminderAt) continue;
    try {
      await ctx.repo.createTask({
        title: event.title, // the cron prefixes "⏰ Reminder:" — don't double it
        type: 'reminder',
        reminderAt,
        sourceEventId: seriesId,
        reminderLeadMinutes: lead,
        // Pin each companion to the event's zone so pings don't drift vs the
        // meeting when the client travels across a DST change.
        ...(recForLead
          ? { ...recForLead, recurrenceAnchor: firstAnchor, recurrenceTimezone: zone }
          : {}),
      });
      armed.push(lead);
    } catch {
      anyFailed = true;
    }
  }
  if (armed.length === 0) {
    if (anyFailed)
      return " (The meeting is on your calendar, but I couldn't set the Telegram reminder — ask me to add it again.)";
    // Every lead resolved to a past time. Distinguish the two very different
    // reasons — telling a client "the meeting is sooner than your reminder time"
    // about a meeting weeks away is simply false.
    return eventStart.getTime() > ctx.now.getTime()
      ? " (The meeting is sooner than your reminder time, so I didn't set a separate reminder.)"
      : " (I couldn't work out a future reminder time for this meeting — tell the client no reminder is set and ask them to set one explicitly.)";
  }
  const eachTime = companionRec ? ' each time' : '';
  let note = ` I'll remind you ${formatLeads(armed)} before${eachTime}.`;
  if (recurrenceDropped)
    note +=
      " (Heads up: I can't auto-repeat a reminder for that meeting pattern, so it'll ping before the next one only — ask me to set later ones.)";
  if (anyFailed) note += " (One of the reminders couldn't be set — ask me to add it again.)";
  return note;
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
    "Create an event on the client's Google Calendar. ONLY for meetings and genuinely time-blocked important events — ordinary tasks belong in create_task. Automatically refuses double-bookings unless allow_conflict is true (set it only after the client explicitly confirms). The client's default reminder(s) are added AUTOMATICALLY — normally OMIT reminder_minutes_before; set it (a list) only for DIFFERENT reminders on THIS meeting, or [] to turn them off. Add attendees to include other people; set send_invites ONLY when the client explicitly asks to invite/notify them.",
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
      .array(z.number().int().min(0).max(10080))
      .max(5)
      .optional()
      .describe(
        'Reminder lead times in minutes — the client gets ONE Telegram ping per value ("an hour and ten minutes before" → [60, 10], "just 15 min before" → [15]). OMIT this to use the client\'s DEFAULT reminders (given below) — that is the normal case. Pass [] for NO reminder on this meeting. Only set it when the client specifies reminders for THIS meeting.',
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
      const conflicts = await conflictWarning(ctx, input.start, end, {
        verb: 'created',
        title: input.title,
      });
      if (conflicts) return conflicts;
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

    // Reminders: the leads the client specified for THIS meeting, else their
    // configured DEFAULT (code-enforced here so a meeting always gets the
    // client's reminders — never dependent on the model remembering to ask).
    // Each lead → an independent companion ping.
    const leads = input.reminder_minutes_before ?? ctx.client.reminderLeads;
    // ANY explicit reminder decision for this meeting — "none", or a narrower
    // list like "just an hour before" — hands reminder policy to the client and
    // the sweep must not second-guess it. Marking only the empty case was wrong:
    // once a custom lead fired, the sweep saw no unsent companion, fell back to
    // the client's DEFAULT leads, and re-added pings they had explicitly declined.
    if (input.reminder_minutes_before !== undefined) {
      await ctx.repo
        .setEventReminderPolicyPinned(event.seriesId ?? event.id, true)
        .catch(() => undefined);
    }
    const companionRec = companionRecurrenceFrom(input.repeat);
    const reminderNote = await armEventReminders(
      ctx,
      event,
      input.start,
      leads,
      companionRec,
      undefined,
      // The meeting recurs but the reminder can't (every-other-week + weekdays).
      Boolean(input.repeat) && companionRec === null,
    );

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
      .array(z.number().int().min(0).max(10080))
      .max(5)
      .optional()
      .describe(
        'Change the meeting\'s reminders to this list of lead times in minutes (one ping each; "an hour and 10 min before" → [60, 10]). Pass [] to remove all reminders. If OMITTED, existing reminders are kept and moved with the event. Only set when the client changes the reminders.',
      ),
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
      const conflicts = await conflictWarning(ctx, effStart, effEnd, {
        verb: 'changed',
        excludeEventId: event_id,
      });
      if (conflicts) return conflicts;
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

    // Keep companion reminders correct, keyed on the SERIES master id. A meeting
    // can have SEVERAL (e.g. 1h + 10m before).
    const seriesId = event.seriesId ?? targetId;
    let reminderNote = '';
    // Read existing companions up front so a move can PRESERVE all their leads +
    // recurrence.
    const existing = await ctx.repo.getEventReminders(seriesId);
    // Companion reminders are SERIES-level (one recurring row per lead). Only
    // touch them for a whole-series change (or a one-off event). For a
    // single-occurrence edit, leave the series' reminders exactly as they are —
    // rewriting them by the master id would wipe or re-time every occurrence's
    // pings from one "just this one" request.
    const touchCompanions = applyToSeries || !current.recurring;
    // Desired leads: an explicit new list wins; otherwise, if the time changed,
    // preserve the existing leads (moved with the event). If neither, leave
    // reminders untouched.
    let desiredLeads: number[] | undefined;
    if (reminder_minutes_before !== undefined) desiredLeads = reminder_minutes_before;
    else if (timeChanging)
      desiredLeads = existing
        .map((e) => e.reminderLeadMinutes)
        .filter((n): n is number => n != null);
    // An explicit reminder decision hands policy to the client and pins it
    // against the sweep's auto-arming — for ANY list, empty or not.
    // Gated on touchCompanions: a "just this occurrence" edit must NEVER write a
    // series-level pin (that silently stopped reminders for every future
    // occurrence), and it can't honour a per-occurrence lead change either — so
    // it is reported honestly below instead of being silently swallowed.
    if (reminder_minutes_before !== undefined && touchCompanions) {
      await ctx.repo.setEventReminderPolicyPinned(seriesId, true).catch(() => undefined);
    }
    if (touchCompanions && desiredLeads !== undefined) {
      try {
        await ctx.repo.deleteEventReminders(seriesId);
        // Preserve the series' recurrence AND its pinned zone (all companions
        // share the event's), so a move doesn't drift the recurring pings.
        const src = existing.find((e) => e.recurrenceFreq);
        const companionRec: CompanionRecurrence = src?.recurrenceFreq
          ? {
              recurrenceFreq: src.recurrenceFreq,
              recurrenceInterval: src.recurrenceInterval ?? 1,
              // Undo the stored shift so armEventReminders can re-derive it per
              // lead; passing the shifted value back would shift it AGAIN and
              // walk every ping a day earlier on each edit.
              recurrenceWeekdays: unshiftCompanionWeekdays(
                src.recurrenceWeekdays,
                src.reminderLeadMinutes,
                event.start,
                src.recurrenceTimezone ?? ctx.client.timezone,
              ),
              recurrenceUntil: src.recurrenceUntil,
            }
          : null;
        const zone = src?.recurrenceTimezone ?? undefined;
        const positive = desiredLeads.filter((n) => n > 0);
        if (positive.length > 0) {
          reminderNote = await armEventReminders(
            ctx,
            event,
            // A RECURRING companion rolls forward from the master's start via
            // firstFutureOccurrence, so the master is the right anchor. A
            // ONE-SHOT companion cannot: for a series edit the master's start is
            // the series' FIRST occurrence — often months past — so every lead
            // resolved to a past time, nothing was armed, and the client was told
            // "the meeting is sooner than your reminder time" for a meeting weeks
            // away, with its reminder silently gone. Anchor those on the time the
            // client actually asked for instead.
            companionRec ? event.start : (effStart ?? event.start),
            positive,
            companionRec,
            zone,
          );
        } else if (reminder_minutes_before !== undefined) {
          reminderNote = ' Reminders removed.';
        }
      } catch {
        // Google move landed; only the companion DB work failed — degrade honestly.
        reminderNote =
          " (The event was updated, but I couldn't adjust its Telegram reminder — ask me to set it again.)";
      }
    } else if (touchCompanions && rest.title !== undefined) {
      // Title-only change (no time/reminder edit, so the companions weren't
      // rebuilt above): sync their titles so the ping shows the CURRENT name,
      // not the stale one it was first armed with. Best-effort — the calendar
      // event itself is already updated.
      try {
        await ctx.repo.renameEventReminders(seriesId, event.title);
      } catch {
        /* leave the reminder on its old title rather than fail the whole update */
      }
    }
    // Reminders are SERIES-level, so a "just this occurrence" edit cannot change
    // them. Say so instead of returning success with no note — the model would
    // otherwise confirm a reminder change that never happened.
    if (!touchCompanions && reminder_minutes_before !== undefined) {
      reminderNote =
        " (Reminders are set for the whole repeating meeting, so I couldn't change them for just this one occurrence — tell the client, and ask whether to change the reminder for the entire series.)";
    } else if (!touchCompanions && timeChanging) {
      // A single occurrence moved, but its ping is series-level and still fires
      // at the original time — the client must be told, not left to be surprised.
      reminderNote =
        " (Heads up: the reminder is set for the whole repeating meeting, so it still fires at the series' usual time — not before this moved occurrence.)";
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
    // Companion reminders are series-level (one recurring row per lead). Only
    // remove them when the WHOLE series is cancelled (or it's a one-off). For a
    // single-occurrence cancel, LEAVE the series reminders intact — deleting them
    // by the master id would wipe reminders for every remaining occurrence.
    if (applyToSeries || !existing.recurring) {
      await ctx.repo.deleteEventReminders(existing.seriesId ?? input.event_id);
    } else {
      // Single occurrence cancelled: keep the series' reminders, but never ping
      // for the occurrence that no longer exists.
      await skipCancelledOccurrence(ctx, existing).catch(() => undefined);
    }
    const scope = applyToSeries
      ? ' (whole recurring series)'
      : existing.recurring
        ? ' (this occurrence only)'
        : '';
    return `Deleted calendar event: ${existing.title}${scope}.`;
  },
});
