import type { ReservedSql } from "postgres";
import { env } from "../config.js";
import { createApiPool, type ApiPool } from "./api-pool.js";
import { processSingleton } from "./process-singleton.js";

/**
 * Dedicated connections for direct-upload session advisory locks. Lock holders must never reserve the query pool:
 * intake needs it while locked.
 *
 * The pool is partitioned so no class, and no one tenant, can take every connection. Storage, network and crawl work
 * stays off the short and start slots: run starts hold theirs only around the database decision and run creation,
 * provider multipart creation and aborts run outside any lock, part signing has a 2 s provider budget, batch work a
 * 5 s budget, and the one holder that must keep its lock across external work (an idempotent intake) has its own class:
 *  - `short` (part signing with a 2 s provider budget, abort's status change, status recovery): at most
 *    `shortMax` = pool − heavyMax connections (2), `shortPerOrg` per organization.
 *  - the heavy classes, together at most heavyMax = pool − 2:
 *    - `reconcile`: the background sweep's and kick's finalize pass. One slot, always left free by the others.
 *    - `batch` (files/complete, the recovery read), `start` (a run start: the client's, the kick's or the sweep's
 *      confirm) and `intake` (an idempotent bulk, URL or website intake, which keeps its Idempotency-Key lock for the
 *      whole request): together at most heavyMax − 1, each with its own process and per-organization cap.
 * At the default pool of 5: 2 short, 1 reconcile, and 2 shared by batch, start and intake (1 each at most).
 * At 8: 2 short, 1 reconcile, 5 shared (batch 3, start 2, intake 2 at most).
 * Every capped holder names its tenant (`tenant`): the organization, resolved from stored rows, never a request field.
 * Every reservation has a deadline: a caller that cannot get a slot or a connection in time gets
 * DirectUploadLockUnavailable (answered as 409 upload_session_busy), never an unbounded wait.
 */
export type DirectUploadLockClass = "short" | "batch" | "start" | "intake" | "reconcile";

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
  // Default 5, the smallest pool that keeps every invariant. Deployments with connection headroom can raise it.
  const poolMax = intOr(env.directUploadLockPoolMax, 5, SHORT_RESERVE + 3, 64);
  const heavyMax = poolMax - SHORT_RESERVE;
  // Short work is capped at what the heavy classes leave, so they always find their slots.
  const shortMax = poolMax - heavyMax;
  const reconcileMax = 1;
  // Batch, start and intake share what the reconciler leaves: a misconfiguration can never starve it.
  const sharedMax = heavyMax - reconcileMax;
  const startMax = intOr(env.directUploadLockStartMax, Math.max(1, Math.floor(sharedMax / 2)), 1, sharedMax);
  const batchMax = intOr(env.directUploadLockBatchMax, Math.max(1, sharedMax - startMax), 1, sharedMax);
  const intakeMax = intOr(env.directUploadLockIntakeMax, Math.max(1, Math.floor(sharedMax / 2)), 1, sharedMax);
  const batchPerOrg = intOr(env.directUploadLockBatchPerOrg, 2, 1, batchMax);
  const startPerOrg = intOr(env.directUploadLockStartPerOrg, 1, 1, startMax);
  const intakePerOrg = intOr(env.directUploadLockIntakePerOrg, 1, 1, intakeMax);
  // One organization never holds every short connection.
  const shortPerOrg = intOr(env.directUploadLockShortPerOrg, Math.max(1, shortMax - 1), 1, Math.max(1, shortMax - 1));
  return { poolMax, heavyMax, shortMax, shortPerOrg, sharedMax, batchMax, batchPerOrg, startMax, startPerOrg, intakeMax, intakePerOrg, reconcileMax };
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
  intake: 0,
  intakeByOrg: new Map<string, number>(),
  reconcile: 0,
  waiters: new Set<() => void>(),
}));

function wake(): void {
  for (const waiter of [...state.waiters]) waiter();
}

/** Waits for any slot release, the deadline or the caller's abort (its client went away), whichever comes first. */
function waitForRelease(deadline: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); state.waiters.delete(done); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
    state.waiters.add(done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function sharedInUse(): number {
  return state.batch + state.start + state.intake;
}

async function acquireSlot(lockClass: DirectUploadLockClass, orgKey: string, deadline: number, signal?: AbortSignal): Promise<() => void> {
  for (;;) {
    signal?.throwIfAborted();
    const limits = directUploadLockLimits();
    if (lockClass === "short") {
      if (state.short < limits.shortMax && (state.shortByOrg.get(orgKey) ?? 0) < limits.shortPerOrg) return take("short", state.shortByOrg, orgKey);
    } else if (lockClass === "reconcile") {
      if (state.reconcile < limits.reconcileMax) {
        state.reconcile += 1;
        let released = false;
        return () => { if (!released) { released = true; state.reconcile -= 1; wake(); } };
      }
    } else if (sharedInUse() < limits.sharedMax) {
      const caps = { batch: [limits.batchMax, limits.batchPerOrg], start: [limits.startMax, limits.startPerOrg], intake: [limits.intakeMax, limits.intakePerOrg] }[lockClass];
      const byOrg = { batch: state.batchByOrg, start: state.startByOrg, intake: state.intakeByOrg }[lockClass];
      if (state[lockClass] < caps[0]! && (byOrg.get(orgKey) ?? 0) < caps[1]!) return take(lockClass, byOrg, orgKey);
    }
    if (Date.now() >= deadline) throw new DirectUploadLockUnavailable();
    await waitForRelease(deadline, signal);
  }
}

function take(kind: "batch" | "start" | "intake" | "short", byOrg: Map<string, number>, orgKey: string): () => void {
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
  /** The waiter's own cancellation (its client disconnected): it stops waiting for a slot or connection. */
  signal?: AbortSignal;
} = {}): Promise<{ connection: ReservedSql; release: () => void }> {
  if (state.closing) await state.closing;
  const lockClass = options.lockClass ?? "short";
  // Fail closed: a capped holder without a tenant would share (and could exhaust) an anonymous bucket.
  if (lockClass !== "reconcile" && !options.tenant) throw new Error(`Upload lock holder of class ${lockClass} needs a tenant`);
  const deadline = options.deadline ?? Date.now() + MIN_LOCK_RESERVE_MS;
  const releaseSlot = await acquireSlot(lockClass, options.tenant ?? "", deadline, options.signal);
  state.pool ??= createApiPool(env.databaseUrl, { max: directUploadLockLimits().poolMax, applicationName: "docslurp-upload-locks" });
  state.active += 1;
  const done = () => {
    state.active -= 1;
    releaseSlot();
    if (state.active === 0) for (const resolve of state.drained.splice(0)) resolve();
  };
  const reserving = state.pool.sql.reserve();
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); });
  const signal = options.signal;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>(resolve => {
    onAbort = () => resolve(null);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const connection = await Promise.race([reserving, expired, aborted]);
    if (!connection) {
      // Keep the slot charged until the pool settles. Hand back a connection that arrives after the caller left.
      abandoned = true;
      void reserving.then(late => late.release(), () => {}).finally(done);
      signal?.throwIfAborted();
      throw new DirectUploadLockUnavailable();
    }
    let released = false;
    return { connection, release: () => { if (!released) { released = true; connection.release(); done(); } } };
  } catch (error) {
    if (!abandoned) done();
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
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
