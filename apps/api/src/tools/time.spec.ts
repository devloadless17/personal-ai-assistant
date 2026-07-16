import { isOffsetlessIso, withClientOffset } from './time';

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
