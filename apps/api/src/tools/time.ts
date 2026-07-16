import { z } from 'zod';

/**
 * Time handling rules (project-wide):
 * - All timestamps are STORED in UTC.
 * - The model passes ISO 8601 strings (the system prompt gives it `{{NOW}}`
 *   with the client's UTC offset, so it produces offset-aware strings).
 * - All timestamps are DISPLAYED in the client's IANA timezone.
 */

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
