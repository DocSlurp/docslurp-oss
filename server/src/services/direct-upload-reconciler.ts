import { recordPipelineTelemetry } from "@docslurp/shared/observability";

import { sql } from "../db.js";
import { abortDirectUploadSession, finalizeDirectUploadFile, loadDirectUploadSession, queueAbandonedDirectUploadCleanup, withDirectUploadLock } from "./direct-upload-session.js";
import { ProjectIntakeError, type ProjectIntakeAudit, type ProjectIntakePorts } from "./project-intake.js";
import { confirmDirectUploadProjectIntake } from "./project-intake-actions.js";

/** Sessions finalized side by side in one sweep: one large session no longer holds up every other organization's. */
export const RECONCILE_CONCURRENCY = 8;
const RECONCILE_BATCH = 25;

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
let stopped = false;
let rerunRequested = false;
let sweepCompletion: Promise<void> | null = null;
let resolveSweepCompletion: (() => void) | null = null;
const immediateConfirms = new Set<Promise<void>>();

type DueSession = { id: string; user_id: string; expired: boolean; status: string; due_at: Date | string | null };

function isSessionBusy(error: unknown): boolean {
  return error instanceof ProjectIntakeError && error.code === "upload_session_busy";
}

/** Due (the session's last file completed, or its retry fell due) to confirmed: the latency this module exists to bound. */
function recordReconcileLag(sessionId: string, path: "immediate" | "sweep", dueAt: number): void {
  const seconds = Math.max(0, (Date.now() - dueAt) / 1000);
  if (!Number.isFinite(seconds)) return;
  console.log(`[upload-reconcile] confirmed session=${sessionId} path=${path} lag_ms=${Math.round(seconds * 1000)}`);
  recordPipelineTelemetry("upload.reconcile_lag.duration", seconds, { path }, "duration");
}

async function reconcileSession(session: DueSession): Promise<void> {
  let retryCapSeconds = 30;
  try {
    if (session.expired && session.status !== "ingesting") {
      await abortDirectUploadSession(session.id, session.user_id);
      return;
    }
    const ready = await withDirectUploadLock(session.id, async () => {
      const loaded = await loadDirectUploadSession(session.id, session.user_id);
      if (!loaded || !["pending", "uploading", "ingesting"].includes(loaded.session.status)) return false;
      let ready = true;
      for (const file of loaded.files) {
        if (!await finalizeDirectUploadFile(file)) ready = false;
      }
      return ready;
    });
    if (ready && !stopped) {
      await confirmDirectUploadProjectIntake({ sessionId: session.id, userId: session.user_id });
      recordReconcileLag(session.id, "sweep", session.due_at ? new Date(session.due_at).getTime() : Date.now());
    }
  } catch (error) {
    // Another process (an immediate confirm, a client's confirm, another sweep) holds the session: not a failure.
    if (isSessionBusy(error)) return;
    retryCapSeconds = 300;
    // Keep retrying recoverable storage/database failures until abandonment.
    // Persist only a generic message: provider errors may contain credentials.
    console.error(`[upload-reconcile] session=${session.id} failed`, error instanceof Error ? error.name : "unknown");
    if (error instanceof ProjectIntakeError && error.statusCode !== 409 && error.statusCode < 500) {
      await sql`update upload_sessions set status = 'failed', last_error = 'Upload rejected: stored bytes or intake policy validation failed' where id = ${session.id} and status <> 'confirmed'`;
      await queueAbandonedDirectUploadCleanup(session.id);
    }
    await sql`update upload_sessions set last_error = 'Upload finalization is retrying' where id = ${session.id} and status in ('pending', 'uploading', 'ingesting')`;
  } finally {
    await sql`update upload_sessions set reconcile_attempts = reconcile_attempts + 1,
      next_reconcile_at = now() + least(${retryCapSeconds}, 5 * power(2, least(reconcile_attempts, 6))) * interval '1 second'
      where id = ${session.id} and status in ('pending', 'uploading', 'ingesting')`;
  }
}

/** Durable schedule plus cross-process session locks make missed webhooks harmless. */
export async function reconcileDirectUploads(): Promise<void> {
  if (running) return;
  running = true;
  sweepCompletion = new Promise<void>(resolve => { resolveSweepCompletion = resolve; });
  try {
    do {
      rerunRequested = false;
      const sessions = await sql<DueSession[]>`
        select id, user_id, status, expires_at < now() as expired, next_reconcile_at as due_at from upload_sessions
        where (status in ('pending', 'uploading', 'ingesting') or (status = 'initializing' and expires_at < now())) and next_reconcile_at <= now()
        order by next_reconcile_at limit ${RECONCILE_BATCH}`;
      let next = 0;
      // A fixed pool: each worker takes the next due session until none are left or shutdown begins. Per-session
      // advisory locks still serialize work on one session; the pool only overlaps different sessions.
      await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, sessions.length) }, async () => {
        while (!stopped && next < sessions.length) {
          const session = sessions[next++]!;
          await reconcileSession(session).catch(error => {
            console.error(`[upload-reconcile] session=${session.id} bookkeeping failed`, error instanceof Error ? error.name : "unknown");
          });
        }
      }));
    } while (rerunRequested && !stopped);
  } finally { running = false; resolveSweepCompletion?.(); resolveSweepCompletion = null; sweepCompletion = null; }
}

/**
 * A storage notification or a completed file made a session due: sweep now rather than at the next tick. Coalesced:
 * at most one sweep runs, and a request during one runs one more after it. A no-op in a process whose reconciler is
 * not running.
 */
export function requestDirectUploadSweep(): void {
  if (!timer || stopped) return;
  if (running) { rerunRequested = true; return; }
  void reconcileDirectUploads().catch(error => console.error("[upload-reconcile] sweep failed", error instanceof Error ? error.name : "unknown"));
}

/**
 * The last file of a session completed: confirm intake now instead of waiting for the sweep. Best effort and
 * idempotent: confirmation takes the session lock and returns the stored result when it already ran, so racing the
 * sweep or a client's own confirm never starts a second run. Any failure is left to the sweep (the session is already
 * due), which also owns marking rejected sessions failed; errors go to telemetry only.
 */
export function confirmCompletedDirectUploadSoon(args: {
  sessionId: string;
  userId: string;
  audit?: ProjectIntakeAudit;
  ports?: ProjectIntakePorts;
}): void {
  if (stopped) return;
  const dueAt = Date.now();
  const task = (async () => {
    try {
      await confirmDirectUploadProjectIntake({ sessionId: args.sessionId, userId: args.userId, ...(args.audit ? { audit: args.audit } : {}) }, ...(args.ports ? [args.ports] : []));
      recordReconcileLag(args.sessionId, "immediate", dueAt);
    } catch (error) {
      if (isSessionBusy(error)) return;
      console.warn(`[upload-reconcile] session=${args.sessionId} immediate confirm deferred to sweep`, error instanceof Error ? error.name : "unknown");
    }
  })();
  immediateConfirms.add(task);
  void task.finally(() => immediateConfirms.delete(task));
}

/** Tests and shutdown: wait for immediate confirms already started. */
export async function settleImmediateConfirms(): Promise<void> {
  await Promise.all([...immediateConfirms]);
}

export function startDirectUploadReconciler(): void {
  if (timer) return;
  stopped = false;
  const tick = () => void reconcileDirectUploads().catch(error => console.error("[upload-reconcile] sweep failed", error instanceof Error ? error.name : "unknown"));
  timer = setInterval(tick, 15_000);
  timer.unref?.();
  tick();
}
export async function stopDirectUploadReconciler(): Promise<void> {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  await Promise.all([sweepCompletion, settleImmediateConfirms()]);
}
