import { z } from 'zod';

/**
 * Time handling rules (project-wide):
 * - All timestamps are STORED in UTC.
 * - The model passes ISO 8601 strings (the system prompt gives it `{{NOW}}`
 *   with the client's UTC offset, so it produces offset-aware strings).
 * - All timestamps are DISPLAYED in the client's IANA timezone.
 */

/** True if `tz` is an IANA zone the runtime knows (e.g. "Asia/Beirut"). The one
 * place timezone validity is decided — reused by admin input, the set_timezone
 * tool, and TimezoneService so a bad zone can never reach the scheduling math. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** ISO 8601 datetime string → Date, rejecting anything unparsable. */
export const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'must be an ISO 8601 datetime' })
  .transform((s) => new Date(s));

/** ISO date/datetime that carries NO timezone marker (no trailing Z / ±HH:MM). */
const OFFSETLESS_ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?)?$/;

/** True when `s` is an ISO date/datetime with no explicit timezone offset. */
export function isOffsetlessIso(s: string): boolean {
  return OFFSETLESS_ISO.test(s.trim());
}

/**
 * Make a model-supplied time unambiguous by anchoring it to the CLIENT's
 * timezone. If the string already carries an offset (or isn't an ISO datetime)
 * it is returned unchanged. Otherwise the client tz's offset AT THAT wall-clock
 * time is appended (DST-safe, two-pass) so `new Date(...)` resolves to the
 * correct instant regardless of the server's timezone. Date-only strings are
 * treated as local midnight.
 *
 * This is the single guarantee that "9:30" from a Beirut client means 9:30 in
 * Beirut, never 9:30 on the UTC server — independent of whether the model
 * remembered to include the offset.
 */
export function withClientOffset(raw: string, timeZone: string): string {
  const s = raw.trim();
  if (!isOffsetlessIso(s)) return raw;
  const base = s.length === 10 ? `${s}T00:00:00` : s;
  const first = isoInTz(new Date(`${base}Z`), timeZone).slice(-6);
  const second = isoInTz(new Date(`${base}${first}`), timeZone).slice(-6);
  return `${base}${second}`;
}

/** Format a Date in the client's timezone, e.g. "Fri, Jul 18 2026, 3:00 PM". */
export function formatInTz(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

/**
 * A concise "when" for a reminder ping: just the time ("8:00 PM") if the event
 * is on the SAME local day as `now`, else weekday + time ("Fri 8:00 PM"). Keeps
 * pings short — no redundant full weekday+year the client is receiving right now.
 */
export function formatEventWhen(eventAt: Date, now: Date, timeZone: string): string {
  const full = formatInTz(eventAt, timeZone); // "Fri, Jul 18 2026, 8:00 PM"
  const time = full.split(', ').pop() ?? full; // "8:00 PM"
  const sameDay =
    isoInTz(eventAt, timeZone).slice(0, 10) === isoInTz(now, timeZone).slice(0, 10);
  if (sameDay) return time;
  const weekday = full.split(',')[0]; // "Fri"
  return `${weekday} ${time}`;
}

/** The local weekday of `date` in `timeZone`: 0 = Sunday … 6 = Saturday. */
export function localWeekday(date: Date, timeZone: string): number {
  const ymd = isoInTz(date, timeZone).slice(0, 10);
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

/** ISO 8601 with the client's local offset, e.g. "2026-07-18T15:00:00+03:00". */
export function isoInTz(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const rawOffset = get('timeZoneName'); // "GMT+03:00" or "GMT"
  const offset = rawOffset === 'GMT' ? '+00:00' : rawOffset.replace('GMT', '');
  // en-CA hour "24" can appear at midnight in some ICU versions — normalize.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}${offset}`;
}

/** The UTC instant of local midnight for a given YYYY-MM-DD in a timezone. */
function utcForLocalMidnight(ymd: string, timeZone: string): Date {
  // The offset can differ at midnight vs. noon on a DST-transition day, so we
  // don't reuse `now`'s offset. Two-pass: guess with the offset seen when the
  // naive-UTC candidate is interpreted in the zone, then correct once using the
  // offset at the resulting instant. Correct except in the ambiguous fall-back
  // hour (acceptable for day bucketing).
  const naiveUtc = new Date(`${ymd}T00:00:00Z`);
  const firstOffset = isoInTz(naiveUtc, timeZone).slice(-6); // e.g. "+03:00"
  const firstGuess = new Date(`${ymd}T00:00:00${firstOffset}`);
  const secondOffset = isoInTz(firstGuess, timeZone).slice(-6);
  return new Date(`${ymd}T00:00:00${secondOffset}`);
}

function localYmd(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Start of "today" in the client's timezone, as a UTC Date. */
export function startOfTodayInTz(now: Date, timeZone: string): Date {
  return utcForLocalMidnight(localYmd(now, timeZone), timeZone);
}

/**
 * End of "today" in the client's timezone (= start of tomorrow), as a UTC Date.
 * Derived from the next calendar date, so DST days (23h/25h) are exact rather
 * than assuming a 24-hour day.
 */
export function endOfTodayInTz(now: Date, timeZone: string): Date {
  const start = startOfTodayInTz(now, timeZone);
  // Jump ~26h forward to safely land on the next local date, then take its
  // local midnight.
  const nextish = new Date(start.getTime() + 26 * 60 * 60_000);
  return utcForLocalMidnight(localYmd(nextish, timeZone), timeZone);
}

/** A minutes value as natural language: 60 → "1 hour", 10 → "10 min",
 * 90 → "1h 30m", 1440 → "1 day". Used for reminder lead times. */
export function formatLead(min: number): string {
  if (min % 1440 === 0) {
    const d = min / 1440;
    return `${d} day${d > 1 ? 's' : ''}`;
  }
  if (min % 60 === 0) {
    const h = min / 60;
    return `${h} hour${h > 1 ? 's' : ''}`;
  }
  if (min > 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${min} min`;
}

/** A list of minutes as natural language: [60, 10] → "1 hour and 10 min". */
export function formatLeads(leads: number[]): string {
  const p = leads.map(formatLead);
  return p.length <= 1 ? (p[0] ?? '') : `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}`;
}

export type RecurrenceFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY';

/**
 * The first occurrence of a series that is strictly AFTER `now` — used to arm a
 * recurring reminder whose original first occurrence is already in the past
 * (e.g. adding a reminder to a standup that started weeks ago). Without this a
 * recurring companion whose anchor is past would be dropped entirely (never
 * created) — silently losing every future ping. Returns null if the series has
 * no future occurrence (ended, or its `until` has passed). Keeps `anchor` as the
 * immutable series anchor so monthly day-of-month stays stable.
 */
export function firstFutureOccurrence(
  anchor: Date,
  freq: RecurrenceFreq,
  interval: number,
  weekdays: number[],
  timeZone: string,
  now: Date,
  until?: Date | null,
): Date | null {
  const past = (d: Date): boolean => d.getTime() <= now.getTime();
  const beyond = (d: Date): boolean => until != null && d.getTime() > until.getTime();
  if (!past(anchor)) return beyond(anchor) ? null : anchor;
  let next = anchor;
  for (let i = 0; i < 2000 && past(next); i++) {
    const after = nextOccurrence(next, freq, interval, weekdays, timeZone, anchor);
    if (after.getTime() <= next.getTime()) return null; // safety: no progress
    next = after;
  }
  if (past(next) || beyond(next)) return null;
  return next;
}

/**
 * The next occurrence of a recurring reminder AFTER `current`, computed in the
 * client's timezone so the LOCAL wall-clock time is preserved across DST (e.g.
 * "every day at 9:30" stays 9:30 local even when the offset shifts). Month-end
 * days are clamped (Jan 31 → Feb 28/29).
 *
 * `weekdays` uses 0=Sunday…6=Saturday. For WEEKLY with specific weekdays the
 * interval is treated as 1 (covers "every Friday", "every weekday", "every Mon
 * & Wed"); interval applies to DAILY, MONTHLY, and plain WEEKLY.
 */
export function nextOccurrence(
  current: Date,
  freq: RecurrenceFreq,
  interval: number,
  weekdays: number[],
  timeZone: string,
  anchor?: Date | null,
): Date {
  const n = Math.max(1, Math.trunc(interval) || 1);
  const iso = isoInTz(current, timeZone); // YYYY-MM-DDTHH:MM:SS±HH:MM
  const dateParts = iso.slice(0, 10).split('-');
  const y = Number(dateParts[0]);
  const m = Number(dateParts[1]);
  const d = Number(dateParts[2]);
  const timePart = iso.slice(11, 19); // HH:MM:SS (local wall-clock, preserved)
  // For MONTHLY: the day-of-month comes from the immutable ANCHOR, not the last
  // (possibly clamped) occurrence — so "the 31st" recovers after February
  // instead of drifting to the 28th forever.
  const anchorDay = anchor ? Number(isoInTz(anchor, timeZone).slice(8, 10)) : d;
  // Bare calendar holder (UTC, no DST) purely for date arithmetic.
  const cal = new Date(Date.UTC(y, m - 1, d));

  // Rebuild a UTC instant from a local Y-M-D + the preserved wall-clock time.
  const build = (cy: number, cm1: number, cd: number): Date => {
    const daysInMonth = new Date(Date.UTC(cy, cm1, 0)).getUTCDate(); // cm1 = 1-based month
    const day = Math.min(cd, daysInMonth);
    const wall = `${String(cy).padStart(4, '0')}-${String(cm1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${timePart}`;
    return new Date(withClientOffset(wall, timeZone));
  };

  if (freq === 'DAILY') {
    cal.setUTCDate(cal.getUTCDate() + n);
    return build(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate());
  }
  if (freq === 'MONTHLY') {
    const total = y * 12 + (m - 1) + n;
    return build(Math.floor(total / 12), (total % 12) + 1, anchorDay);
  }
  // WEEKLY
  if (weekdays.length === 0) {
    cal.setUTCDate(cal.getUTCDate() + 7 * n);
    return build(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate());
  }
  const set = new Set(weekdays.map((w) => ((w % 7) + 7) % 7));
  for (let i = 1; i <= 7; i++) {
    const c = new Date(cal.getTime());
    c.setUTCDate(c.getUTCDate() + i);
    if (set.has(c.getUTCDay())) {
      return build(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate());
    }
  }
  cal.setUTCDate(cal.getUTCDate() + 7); // unreachable fallback
  return build(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate());
}
