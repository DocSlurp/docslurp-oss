import { AsyncLocalStorage } from "node:async_hooks";
import type { ReservedSql } from "postgres";
import { env } from "../config.js";
import { createApiPool, type ApiPool } from "./api-pool.js";
import { processSingleton } from "./process-singleton.js";

/**
 * Lock holders must never reserve the query pool: intake needs it while locked. Each lock holds one dedicated
 * connection for its critical section, so the lanes are separate pools: `request` (two lazy connections, which also
 * support DATABASE_POOL_MAX=1) serves client requests, and `background` serves the reconciler sweep and immediate
 * confirms, so background finalization never queues a client's files/complete or confirm behind it. Idle connections
 * close after the pool's idle timeout.
 */
export type DirectUploadLockLane = "request" | "background";
export const DIRECT_UPLOAD_LOCK_CONNECTIONS: Readonly<Record<DirectUploadLockLane, number>> = { request: 2, background: 8 };

const state = processSingleton(`direct-upload-locks:v2:${env.databaseUrl}`, () => ({
  pools: { request: null, background: null } as Record<DirectUploadLockLane, ApiPool | null>,
  active: 0,
  closing: null as Promise<void> | null,
  drained: [] as Array<() => void>,
}));
const lane = new AsyncLocalStorage<DirectUploadLockLane>();

/** Run background upload work (sweep, immediate confirm) so its session locks use the background lane. */
export function inBackgroundUploadLane<T>(run: () => Promise<T>): Promise<T> {
  return lane.run("background", run);
}

export async function reserveDirectUploadLockConnection(): Promise<{ connection: ReservedSql; release: () => void }> {
  if (state.closing) await state.closing;
  const current = lane.getStore() ?? "request";
  const applicationName = current === "request" ? "docslurp-upload-locks" : "docslurp-upload-locks-background";
  const pool = state.pools[current] ??= createApiPool(env.databaseUrl, { max: DIRECT_UPLOAD_LOCK_CONNECTIONS[current], applicationName });
  state.active += 1;
  const done = () => {
    state.active -= 1;
    if (state.active === 0) for (const resolve of state.drained.splice(0)) resolve();
  };
  try {
    const connection = await pool.sql.reserve();
    let released = false;
    return { connection, release: () => { if (!released) { released = true; connection.release(); done(); } } };
  } catch (error) { done(); throw error; }
}

export async function closeDirectUploadLockPool(): Promise<void> {
  if (state.closing) return state.closing;
  state.closing = (async () => {
    if (state.active) await new Promise<void>(resolve => state.drained.push(resolve));
    const pools = Object.values(state.pools);
    state.pools = { request: null, background: null };
    await Promise.all(pools.map(pool => pool?.sql.end({ timeout: 5 })));
  })();
  try { await state.closing; }
  finally { state.closing = null; }
}
