import { sql } from "../db.js";
import { env } from "../config.js";
import { settleBounded } from "../lib/bounded-settle.js";
import { abortDirectUploadSession, finalizeDirectUploadFileInBackground } from "./direct-upload-session.js";
import { registerDirectUploadWaveCheckHandler, requestDirectUploadWaveCheck, settleDirectUploadWaveChecks } from "./direct-upload-wave-scheduler.js";
import { advanceDirectUploadWaves, flushExpiredDirectUploadSession, WAVE_BLOCKED_RETRY_SECONDS } from "./direct-upload-waves.js";
import { ProjectIntakeError } from "./project-intake.js";
import { isRunCreationBlockedError } from "./run-creation.js";
import { errorClass, uploadEvent } from "../lib/upload-telemetry.js";

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
let stopped = false;
let sweepCompletion: Promise<void> | null = null;
let resolveSweepCompletion: (() => void) | null = null;

/** How soon a wave check that found its session busy (another process's wave, an abort, a confirm) tries again. */
export const DIRECT_UPLOAD_BUSY_RETRY_MS = 1_000;
/** With nothing due on a timer, a session is still looked at this often (expiry, a lost wave timer). */
const IDLE_CHECK_MS = 300_000;
/** Files the fallback takes per query, and how long one sweep may spend on them. */
const FALLBACK_BATCH = 200;
const FALLBACK_BUDGET_MS = 10_000;
/** A file the fallback is looking at is not offered to another sweep for this long. */
const FALLBACK_CLAIM_SECONDS = 15;

type ScheduledSession = { id: string; user_id: string; org_id: string | null; expired: boolean; status: string; finalize_protocol: string | null; checked_at: Date | string };

/**
 * Two independent passes, each covering lost or skipped work:
 * - files: a file still open past its grace period (`next_check_at`) is checked in storage and finalized, the fallback
 *   for a lost storage webhook or a client that never calls `files/complete`;
 * - sessions: due waves start, finished sessions are confirmed; an expired one first flushes its finalized files into a
 *   last run (refused only by admission or billing), then aborts the rest.
 */
export async function reconcileDirectUploads(): Promise<void> {
  if (running) return;
  running = true;
  sweepCompletion = new Promise<void>(resolve => { resolveSweepCompletion = resolve; });
  try {
    await reconcilePendingUploadFiles();
    const sessions = await sql<ScheduledSession[]>`
      select id, user_id, org_id, status, finalize_protocol, expires_at < now() as expired, now() as checked_at from upload_sessions
      where (status in ('pending', 'uploading', 'ingesting') or (status = 'initializing' and expires_at < now())) and next_reconcile_at <= now()
      order by next_reconcile_at limit 25`;
    for (const session of sessions) {
      if (stopped) break;
      await reconcileSession(session, "sweep");
    }
  } finally { running = false; resolveSweepCompletion?.(); resolveSweepCompletion = null; sweepCompletion = null; }
}

/**
 * The fallback finalizer: open files whose grace period ran out, a bounded batch at a time, each under its own lease (a
 * webhook or client finalizing the same file wins and this one skips it). A session whose client is completing its
 * own files (`client_finalizing_until`) is left to it until that hold lapses.
 */
export async function reconcilePendingUploadFiles(options: { budgetMs?: number; batch?: number } = {}): Promise<number> {
  const deadline = Date.now() + (options.budgetMs ?? FALLBACK_BUDGET_MS);
  let checked = 0;
  while (!stopped && Date.now() < deadline) {
    // Claim the batch by moving it out of the due list first, so another process's sweep (or the next query of this
    // one) never takes the same files; a file that settles meanwhile simply leaves the open set.
    const due = await sql<Array<{ id: string; session_id: string; user_id: string }>>`
      update upload_session_files f set next_check_at = now() + ${FALLBACK_CLAIM_SECONDS}::int * interval '1 second'
      from upload_sessions s
      where s.id = f.session_id and f.id in (
        select f2.id from upload_session_files f2 join upload_sessions s2 on s2.id = f2.session_id
        where f2.status = 'pending' and not f2.unknown_size and f2.next_check_at <= now()
          and (f2.finalize_lease_until is null or f2.finalize_lease_until < now())
          and s2.status in ('pending', 'uploading', 'ingesting') and s2.expires_at > now()
          and (s2.client_finalizing_until is null or s2.client_finalizing_until <= now())
        order by f2.next_check_at limit ${options.batch ?? FALLBACK_BATCH}
        for update of f2 skip locked)
      returning f.id, f.session_id, s.user_id`;
    if (due.length === 0) break;
    await settleBounded(due, env.directUploadFinalizeConcurrency, row =>
      finalizeDirectUploadFileInBackground({ fileId: row.id, sessionId: row.session_id, userId: row.user_id }, "fallback"));
    checked += due.length;
  }
  return checked;
}

async function reconcileSession(session: ScheduledSession, mode: "sweep" | "kick"): Promise<void> {
  let nextCheckMs: number | null = null;
  let failed = false;
  let reschedule = true;
  try {
    // A 'single' session starting its run ('ingesting') finishes that first, as before waves; a 'waves' session expires
    // whatever its runs are doing.
    if (session.expired && (session.status !== "ingesting" || session.finalize_protocol === "waves")) {
      await expireSession(session);
      return;
    }
    nextCheckMs = (await advanceDirectUploadWaves(session.id, session.user_id, { orgId: session.org_id })).nextCheckMs;
  } catch (error) {
    // Another holder (a wave in another process, an abort, a confirm) has the session: look again shortly.
    if (error instanceof ProjectIntakeError && error.statusCode === 409 && error.code === "upload_session_busy") {
      requestDirectUploadWaveCheck(session.id, DIRECT_UPLOAD_BUSY_RETRY_MS);
      if (mode === "kick") reschedule = false;
      else nextCheckMs = DIRECT_UPLOAD_BUSY_RETRY_MS * 5;
      return;
    }
    // Billing or admission refused a wave: recorded on the session, retried after the pause.
    if (isRunCreationBlockedError(error)) {
      nextCheckMs = WAVE_BLOCKED_RETRY_SECONDS * 1000;
      return;
    }
    failed = true;
    // Persist only a generic message: provider errors may contain credentials. A definite refusal of the session was
    // already recorded by the wave (it failed the session); anything else is retried until the session expires.
    console.error(`[upload-reconcile] session=${session.id} failed error_class=${errorClass(error)}`);
    await sql`update upload_sessions set last_error = 'Upload finalization is retrying' where id = ${session.id} and status in ('pending', 'uploading', 'ingesting')`;
  } finally {
    if (reschedule && failed) {
      await sql`update upload_sessions set reconcile_attempts = reconcile_attempts + 1,
        next_reconcile_at = now() + least(300, 5 * power(2, least(reconcile_attempts, 6))) * interval '1 second'
        where id = ${session.id} and status in ('pending', 'uploading', 'ingesting')`;
    } else if (reschedule) {
      // Keep an earlier due time someone recorded after this check began (a file finalized meanwhile).
      const proposedMs = Math.max(0, nextCheckMs ?? IDLE_CHECK_MS);
      await sql`update upload_sessions set reconcile_attempts = 0,
        next_reconcile_at = least(expires_at, now() + ${proposedMs}::int * interval '1 millisecond',
          case when next_reconcile_at >= ${session.checked_at} then next_reconcile_at else 'infinity'::timestamptz end)
        where id = ${session.id} and status in ('pending', 'uploading', 'ingesting')`;
      if (nextCheckMs !== null) requestDirectUploadWaveCheck(session.id, nextCheckMs);
    }
  }
}

/**
 * An expired session: files finalized but not in a run go into one last wave, through the same live admission, billing
 * and budget checks as any wave. Only a definite refusal (402, a revoked right, an expired extract) leaves them to the
 * abort below; a transient failure (storage, database, a busy session) is retried on the next pass instead. Then every
 * file no run took (unfinalized ones, or refused ones) is aborted and cleaned up; runs already started are left alone.
 * A session the flush finished (every file in a run) is confirmed and stays so.
 */
async function expireSession(session: ScheduledSession): Promise<void> {
  // The last run is a 'waves' session's (owner, 2026-11-17); a 'single' session expires as before waves: aborted.
  if (session.status !== "initializing" && session.finalize_protocol === "waves") {
    try {
      await flushExpiredDirectUploadSession(session.id, session.user_id, session.org_id);
    } catch (error) {
      const definite = isRunCreationBlockedError(error)
        || (error instanceof ProjectIntakeError && error.statusCode < 500 && error.code !== "upload_session_busy");
      if (!definite) {
        uploadEvent("expiry", { outcome: "retry", error_class: errorClass(error) });
        throw error;
      }
      uploadEvent("expiry", { outcome: "refused", error_class: errorClass(error) }, { severity: "warn", body: `expired upload session ${session.id}: last run refused`,
        attributes: { "docslurp.upload.session_id": session.id } });
    }
    const [now] = await sql<Array<{ status: string }>>`select status from upload_sessions where id = ${session.id}`;
    if (now?.status === "confirmed") {
      uploadEvent("expiry", { outcome: "confirmed" });
      return;
    }
  }
  await abortDirectUploadSession(session.id, session.user_id);
  const [after] = await sql<Array<{ status: string; runs: number }>>`select status,
    (select count(*)::int from upload_session_runs where session_id = ${session.id} and status = 'committed') as runs from upload_sessions where id = ${session.id}`;
  uploadEvent("expiry", { outcome: after?.status === "confirmed" ? (Number(after.runs) > 0 ? "flushed" : "confirmed") : "aborted" });
}

/** The in-process wave timer: one session, now. */
async function checkSessionWaves(sessionId: string): Promise<void> {
  if (stopped) return;
  const [session] = await sql<ScheduledSession[]>`
    select id, user_id, org_id, status, finalize_protocol, expires_at < now() as expired, now() as checked_at from upload_sessions
    where id = ${sessionId} and status in ('pending', 'uploading', 'ingesting')`;
  if (session) await reconcileSession(session, "kick");
}

export function startDirectUploadReconciler(): void {
  if (timer) return;
  stopped = false;
  registerDirectUploadWaveCheckHandler(checkSessionWaves);
  const tick = () => void reconcileDirectUploads().catch(error => console.error(`[upload-reconcile] sweep failed error_class=${errorClass(error)}`));
  timer = setInterval(tick, 15_000);
  timer.unref?.();
  tick();
}
export async function stopDirectUploadReconciler(): Promise<void> {
  stopped = true;
  registerDirectUploadWaveCheckHandler(null);
  if (timer) clearInterval(timer);
  timer = undefined;
  await Promise.all([sweepCompletion, settleDirectUploadWaveChecks()]);
}
