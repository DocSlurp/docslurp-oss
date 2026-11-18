import type { ReservedSql } from "postgres";
import { env } from "../config.js";
import { createApiPool, type ApiPool } from "./api-pool.js";
import { processSingleton } from "./process-singleton.js";

/**
 * Dedicated connections for direct-upload session advisory locks. Lock holders must never reserve the query pool:
 * intake needs it while locked.
 *
 * Holders come in classes so a slow class can never take every connection:
 *  - `batch`: a files/complete call finalizing files (storage work under the lock). At most `batchMax` per process
 *    (pool size minus two) and `batchPerOrg` per organization at a time.
 *  - `reconcile`: the background sweep and the in-process kick. One at a time.
 *  - `wave`: a background wave (starting runs for an upload in progress, or its last run at expiry). At most `waveMax`
 *    per process and `wavePerOrg` per organization, apart from `reconcile`, so one upload's waves never wait behind
 *    another's or behind the sweep.
 *  - `short`: everything else (part signing, confirm, abort, status recovery, idempotency). Unlimited, and always left
 *    at least one connection by the caps above (batch + reconcile + wave never exceed the pool size minus one).
 * Every reservation has a deadline: a caller that cannot get a slot or a connection in time gets
 * DirectUploadLockUnavailable (answered as 409 upload_session_busy), never an unbounded wait.
 */
export type DirectUploadLockClass = "short" | "batch" | "reconcile" | "wave";

export class DirectUploadLockUnavailable extends Error {
  constructor() { super("Upload lock connection unavailable"); this.name = "DirectUploadLockUnavailable"; }
}

/** A caller without its own deadline still waits at most this long for a slot and a connection. */
export const MIN_LOCK_RESERVE_MS = 2_000;

function intOr(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value!) : fallback;
  return Math.min(max, Math.max(min, n));
}

export function directUploadLockLimits() {
  const poolMax = intOr(env.directUploadLockPoolMax, 6, 4, 64);
  // Classes with a cap share the pool minus one connection kept for `short`: reconcile 1, then waves, then batches.
  const waveMax = intOr(env.directUploadLockWaveMax, 2, 1, poolMax - 3);
  const wavePerOrg = intOr(env.directUploadLockWavePerOrg, 2, 1, waveMax);
  const batchMax = intOr(env.directUploadLockBatchMax, poolMax - 2 - waveMax, 1, poolMax - 2 - waveMax);
  const batchPerOrg = intOr(env.directUploadLockBatchPerOrg, 2, 1, batchMax);
  return { poolMax, batchMax, batchPerOrg, reconcileMax: 1, waveMax, wavePerOrg };
}

const state = processSingleton(`direct-upload-locks:${env.databaseUrl}`, () => ({
  pool: null as ApiPool | null,
  active: 0,
  closing: null as Promise<void> | null,
  drained: [] as Array<() => void>,
  batch: 0,
  batchByOrg: new Map<string, number>(),
  reconcile: 0,
  wave: 0,
  waveByOrg: new Map<string, number>(),
  waiters: new Set<() => void>(),
}));

function wake(): void {
  for (const waiter of [...state.waiters]) waiter();
}

/** Waits for any slot release or the deadline, whichever comes first. */
function waitForRelease(deadline: number): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); state.waiters.delete(done); resolve(); };
    const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
    state.waiters.add(done);
  });
}

async function acquireSlot(lockClass: DirectUploadLockClass, orgKey: string, deadline: number): Promise<() => void> {
  if (lockClass === "short") return () => {};
  const limits = directUploadLockLimits();
  for (;;) {
    if (lockClass === "batch" && state.batch < limits.batchMax && (state.batchByOrg.get(orgKey) ?? 0) < limits.batchPerOrg) {
      state.batch += 1;
      state.batchByOrg.set(orgKey, (state.batchByOrg.get(orgKey) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.batch -= 1;
        const left = (state.batchByOrg.get(orgKey) ?? 1) - 1;
        if (left > 0) state.batchByOrg.set(orgKey, left); else state.batchByOrg.delete(orgKey);
        wake();
      };
    }
    if (lockClass === "wave" && state.wave < limits.waveMax && (state.waveByOrg.get(orgKey) ?? 0) < limits.wavePerOrg) {
      state.wave += 1;
      state.waveByOrg.set(orgKey, (state.waveByOrg.get(orgKey) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.wave -= 1;
        const left = (state.waveByOrg.get(orgKey) ?? 1) - 1;
        if (left > 0) state.waveByOrg.set(orgKey, left); else state.waveByOrg.delete(orgKey);
        wake();
      };
    }
    if (lockClass === "reconcile" && state.reconcile < limits.reconcileMax) {
      state.reconcile += 1;
      let released = false;
      return () => { if (!released) { released = true; state.reconcile -= 1; wake(); } };
    }
    if (Date.now() >= deadline) throw new DirectUploadLockUnavailable();
    await waitForRelease(deadline);
  }
}

export async function reserveDirectUploadLockConnection(options: {
  lockClass?: DirectUploadLockClass;
  /** The tenant a batch or wave holder counts against. */
  orgId?: string | null;
  /** Epoch ms by which a slot and a connection must be had (at least MIN_LOCK_RESERVE_MS from now). */
  deadline?: number;
} = {}): Promise<{ connection: ReservedSql; release: () => void }> {
  if (state.closing) await state.closing;
  const deadline = Math.max(options.deadline ?? 0, Date.now() + MIN_LOCK_RESERVE_MS);
  const releaseSlot = await acquireSlot(options.lockClass ?? "short", options.orgId ?? "", deadline);
  state.pool ??= createApiPool(env.databaseUrl, { max: directUploadLockLimits().poolMax, applicationName: "docslurp-upload-locks" });
  state.active += 1;
  const done = () => {
    state.active -= 1;
    releaseSlot();
    if (state.active === 0) for (const resolve of state.drained.splice(0)) resolve();
  };
  const reserving = state.pool.sql.reserve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); });
  try {
    const connection = await Promise.race([reserving, expired]);
    if (!connection) {
      // The pool is saturated: give up on schedule, and hand back the connection if it arrives later.
      void reserving.then(late => late.release(), () => {}).finally(done);
      throw new DirectUploadLockUnavailable();
    }
    let released = false;
    return { connection, release: () => { if (!released) { released = true; connection.release(); done(); } } };
  } catch (error) {
    if (!(error instanceof DirectUploadLockUnavailable)) done();
    throw error;
  } finally { clearTimeout(timer); }
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
