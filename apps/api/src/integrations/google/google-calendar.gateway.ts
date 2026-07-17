import { Logger } from '@nestjs/common';
import { google, type calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { CalendarEvent, CalendarGateway } from '../../tools/tool.types';

/**
 * Live Google Calendar gateway for ONE client (primary calendar).
 *
 * ALWAYS reads live — never a cache — so events the client added directly in
 * the Google Calendar app are always visible to the assistant, and conflict
 * checks run against the real calendar.
 */
export class GoogleCalendarGateway implements CalendarGateway {
  private static readonly logger = new Logger(GoogleCalendarGateway.name);
  private readonly calendar: calendar_v3.Calendar;

  constructor(auth: OAuth2Client, private readonly timezone: string) {
    this.calendar = google.calendar({ version: 'v3', auth });
  }

  async listEvents(params: { from: Date; to: Date; limit?: number }): Promise<CalendarEvent[]> {
    // Paginate through the whole window (up to `limit`) so a busy month / a wide
    // conflict-scan window never SILENTLY drops events past the first page —
    // which would truncate the calendar grid or offer an already-busy slot.
    const limit = params.limit ?? 250;
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20 && out.length < limit; page++) {
      const res = await this.calendar.events.list({
        calendarId: 'primary',
        timeMin: params.from.toISOString(),
        timeMax: params.to.toISOString(),
        singleEvents: true, // expands recurring events into instances
        orderBy: 'startTime',
        maxResults: Math.min(limit - out.length, 250),
        pageToken,
      });
      for (const e of res.data.items ?? []) {
        if (e.status !== 'cancelled') out.push(this.toEvent(e));
      }
      pageToken = res.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
    return out;
  }

  async getEvent(eventId: string): Promise<CalendarEvent | null> {
    try {
      const res = await this.calendar.events.get({ calendarId: 'primary', eventId });
      if (res.data.status === 'cancelled') return null;
      return this.toEvent(res.data);
    } catch (err) {
      // 404/410 → the event no longer exists; surface as null, not a throw.
      const e = err as { code?: number; response?: { status?: number } };
      const code = e.code ?? e.response?.status;
      if (code === 404 || code === 410) return null;
      throw err;
    }
  }

  async createEvent(params: {
    title: string;
    start: Date;
    end: Date;
    description?: string;
    location?: string;
    attendees?: string[];
    sendInvites?: boolean;
    recurrence?: string[];
  }): Promise<CalendarEvent> {
    const res = await this.calendar.events.insert({
      calendarId: 'primary',
      // sendUpdates 'all' emails the guests; 'none' adds them silently.
      sendUpdates: params.sendInvites ? 'all' : 'none',
      requestBody: {
        summary: params.title,
        description: params.description,
        location: params.location,
        start: { dateTime: params.start.toISOString(), timeZone: this.timezone },
        end: { dateTime: params.end.toISOString(), timeZone: this.timezone },
        ...(params.attendees && params.attendees.length > 0
          ? { attendees: params.attendees.map((email) => ({ email })) }
          : {}),
        ...(params.recurrence && params.recurrence.length > 0
          ? { recurrence: params.recurrence }
          : {}),
      },
    });
    return this.toEvent(res.data);
  }

  async updateEvent(
    eventId: string,
    params: Partial<{
      title: string;
      start: Date;
      end: Date;
      description: string;
      location: string;
      attendees: string[];
      sendInvites: boolean;
    }>,
  ): Promise<CalendarEvent> {
    // PATCH semantics: only the provided fields change.
    const body: calendar_v3.Schema$Event = {};
    if (params.title !== undefined) body.summary = params.title;
    if (params.description !== undefined) body.description = params.description;
    if (params.location !== undefined) body.location = params.location;
    if (params.start) body.start = { dateTime: params.start.toISOString(), timeZone: this.timezone };
    if (params.end) body.end = { dateTime: params.end.toISOString(), timeZone: this.timezone };
    if (params.attendees !== undefined) {
      body.attendees = params.attendees.map((email) => ({ email }));
    }
    const res = await this.calendar.events.patch({
      calendarId: 'primary',
      eventId,
      sendUpdates: params.sendInvites ? 'all' : 'none',
      requestBody: body,
    });
    return this.toEvent(res.data);
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.calendar.events.delete({ calendarId: 'primary', eventId });
  }

  /** Overlap test on the LIVE calendar: [start, end) intersects [s, e). */
  async findConflicts(start: Date, end: Date, excludeEventId?: string): Promise<CalendarEvent[]> {
    const events = await this.listEvents({ from: start, to: end, limit: 100 });
    return events.filter(
      (e) =>
        e.id !== excludeEventId &&
        !e.allDay && // all-day events don't block time slots
        e.start < end &&
        e.end > start,
    );
  }

  /**
   * Open slots of at least `durationMinutes` within [from, to), computed from
   * the LIVE calendar's busy blocks. Returns the earliest slots first so the
   * assistant can offer the nearest alternatives on a conflict.
   */
  async findFreeSlots(params: {
    from: Date;
    to: Date;
    durationMinutes: number;
    limit?: number;
  }): Promise<{ start: Date; end: Date }[]> {
    const { from, to, durationMinutes, limit = 5 } = params;
    const durationMs = durationMinutes * 60_000;
    // Offer DISTINCT candidate start times (not just one per gap): step through
    // each free gap so a wide-open window yields several options to choose from.
    const stepMs = Math.max(durationMs, 30 * 60_000);
    const busy = (await this.listEvents({ from, to, limit: 100 }))
      .filter((e) => !e.allDay)
      .map((e) => ({ start: e.start, end: e.end }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    // Build free gaps between busy blocks (merging overlaps via the cursor).
    const gaps: { start: Date; end: Date }[] = [];
    let cursor = from;
    for (const block of busy) {
      if (block.start.getTime() - cursor.getTime() >= durationMs) {
        gaps.push({ start: cursor, end: block.start });
      }
      if (block.end > cursor) cursor = block.end;
    }
    if (to.getTime() - cursor.getTime() >= durationMs) gaps.push({ start: cursor, end: to });

    const slots: { start: Date; end: Date }[] = [];
    for (const gap of gaps) {
      let s = gap.start.getTime();
      while (s + durationMs <= gap.end.getTime() && slots.length < limit) {
        slots.push({ start: new Date(s), end: new Date(s + durationMs) });
        s += stepMs;
      }
      if (slots.length >= limit) break;
    }
    return slots;
  }

  /** All pairs of overlapping TIMED events in [from, to) — for background
   * double-booking detection (all-day events don't block, as elsewhere). */
  async findOverlappingPairs(
    from: Date,
    to: Date,
  ): Promise<{ a: CalendarEvent; b: CalendarEvent }[]> {
    const events = (await this.listEvents({ from, to, limit: 100 }))
      .filter((e) => !e.allDay)
      .sort((x, y) => x.start.getTime() - y.start.getTime());
    const pairs: { a: CalendarEvent; b: CalendarEvent }[] = [];
    for (let i = 0; i < events.length; i++) {
      const a = events[i];
      if (!a) continue;
      for (let j = i + 1; j < events.length; j++) {
        const b = events[j];
        if (!b) continue;
        if (b.start >= a.end) break; // sorted by start → no later event can overlap a
        if (a.start < b.end && a.end > b.start) pairs.push({ a, b });
      }
    }
    return pairs;
  }

  private toEvent(e: calendar_v3.Schema$Event): CalendarEvent {
    const allDay = Boolean(e.start?.date && !e.start.dateTime);
    const start = e.start?.dateTime ?? e.start?.date;
    const end = e.end?.dateTime ?? e.end?.date;
    if (!e.id || !start || !end) {
      GoogleCalendarGateway.logger.warn(`Malformed event from Google: ${JSON.stringify(e.id)}`);
      throw new Error('Google returned a malformed event.');
    }
    const attendees = (e.attendees ?? [])
      .map((a) => a.email)
      .filter((email): email is string => Boolean(email));
    return {
      id: e.id,
      title: e.summary ?? '(untitled)',
      start: new Date(start),
      end: new Date(end),
      allDay,
      description: e.description ?? undefined,
      location: e.location ?? undefined,
      attendees: attendees.length > 0 ? attendees : undefined,
      // A series master has `recurrence`; an expanded instance has `recurringEventId`.
      recurring: Boolean(e.recurringEventId ?? e.recurrence),
      // Resolve the series master id so companion-reminder lookups (keyed on the
      // master) still match when we're handed an expanded instance id.
      seriesId: e.recurringEventId ?? e.id,
    };
  }
}
