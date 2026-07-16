import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  it('preserves result order regardless of completion order', async () => {
    const out = await mapWithConcurrency([10, 5, 1], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i * 100 + ms;
    });
    expect(out).toEqual([10, 105, 201]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, () => Promise.resolve(1))).toEqual([]);
  });
});
