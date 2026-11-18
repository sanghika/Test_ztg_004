/**
 * Runs `worker` over `items` with at most `limit` calls in flight, and starts
 * the next item the moment any call finishes (a sliding window).
 *
 * Processing in fixed groups instead ("await 5, then start the next 5") makes
 * every group as slow as its slowest member, so one large or retried file
 * leaves the other four slots idle. Results keep the input order.
 *
 * If a call fails, nothing new is started, calls already running are allowed
 * to finish, and the first error is what the returned promise rejects with.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  const runSlot = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  const slots = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runSlot);
  await Promise.all(slots);
  return results;
};
