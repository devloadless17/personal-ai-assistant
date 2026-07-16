import { isOffsetlessIso, isoInTz, nextOccurrence, withClientOffset } from './time';

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
