/**
 * Billed writes a request may answer before they commit.
 *
 * A search's unit charge and its usage events are idempotent inserts (stable
 * ids, `on conflict (id) do nothing`), so they can commit after the response.
 * What is answered but not yet written is invisible to spend checks and lost
 * if the process dies, so it is capped per process:
 * SEARCH_WRITE_BEHIND_MAX_CREDITS (default 10 credits = $0.10; 0 writes every
 * billed insert before the response). Past the cap a request waits for its
 * own write, as before. Shutdown drains the rest (drainBilledWriteBehind).
 */

const DEFAULT_MAX_CREDITS = 10;

export function billedWriteBehindMaxCredits(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.SEARCH_WRITE_BEHIND_MAX_CREDITS ?? "").trim();
  const parsed = Number(raw);
  return raw && Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_CREDITS;
}

let deferredCredits = 0;
const pending = new Set<Promise<void>>();

/** Credits answered but not yet committed in this process. */
export function billedWriteBehindCredits(): number {
  return deferredCredits;
}

/** Billed writes still running after their response. */
export function billedWriteBehindPending(): number {
  return pending.size;
}

/**
 * Start `write`. Within the cap this returns at once with the write running
 * (its promise is returned as `settled` for callers that track it); past the
 * cap it resolves only after the write settles. `write` reports its own
 * errors: a rejection is swallowed here so a late failure cannot crash the
 * process or fail an answered request.
 */
export function writeBehindWithinCap(credits: number, write: () => Promise<void>): { done: Promise<void>; settled: Promise<void> } {
  const cost = Number.isFinite(credits) && credits > 0 ? credits : 0;
  if (deferredCredits + cost > billedWriteBehindMaxCredits()) {
    const settled = write().catch(() => undefined);
    return { done: settled, settled };
  }
  deferredCredits += cost;
  const settled = write().catch(() => undefined).finally(() => { deferredCredits = Math.max(0, deferredCredits - cost); });
  pending.add(settled);
  void settled.finally(() => pending.delete(settled));
  return { done: Promise.resolve(), settled };
}

/** Shutdown and tests: wait until every deferred billed write has settled. */
export async function drainBilledWriteBehind(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}
