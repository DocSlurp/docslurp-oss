import type { ReservedSql } from "postgres";
import { env } from "../config.js";
import { createApiPool, type ApiPool } from "./api-pool.js";
import { processSingleton } from "./process-singleton.js";

/**
 * Dedicated connections for direct-upload session advisory locks. Lock holders must never reserve the query pool:
 * intake needs it while locked.
 *
 * Holders come in classes so a slow class, or one tenant, can never take every connection:
 *  - `batch`: storage work under the lock (a files/complete call, a recovery read, an idempotent session create). At
 *    most `batchMax` per process and `batchPerOrg` per organization at a time.
 *  - `start`: a run start (the client's confirm, the reconciler's or kick's confirm, an idempotent bulk or URL intake),
 *    which holds the lock through run creation. At most `startMax` per process and `startPerOrg` per organization.
 *  - `reconcile`: the background sweep's and kick's finalize pass. One at a time.
 *  - `short`: genuinely short work (part signing with a 2 s provider budget, abort's status change). The only class
 *    that may use the last `shortReserve` connections: the heavy classes together never hold more than pool size
 *    minus that reserve. One organization holds at most `shortPerOrg` short connections at a time.
 * Every capped holder names its tenant (`tenant`): the organization, resolved from stored rows, never a request field.
 * Every reservation has a deadline: a caller that cannot get a slot or a connection in time gets
 * DirectUploadLockUnavailable (answered as 409 upload_session_busy), never an unbounded wait.
 */
export type DirectUploadLockClass = "short" | "batch" | "start" | "reconcile";

export class DirectUploadLockUnavailable extends Error {
  constructor() { super("Upload lock connection unavailable"); this.name = "DirectUploadLockUnavailable"; }
}

/** A caller without its own deadline still waits at most this long for a slot and a connection. */
export const MIN_LOCK_RESERVE_MS = 2_000;

function intOr(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value!) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Connections only short operations may use. */
const SHORT_RESERVE = 2;

export function directUploadLockLimits() {
  // Default 5, the smallest pool that keeps every invariant: 2 short-only connections, then one slot each for batch,
  // start and reconcile. Deployments with connection headroom can raise it (8 gives 3 batch and 2 start slots).
  const poolMax = intOr(env.directUploadLockPoolMax, 5, SHORT_RESERVE + 3, 64);
  // Batch, start and reconcile holders together.
  const heavyMax = poolMax - SHORT_RESERVE;
  const startMax = intOr(env.directUploadLockStartMax, Math.max(1, Math.floor((heavyMax - 1) / 2)), 1, heavyMax - 2);
  const batchMax = intOr(env.directUploadLockBatchMax, Math.max(1, heavyMax - 1 - startMax), 1, heavyMax - 2);
  const batchPerOrg = intOr(env.directUploadLockBatchPerOrg, 2, 1, batchMax);
  const startPerOrg = intOr(env.directUploadLockStartPerOrg, 1, 1, startMax);
  // One organization can never hold every connection short work may use.
  const shortPerOrg = intOr(env.directUploadLockShortPerOrg, SHORT_RESERVE, 1, poolMax - 1);
  return { poolMax, heavyMax, batchMax, batchPerOrg, startMax, startPerOrg, shortPerOrg, reconcileMax: 1 };
}

const state = processSingleton(`direct-upload-locks:${env.databaseUrl}`, () => ({
  pool: null as ApiPool | null,
  active: 0,
  closing: null as Promise<void> | null,
  drained: [] as Array<() => void>,
  batch: 0,
  batchByOrg: new Map<string, number>(),
  start: 0,
  startByOrg: new Map<string, number>(),
  short: 0,
  shortByOrg: new Map<string, number>(),
  reconcile: 0,
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

function heavyInUse(): number {
  return state.batch + state.start + state.reconcile;
}

async function acquireSlot(lockClass: DirectUploadLockClass, orgKey: string, deadline: number): Promise<() => void> {
  for (;;) {
    const limits = directUploadLockLimits();
    if (lockClass === "short" && (state.shortByOrg.get(orgKey) ?? 0) < limits.shortPerOrg) return take("short", state.shortByOrg, orgKey);
    if (lockClass !== "short" && heavyInUse() < limits.heavyMax) {
      if (lockClass === "batch" && state.batch < limits.batchMax && (state.batchByOrg.get(orgKey) ?? 0) < limits.batchPerOrg) {
        return take("batch", state.batchByOrg, orgKey);
      }
      if (lockClass === "start" && state.start < limits.startMax && (state.startByOrg.get(orgKey) ?? 0) < limits.startPerOrg) {
        return take("start", state.startByOrg, orgKey);
      }
      if (lockClass === "reconcile" && state.reconcile < limits.reconcileMax) {
        state.reconcile += 1;
        let released = false;
        return () => { if (!released) { released = true; state.reconcile -= 1; wake(); } };
      }
    }
    if (Date.now() >= deadline) throw new DirectUploadLockUnavailable();
    await waitForRelease(deadline);
  }
}

function take(kind: "batch" | "start" | "short", byOrg: Map<string, number>, orgKey: string): () => void {
  state[kind] += 1;
  byOrg.set(orgKey, (byOrg.get(orgKey) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state[kind] -= 1;
    const left = (byOrg.get(orgKey) ?? 1) - 1;
    if (left > 0) byOrg.set(orgKey, left); else byOrg.delete(orgKey);
    wake();
  };
}

export async function reserveDirectUploadLockConnection(options: {
  lockClass?: DirectUploadLockClass;
  /**
   * The tenant a short, batch or start holder counts against: its organization (or, only for a principal without
   * one, `user:<id>`), resolved from stored rows. Required for every class but `reconcile`.
   */
  tenant?: string;
  /**
   * Epoch ms by which a slot and a connection must be had. Given, it is kept exactly (a caller's documented wait is
   * never exceeded); omitted, the caller waits MIN_LOCK_RESERVE_MS.
   */
  deadline?: number;
} = {}): Promise<{ connection: ReservedSql; release: () => void }> {
  if (state.closing) await state.closing;
  const lockClass = options.lockClass ?? "short";
  // Fail closed: a capped holder without a tenant would share (and could exhaust) an anonymous bucket.
  if (lockClass !== "reconcile" && !options.tenant) throw new Error(`Upload lock holder of class ${lockClass} needs a tenant`);
  const deadline = options.deadline ?? Date.now() + MIN_LOCK_RESERVE_MS;
  const releaseSlot = await acquireSlot(lockClass, options.tenant ?? "", deadline);
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
