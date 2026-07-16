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
    const res = await this.calendar.events.list({
      calendarId: 'primary',
      timeMin: params.from.toISOString(),
      timeMax: params.to.toISOString(),
      singleEvents: true, // expands recurring events into instances
      orderBy: 'startTime',
      maxResults: Math.min(params.limit ?? 50, 100),
    });
    return (res.data.items ?? [])
      .filter((e) => e.status !== 'cancelled')
      .map((e) => this.toEvent(e));
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
  }): Promise<CalendarEvent> {
    const res = await this.calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: params.title,
        description: params.description,
        location: params.location,
        start: { dateTime: params.start.toISOString(), timeZone: this.timezone },
        end: { dateTime: params.end.toISOString(), timeZone: this.timezone },
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
    }>,
  ): Promise<CalendarEvent> {
    // PATCH semantics: only the provided fields change.
    const body: calendar_v3.Schema$Event = {};
    if (params.title !== undefined) body.summary = params.title;
    if (params.description !== undefined) body.description = params.description;
    if (params.location !== undefined) body.location = params.location;
    if (params.start) body.start = { dateTime: params.start.toISOString(), timeZone: this.timezone };
    if (params.end) body.end = { dateTime: params.end.toISOString(), timeZone: this.timezone };
    const res = await this.calendar.events.patch({
      calendarId: 'primary',
      eventId,
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
    const busy = (await this.listEvents({ from, to, limit: 100 }))
      .filter((e) => !e.allDay)
      .map((e) => ({ start: e.start, end: e.end }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    const slots: { start: Date; end: Date }[] = [];
    let cursor = from;
    for (const block of busy) {
      if (slots.length >= limit) break;
      if (block.start.getTime() - cursor.getTime() >= durationMs) {
        slots.push({ start: cursor, end: new Date(cursor.getTime() + durationMs) });
      }
      if (block.end > cursor) cursor = block.end;
    }
    // Trailing gap after the last busy block.
    if (slots.length < limit && to.getTime() - cursor.getTime() >= durationMs) {
      slots.push({ start: cursor, end: new Date(cursor.getTime() + durationMs) });
    }
    return slots.slice(0, limit);
  }

  private toEvent(e: calendar_v3.Schema$Event): CalendarEvent {
    const allDay = Boolean(e.start?.date && !e.start.dateTime);
    const start = e.start?.dateTime ?? e.start?.date;
    const end = e.end?.dateTime ?? e.end?.date;
    if (!e.id || !start || !end) {
      GoogleCalendarGateway.logger.warn(`Malformed event from Google: ${JSON.stringify(e.id)}`);
      throw new Error('Google returned a malformed event.');
    }
    return {
      id: e.id,
      title: e.summary ?? '(untitled)',
      start: new Date(start),
      end: new Date(end),
      allDay,
      description: e.description ?? undefined,
      location: e.location ?? undefined,
    };
  }
}
