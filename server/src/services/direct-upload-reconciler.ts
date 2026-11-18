import { sql } from "../db.js";
import { env } from "../config.js";
import { settleBounded } from "../lib/bounded-settle.js";
import { abortDirectUploadSession, finalizeDirectUploadFile, loadDirectUploadSession, queueAbandonedDirectUploadCleanup, withDirectUploadLock } from "./direct-upload-session.js";
import { ProjectIntakeError } from "./project-intake.js";
import { confirmDirectUploadProjectIntake } from "./project-intake-actions.js";

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
let stopped = false;
let sweepCompletion: Promise<void> | null = null;
let resolveSweepCompletion: (() => void) | null = null;
/** Sessions with a kick scheduled or running in this process: at most one each. */
const kicks = new Map<string, Promise<void>>();
/**
 * How long a kick waits before reconciling. A client that confirms right after its last complete (the CLI, MCP) usually
 * gets there first, and its confirm waits out a running kick rather than failing busy.
 */
export const DIRECT_UPLOAD_KICK_DELAY_MS = 1_000;

type ScheduledSession = { id: string; user_id: string; expired: boolean; status: string };

/** Durable schedule plus cross-process session locks make missed webhooks harmless. */
export async function reconcileDirectUploads(): Promise<void> {
  if (running) return;
  running = true;
  sweepCompletion = new Promise<void>(resolve => { resolveSweepCompletion = resolve; });
  try {
    const sessions = await sql<ScheduledSession[]>`
      select id, user_id, status, expires_at < now() as expired from upload_sessions
      where (status in ('pending', 'uploading', 'ingesting') or (status = 'initializing' and expires_at < now())) and next_reconcile_at <= now()
        -- A client completing its own files holds the session briefly (files/complete); an expired one is swept regardless.
        and (client_finalizing_until is null or client_finalizing_until <= now() or expires_at < now())
      order by next_reconcile_at limit 25`;
    for (const session of sessions) {
      if (stopped) break;
      await reconcileSession(session, "sweep");
    }
  } finally { running = false; resolveSweepCompletion?.(); resolveSweepCompletion = null; sweepCompletion = null; }
}

async function reconcileSession(session: ScheduledSession, mode: "sweep" | "kick"): Promise<void> {
  let retryCapSeconds = 30;
  let reschedule = true;
  try {
    if (session.expired && session.status !== "ingesting") {
      await abortDirectUploadSession(session.id, session.user_id);
      return;
    }
    const ready = await withDirectUploadLock(session.id, async () => {
      const loaded = await loadDirectUploadSession(session.id, session.user_id);
      if (!loaded || !["pending", "uploading", "ingesting"].includes(loaded.session.status)) return false;
      // Files are independent in storage: verify and seal them a few at a time. Every file is attempted; the first
      // failure (in file order) then decides the session's retry or terminal handling below.
      const outcomes = await settleBounded(loaded.files, env.directUploadFinalizeConcurrency, file => finalizeDirectUploadFile(file));
      const failure = outcomes.find(outcome => outcome.status === "rejected");
      if (failure) throw failure.reason;
      return outcomes.every(outcome => outcome.status === "fulfilled" && outcome.value);
    });
    if (ready && !stopped) await confirmDirectUploadProjectIntake({ sessionId: session.id, userId: session.user_id });
  } catch (error) {
    // A kick that finds the session busy leaves it to whoever holds it (a client's confirm, or the sweep).
    if (mode === "kick" && error instanceof ProjectIntakeError && error.statusCode === 409 && (error as { code?: string }).code === "upload_session_busy") {
      reschedule = false;
      return;
    }
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
    if (reschedule) {
      await sql`update upload_sessions set reconcile_attempts = reconcile_attempts + 1,
        next_reconcile_at = now() + least(${retryCapSeconds}, 5 * power(2, least(reconcile_attempts, 6))) * interval '1 second'
        where id = ${session.id} and status in ('pending', 'uploading', 'ingesting')`;
    }
  }
}

/**
 * Reconciles one session soon, in this process, without waiting for the next sweep: called after the request that
 * completed a session's last file has released its lock. Non-blocking and best effort; the durable schedule
 * (next_reconcile_at = now()) still covers a kick that is lost, skipped or fails.
 */
export function kickDirectUploadReconcile(sessionId: string): void {
  // Only where the reconciler runs (the API server): a process without it leaves the session to the sweep.
  if (!timer || stopped || kicks.has(sessionId)) return;
  const run = (async () => {
    await new Promise<void>(resolve => { const t = setTimeout(resolve, DIRECT_UPLOAD_KICK_DELAY_MS); t.unref?.(); });
    if (stopped) return;
    const [session] = await sql<ScheduledSession[]>`
      select id, user_id, status, expires_at < now() as expired from upload_sessions
      where id = ${sessionId} and status in ('pending', 'uploading', 'ingesting')`;
    if (session) await reconcileSession(session, "kick");
  })()
    .catch(error => console.error(`[upload-reconcile] kick session=${sessionId} failed`, error instanceof Error ? error.name : "unknown"))
    .finally(() => { kicks.delete(sessionId); });
  kicks.set(sessionId, run);
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
  await Promise.all([sweepCompletion, ...kicks.values()]);
}
