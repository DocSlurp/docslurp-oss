/**
 * Runs `work` over `items` with at most `limit` calls in flight and settles every one: the result never rejects and
 * holds one outcome per item, in input order. A failing item never cancels or skips the others.
 */
export async function settleBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { status: "fulfilled", value: await work(items[index]!, index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: width }, lane));
  return results;
}
