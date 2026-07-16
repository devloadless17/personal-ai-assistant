/**
 * Run `fn` over `items` with a bounded number of concurrent workers, preserving
 * result order. Lets the job loops process many clients in parallel (live Google
 * + Telegram calls) without unleashing an unbounded burst.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      results[i] = await fn(item, i);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
