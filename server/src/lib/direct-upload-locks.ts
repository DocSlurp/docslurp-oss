import type { ReservedSql } from "postgres";
import { env } from "../config.js";
import { createApiPool, type ApiPool } from "./api-pool.js";
import { processSingleton } from "./process-singleton.js";

/** Lock holders must never reserve the query pool: intake needs it while locked.
 * These two lazy connections also support DATABASE_POOL_MAX=1. */
const state = processSingleton(`direct-upload-locks:${env.databaseUrl}`, () => ({
  pool: null as ApiPool | null,
  active: 0,
  closing: null as Promise<void> | null,
  drained: [] as Array<() => void>,
}));

export async function reserveDirectUploadLockConnection(): Promise<{ connection: ReservedSql; release: () => void }> {
  if (state.closing) await state.closing;
  state.pool ??= createApiPool(env.databaseUrl, { max: 2, applicationName: "docslurp-upload-locks" });
  state.active += 1;
  const done = () => {
    state.active -= 1;
    if (state.active === 0) for (const resolve of state.drained.splice(0)) resolve();
  };
  try {
    const connection = await state.pool.sql.reserve();
    let released = false;
    return { connection, release: () => { if (!released) { released = true; connection.release(); done(); } } };
  } catch (error) { done(); throw error; }
}

export async function closeDirectUploadLockPool(): Promise<void> {
  if (state.closing) return state.closing;
  state.closing = (async () => {
    if (state.active) await new Promise<void>(resolve => state.drained.push(resolve));
    const pool = state.pool;
    state.pool = null;
    await pool?.sql.end({ timeout: 5 });
  })();
  try { await state.closing; }
  finally { state.closing = null; }
}
