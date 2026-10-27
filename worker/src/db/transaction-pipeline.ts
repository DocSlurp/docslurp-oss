import type { PendingQuery, Sql } from "postgres";

type Client = Sql<Record<string, unknown>>;

/**
 * Runs independent statements as one transaction in a single network round
 * trip. `sql.begin` awaits BEGIN, then the body, then COMMIT: three flights at
 * minimum, and one more for every statement the body awaits in turn. Here
 * BEGIN, every statement and COMMIT are written to one reserved connection
 * back to back, so the server receives them in one burst and the caller waits
 * one round trip.
 *
 * Statements execute in array order and see each other's writes, exactly as
 * in `sql.begin`; none may use another's result. If a statement fails, the
 * statements after it fail with "transaction is aborted", COMMIT rolls the
 * transaction back, and the first (root-cause) error is thrown, so
 * retryTransaction still sees a deadlock or serialization code.
 *
 * `after` continues the same transaction with work that needs the results
 * (it costs one more round trip for the commit); omit it for a one-flight
 * transaction.
 */
export async function pipelineTransaction<T extends readonly PendingQuery<any>[]>(
  sql: Client,
  statements: (tx: Client) => readonly [...T],
  after?: (tx: Client, results: { [K in keyof T]: Awaited<T[K]> }) => Promise<void>,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const tx = await sql.reserve() as unknown as Client & { release(): void };
  try {
    const pending = [...statements(tx)];
    const begin = tx.unsafe("begin").execute();
    for (const query of pending) query.execute();
    const commit = after ? undefined : tx.unsafe("commit").execute();
    const settled = await Promise.allSettled([begin, ...pending, ...(commit ? [commit] : [])]);
    const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (failure) {
      // The aborted transaction is still open when COMMIT never ran; close it.
      if (after) await tx.unsafe("rollback").execute().catch(() => undefined);
      throw failure.reason;
    }
    const results = settled.slice(1, 1 + pending.length).map((entry) => (entry as PromiseFulfilledResult<unknown>).value) as
      { [K in keyof T]: Awaited<T[K]> };
    if (after) {
      try {
        await after(tx, results);
      } catch (error) {
        await tx.unsafe("rollback").execute().catch(() => undefined);
        throw error;
      }
      await tx.unsafe("commit").execute();
    }
    return results;
  } finally {
    tx.release();
  }
}
