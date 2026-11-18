import { sql } from "../db.js";
import { env } from "../config.js";
import { settleBounded } from "../lib/bounded-settle.js";
import { abortDirectUploadSession, finalizeDirectUploadFileInBackground } from "./direct-upload-session.js";
import { registerDirectUploadWaveCheckHandler, requestDirectUploadWaveCheck, settleDirectUploadWaveChecks } from "./direct-upload-wave-scheduler.js";
import { advanceDirectUploadWaves, WAVE_BLOCKED_RETRY_SECONDS } from "./direct-upload-waves.js";
import { ProjectIntakeError } from "./project-intake.js";
import { isRunCreationBlockedError } from "./run-creation.js";

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

type ScheduledSession = { id: string; user_id: string; expired: boolean; status: string; checked_at: Date | string };

/**
 * Two independent passes, each covering lost or skipped work:
 * - files: a file still open past its grace period (`next_check_at`) is checked in storage and finalized, the fallback
 *   for a lost storage webhook or a client that never calls `files/complete`;
 * - sessions: due waves start, finished sessions are confirmed, expired ones are aborted.
 */
export async function reconcileDirectUploads(): Promise<void> {
  if (running) return;
  running = true;
  sweepCompletion = new Promise<void>(resolve => { resolveSweepCompletion = resolve; });
  try {
    await reconcilePendingUploadFiles();
    const sessions = await sql<ScheduledSession[]>`
      select id, user_id, status, expires_at < now() as expired, now() as checked_at from upload_sessions
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
      finalizeDirectUploadFileInBackground({ fileId: row.id, sessionId: row.session_id, userId: row.user_id }));
    checked += due.length;
  }
  return checked;
}

async function reconcileSession(session: ScheduledSession, mode: "sweep" | "kick"): Promise<void> {
  let nextCheckMs: number | null = null;
  let failed = false;
  let reschedule = true;
  try {
    if (session.expired && session.status !== "ingesting") {
      // Runs already started keep their files; every file no run took is aborted and cleaned up.
      await abortDirectUploadSession(session.id, session.user_id);
      return;
    }
    nextCheckMs = (await advanceDirectUploadWaves(session.id, session.user_id)).nextCheckMs;
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
    console.error(`[upload-reconcile] session=${session.id} failed`, error instanceof Error ? error.name : "unknown");
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
          case when next_reconcile_at > ${session.checked_at} then next_reconcile_at else 'infinity'::timestamptz end)
        where id = ${session.id} and status in ('pending', 'uploading', 'ingesting')`;
      if (nextCheckMs !== null) requestDirectUploadWaveCheck(session.id, nextCheckMs);
    }
  }
}

/** The in-process wave timer: one session, now. */
async function checkSessionWaves(sessionId: string): Promise<void> {
  if (stopped) return;
  const [session] = await sql<ScheduledSession[]>`
    select id, user_id, status, expires_at < now() as expired, now() as checked_at from upload_sessions
    where id = ${sessionId} and status in ('pending', 'uploading', 'ingesting')`;
  if (session) await reconcileSession(session, "kick");
}

export function startDirectUploadReconciler(): void {
  if (timer) return;
  stopped = false;
  registerDirectUploadWaveCheckHandler(checkSessionWaves);
  const tick = () => void reconcileDirectUploads().catch(error => console.error("[upload-reconcile] sweep failed", error instanceof Error ? error.name : "unknown"));
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
