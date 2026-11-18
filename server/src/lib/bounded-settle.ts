/** The reason recorded for an item that was never started because `shouldStart` said stop. */
export const NOT_STARTED: unique symbol = Symbol("not started");

/**
 * Runs `work` over `items` with at most `limit` calls in flight and settles every one: the result never rejects and
 * holds one outcome per item, in input order. A failing item never cancels or skips the others. When `shouldStart`
 * returns false, no further item is started; those items are recorded as rejected with `NOT_STARTED`.
 */
export async function settleBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
  options: { shouldStart?: () => boolean } = {},
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  let stopped = false;
  const lane = async () => {
    while (next < items.length) {
      if (stopped || (options.shouldStart && !options.shouldStart())) { stopped = true; break; }
      const index = next++;
      try { results[index] = { status: "fulfilled", value: await work(items[index]!, index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: width }, lane));
  for (let index = 0; index < items.length; index++) results[index] ??= { status: "rejected", reason: NOT_STARTED };
  return results;
}
