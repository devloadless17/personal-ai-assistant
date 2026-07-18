import {
  inclusiveUntil,
  firstFutureOccurrence,
  formatEventWhen,
  localWeekday,
  isOffsetlessIso,
  isoInTz,
  nextOccurrence,
  withClientOffset,
} from './time';

/**
 * The timezone guarantee: a wall-clock time with no offset must be interpreted
 * in the CLIENT's zone, not the server's. 99% of clients are Asia/Beirut
 * (UTC+3 in summer), so "9:30" must resolve to 06:30 UTC, never 09:30 UTC.
 */
describe('time — client-timezone anchoring', () => {
  it('detects offset-less ISO strings, and leaves offset-aware ones alone', () => {
    expect(isOffsetlessIso('2026-07-16T09:30:00')).toBe(true);
    expect(isOffsetlessIso('2026-07-16T09:30')).toBe(true);
    expect(isOffsetlessIso('2026-07-16')).toBe(true);
    expect(isOffsetlessIso('2026-07-16T09:30:00Z')).toBe(false);
    expect(isOffsetlessIso('2026-07-16T09:30:00+03:00')).toBe(false);
    expect(isOffsetlessIso('Take a shower')).toBe(false);
    expect(isOffsetlessIso('task-123')).toBe(false);
  });

  it('anchors an offset-less Beirut time to +03:00 (summer)', () => {
    const anchored = withClientOffset('2026-07-16T09:30:00', 'Asia/Beirut');
    expect(anchored).toBe('2026-07-16T09:30:00+03:00');
    // 09:30 Beirut = 06:30 UTC — NOT 09:30 UTC.
    expect(new Date(anchored).toISOString()).toBe('2026-07-16T06:30:00.000Z');
  });

  it('anchors correctly in winter too (Beirut is +02:00 in January)', () => {
    const anchored = withClientOffset('2026-01-15T09:30:00', 'Asia/Beirut');
    expect(anchored).toBe('2026-01-15T09:30:00+02:00');
    expect(new Date(anchored).toISOString()).toBe('2026-01-15T07:30:00.000Z');
  });

  it('leaves an already-offset string exactly as-is', () => {
    expect(withClientOffset('2026-07-16T09:30:00Z', 'Asia/Beirut')).toBe('2026-07-16T09:30:00Z');
    expect(withClientOffset('2026-07-16T09:30:00+05:00', 'Asia/Beirut')).toBe(
      '2026-07-16T09:30:00+05:00',
    );
  });

  it('treats a date-only value as local midnight in the client zone', () => {
    const anchored = withClientOffset('2026-07-16', 'Asia/Beirut');
    expect(new Date(anchored).toISOString()).toBe('2026-07-15T21:00:00.000Z');
  });
});

describe('nextOccurrence — recurring reminders (client-tz, DST-safe)', () => {
  const TZ = 'Asia/Beirut';
  const at = (local: string): Date => new Date(withClientOffset(local, TZ));
  const localDate = (d: Date): string => isoInTz(d, TZ).slice(0, 10);
  const localHM = (d: Date): string => isoInTz(d, TZ).slice(11, 16);
  const weekdayName = (d: Date): string =>
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);

  it('DAILY advances one local day, same local time', () => {
    const r = nextOccurrence(at('2026-07-16T09:30:00'), 'DAILY', 1, [], TZ);
    expect(localDate(r)).toBe('2026-07-17');
    expect(localHM(r)).toBe('09:30');
  });

  it('DAILY preserves local time across a spring-forward DST change', () => {
    // Beirut shifts +2 → +3 at the end of March; "09:30 every day" must stay 09:30.
    const r = nextOccurrence(at('2026-03-28T09:30:00'), 'DAILY', 1, [], TZ);
    expect(localDate(r)).toBe('2026-03-29');
    expect(localHM(r)).toBe('09:30'); // NOT shifted by the DST hour
  });

  it('WEEKLY with no weekdays adds interval weeks', () => {
    const r = nextOccurrence(at('2026-07-16T09:30:00'), 'WEEKLY', 1, [], TZ);
    expect(localDate(r)).toBe('2026-07-23');
    expect(localHM(r)).toBe('09:30');
  });

  it('WEEKLY on a specific weekday lands on the next such weekday', () => {
    // weekdays [5] = Friday; result must be a Friday strictly after the anchor.
    const start = at('2026-07-16T17:00:00');
    const r = nextOccurrence(start, 'WEEKLY', 1, [5], TZ);
    expect(weekdayName(r)).toBe('Fri');
    expect(r.getTime()).toBeGreaterThan(start.getTime());
    expect(localHM(r)).toBe('17:00');
  });

  it('MONTHLY clamps to the last day of a shorter month', () => {
    // Jan 31 + 1 month → Feb 28 (2026 is not a leap year), same local time.
    const r = nextOccurrence(at('2026-01-31T09:30:00'), 'MONTHLY', 1, [], TZ);
    expect(localDate(r)).toBe('2026-02-28');
    expect(localHM(r)).toBe('09:30');
  });

  it('MONTHLY on the 31st RECOVERS via the anchor (no permanent drift to the 28th)', () => {
    const anchor = at('2026-01-31T09:30:00');
    // After Feb clamps to the 28th, the NEXT occurrence must return to the 31st.
    const mar = nextOccurrence(at('2026-02-28T09:30:00'), 'MONTHLY', 1, [], TZ, anchor);
    expect(localDate(mar)).toBe('2026-03-31');
    // April has 30 days → clamps to 30, then May recovers to 31 (still from anchor).
    const apr = nextOccurrence(mar, 'MONTHLY', 1, [], TZ, anchor);
    expect(localDate(apr)).toBe('2026-04-30');
    const may = nextOccurrence(apr, 'MONTHLY', 1, [], TZ, anchor);
    expect(localDate(may)).toBe('2026-05-31');
  });
});

describe('firstFutureOccurrence — arm a recurring reminder whose anchor is past', () => {
  const TZ = 'Asia/Beirut';
  const at = (iso: string): Date => new Date(withClientOffset(iso, TZ));

  it('returns the anchor unchanged when it is already in the future', () => {
    const anchor = at('2026-07-20T09:00:00');
    const now = at('2026-07-18T09:00:00');
    expect(firstFutureOccurrence(anchor, 'DAILY', 1, [], TZ, now)).toEqual(anchor);
  });

  it('skips past daily occurrences to the next FUTURE one (never drops the series)', () => {
    // Standup reminder anchored 3 days ago at 08:45; now is today 10:00.
    const anchor = at('2026-07-15T08:45:00');
    const now = at('2026-07-18T10:00:00');
    const next = firstFutureOccurrence(anchor, 'DAILY', 1, [], TZ, now);
    expect(next).not.toBeNull();
    // Same 08:45 wall-clock, first day strictly after now → 2026-07-19 08:45.
    expect(isoInTz(next as Date, TZ).slice(0, 16)).toBe('2026-07-19T08:45');
  });

  it('returns null when the series ended (past its until)', () => {
    const anchor = at('2026-07-01T08:45:00');
    const now = at('2026-07-18T10:00:00');
    const until = at('2026-07-10T00:00:00');
    expect(firstFutureOccurrence(anchor, 'DAILY', 1, [], TZ, now, until)).toBeNull();
  });

  it('weekly: lands on the correct weekday strictly after now', () => {
    // Anchor was a past Friday; expect the next Friday after now.
    const anchor = at('2026-07-03T09:00:00'); // Fri
    const now = at('2026-07-18T10:00:00'); // Sat
    const next = firstFutureOccurrence(anchor, 'WEEKLY', 1, [5], TZ, now);
    expect(next).not.toBeNull();
    expect(isoInTz(next as Date, TZ).slice(0, 10)).toBe('2026-07-24'); // next Friday
    expect(
      new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(next as Date),
    ).toBe('Fri');
  });
});

describe('formatEventWhen + localWeekday', () => {
  const TZ = 'Asia/Beirut';
  const at = (iso: string): Date => new Date(withClientOffset(iso, TZ));

  it('shows time-only when the event is on the same local day as now', () => {
    const now = at('2026-07-18T09:00:00');
    const eventAt = at('2026-07-18T20:00:00');
    expect(formatEventWhen(eventAt, now, TZ)).toBe('8:00 PM');
  });

  it('shows weekday + time when the event is on a different local day', () => {
    const now = at('2026-07-18T22:00:00'); // Sat night
    const eventAt = at('2026-07-19T08:00:00'); // Sun morning
    expect(formatEventWhen(eventAt, now, TZ)).toBe('Sun 8:00 AM');
  });

  it('localWeekday returns 0=Sun..6=Sat in the client zone', () => {
    expect(localWeekday(at('2026-07-19T12:00:00'), TZ)).toBe(0); // Sunday
    expect(localWeekday(at('2026-07-20T12:00:00'), TZ)).toBe(1); // Monday
  });
});

describe('nextOccurrence — DST-skipped hour self-heals via the anchor', () => {
  const TZ = 'Asia/Beirut';
  const at = (local: string): Date => new Date(withClientOffset(local, TZ));
  const localHM = (d: Date): string => isoInTz(d, TZ).slice(11, 16);

  /**
   * Lebanon springs forward 00:00 → 01:00, so 00:30 does not exist that day and
   * the occurrence is displaced to 01:30. Without an anchor the series reads its
   * wall-clock from the PREVIOUS occurrence, so it stayed at 01:30 forever — a
   * daily 00:30 reminder permanently an hour late.
   */
  it('returns to the anchored 00:30 after the transition instead of sticking at 01:30', () => {
    const anchor = at('2026-03-20T00:30:00'); // the intended local time
    const displaced = at('2026-03-29T01:30:00'); // what the skipped hour produced
    const next = nextOccurrence(displaced, 'DAILY', 1, [], TZ, anchor);
    expect(localHM(next)).toBe('00:30'); // self-healed, not 01:30
  });

  it('without an anchor it still preserves the previous occurrence wall-clock', () => {
    const r = nextOccurrence(at('2026-07-16T09:30:00'), 'DAILY', 1, [], TZ);
    expect(localHM(r)).toBe('09:30');
  });
});

describe('inclusiveUntil — a date-only end date includes its own final day', () => {
  const TZ = 'Asia/Beirut';
  const at = (local: string): Date => new Date(withClientOffset(local, TZ));

  it('extends a local-midnight until to the end of that day', () => {
    const until = at('2026-07-31T00:00:00');
    const inclusive = inclusiveUntil(until, TZ);
    // The 09:00 occurrence ON July 31 must fall INSIDE the series.
    expect(at('2026-07-31T09:00:00').getTime()).toBeLessThan(inclusive.getTime());
  });

  it('leaves an explicit time untouched', () => {
    const until = at('2026-07-31T14:00:00');
    expect(inclusiveUntil(until, TZ).getTime()).toBe(until.getTime());
  });
});
