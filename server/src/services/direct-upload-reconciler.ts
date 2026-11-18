import { AsyncLocalStorage } from "node:async_hooks";
import { recordPipelineTelemetry } from "@docslurp/shared/observability";

import { sql } from "../db.js";
import { env } from "../config.js";
import { NOT_STARTED, settleBounded } from "../lib/bounded-settle.js";
import { abortAbandonedMultipartUploads, abortDirectUploadSession, finalizeDirectUploadFile, loadDirectUploadSession, lockHoldBudget, queueAbandonedDirectUploadCleanup, withDirectUploadLock } from "./direct-upload-session.js";
import { ProjectIntakeError } from "./project-intake.js";
import { confirmDirectUploadProjectIntake, isReplayedDirectUploadConfirm } from "./project-intake-actions.js";

/**
 * The async context at module load: no request. Background work started from a request (a kick after the last
 * files/complete, a storage-notification sweep) runs inside it, so it never inherits that request's API key, project
 * allowlist, organization, user or abort signal: intake reads those from the request context when a session has none.
 */
const detached = AsyncLocalStorage.snapshot();
let sweepRequested = false;

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
let stopped = false;
let sweepCompletion: Promise<void> | null = null;
let resolveSweepCompletion: (() => void) | null = null;
/** Sessions with a kick scheduled or running in this process: at most one each. */
const kicks = new Map<string, Promise<void>>();
/** Sessions kicked again while their kick was running: they get one more pass afterwards. */
const rekick = new Set<string>();
/** Aborted by stop(): cuts short kicks still waiting out their delay. */
let stopping = new AbortController();
/**
 * How long a kick waits before reconciling. A client that confirms right after its last complete (the CLI, MCP) usually
 * gets there first, and its confirm waits out a running kick rather than failing busy.
 */
export const DIRECT_UPLOAD_KICK_DELAY_MS = 1_000;

/** A scheduled session, with the next_reconcile_at that made it due (full precision, as text). */
type ScheduledSession = { id: string; user_id: string; expired: boolean; status: string; due_at: string };

const FAILED_MESSAGE = "Upload rejected: stored bytes or intake policy validation failed";

/** Durable schedule plus cross-process session locks make missed webhooks harmless. */
export async function reconcileDirectUploads(): Promise<void> {
  if (running) return;
  running = true;
  sweepCompletion = new Promise<void>(resolve => { resolveSweepCompletion = resolve; });
  try {
    do {
    sweepRequested = false;
    // Two index ranges, never a scan of every session: due sessions (upload_sessions_reconcile_idx, 0078) and
    // abandoned initializing ones past their deadline (upload_sessions_initializing_expiry_idx, 0197).
    const sessions = await sql<ScheduledSession[]>`
      select * from (
        (select id, user_id, status, expires_at < now() as expired, next_reconcile_at::text as due_at from upload_sessions
          where status in ('pending', 'uploading', 'ingesting') and next_reconcile_at <= now()
            -- A client completing its own files holds the session briefly (files/complete); an expired one is swept regardless.
            and (client_finalizing_until is null or client_finalizing_until <= now() or expires_at < now())
          order by next_reconcile_at limit 25)
        union all
        (select id, user_id, status, true as expired, next_reconcile_at::text as due_at from upload_sessions
          where status = 'initializing' and expires_at < now() and next_reconcile_at <= now()
          order by expires_at limit 25)
      ) due
      order by due_at::timestamptz limit 25`;
    for (const session of sessions) {
      if (stopped) break;
      await reconcileSession(session, "sweep");
    }
    } while (sweepRequested && !stopped);
    // Provider multipart aborts of aborted and failed sessions run here, outside any session lock: the ones an abort
    // request started but could not finish, and those of sessions the sweep failed or expired.
    if (!stopped) {
      await abortAbandonedMultipartUploads({ limit: 50 }).catch(error =>
        console.error("[upload-reconcile] multipart abort drain failed", error instanceof Error ? error.name : "unknown"));
    }
  } finally { running = false; resolveSweepCompletion?.(); resolveSweepCompletion = null; sweepCompletion = null; }
}

function isTerminal(error: unknown): error is ProjectIntakeError {
  return error instanceof ProjectIntakeError && error.statusCode !== 409 && error.statusCode < 500;
}

function isBusy(error: unknown): boolean {
  return error instanceof ProjectIntakeError && error.statusCode === 409 && (error as { code?: string }).code === "upload_session_busy";
}

/** What a terminal transition must still find: the session's status and its files' completion state. */
async function fingerprint(sessionId: string): Promise<string> {
  const [row] = await sql<Array<{ fingerprint: string }>>`
    select s.status || ':' || count(f.id) filter (where f.status = 'completed') || ':' || coalesce(max(f.updated_at)::text, '') as fingerprint
    from upload_sessions s left join upload_session_files f on f.session_id = s.id where s.id = ${sessionId} group by s.status`;
  return row?.fingerprint ?? "";
}

/** Fails the session only if it is still exactly as observed; never over a client's repair or newer progress. */
async function failIfUnchanged(sessionId: string, observed: string): Promise<void> {
  if (await fingerprint(sessionId) !== observed) return;
  const [status] = observed.split(":");
  const failed = await sql<Array<{ id: string }>>`update upload_sessions set status = 'failed', last_error = ${FAILED_MESSAGE}
    where id = ${sessionId} and status = ${status ?? ""} and status <> 'confirmed' returning id`;
  if (failed.length) await queueAbandonedDirectUploadCleanup(sessionId);
}

type Pass = "ready" | "waiting" | "partial" | "skip";

/** Due (the last file completed, a notification, a retry falling due) to confirmed: the latency kicks and sweeps bound. */
function recordReconcileLag(sessionId: string, path: "kick" | "sweep", dueAt: string): void {
  const seconds = Math.max(0, (Date.now() - new Date(dueAt).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return;
  console.log(`[upload-reconcile] confirmed session=${sessionId} path=${path} lag_ms=${Math.round(seconds * 1000)}`);
  recordPipelineTelemetry("upload.reconcile_lag.duration", seconds, { path }, "duration");
}

async function reconcileSession(session: ScheduledSession, path: "kick" | "sweep"): Promise<void> {
  let retryCapSeconds = 30;
  let reschedule: "backoff" | "now" | "none" = "backoff";
  let observed: string | null = null;
  try {
    if (session.expired && session.status !== "ingesting") {
      await abortDirectUploadSession(session.id, session.user_id);
      return;
    }
    const pass = await withDirectUploadLock<Pass>(session.id, async () => {
      const loaded = await loadDirectUploadSession(session.id, session.user_id);
      if (!loaded || !["pending", "uploading", "ingesting"].includes(loaded.session.status)) return "skip";
      // A client may have started completing files since this session was selected: leave it to the client.
      const [hold] = await sql<Array<{ held: boolean }>>`select coalesce(client_finalizing_until > now() and expires_at > now(), false) as held
        from upload_sessions where id = ${session.id}`;
      if (hold?.held) return "skip";
      // Files are independent in storage: verify and seal them a few at a time, within this hold's budget. Every
      // started file finishes; the first failure (in file order) then decides retry or terminal handling.
      const budget = lockHoldBudget();
      const outcomes = await settleBounded(loaded.files, env.directUploadFinalizeConcurrency,
        file => finalizeDirectUploadFile(file, undefined, { signal: budget.signal }), { shouldStart: budget.shouldStart });
      const failure = outcomes.find(outcome => outcome.status === "rejected" && outcome.reason !== NOT_STARTED) as PromiseRejectedResult | undefined;
      if (failure) {
        // Terminal under the same hold that saw the failure, so no client repair can interleave.
        if (isTerminal(failure.reason)) await failIfUnchanged(session.id, await fingerprint(session.id));
        throw failure.reason;
      }
      if (outcomes.some(outcome => outcome.status === "rejected")) return "partial";
      if (!outcomes.every(outcome => outcome.status === "fulfilled" && outcome.value)) return "waiting";
      observed = await fingerprint(session.id);
      return "ready";
    }, undefined, undefined, { lockClass: "reconcile" });
    if (pass === "skip") { reschedule = "none"; return; }
    // Not every file was reached in this hold: come back at once rather than after a backoff.
    if (pass === "partial") { reschedule = "now"; return; }
    if (pass === "ready" && !stopped) {
      const result = await confirmDirectUploadProjectIntake({ sessionId: session.id, userId: session.user_id });
      // A replay means another path (the client's confirm, another process) started the run and owns its lag.
      if (!isReplayedDirectUploadConfirm(result)) recordReconcileLag(session.id, path, session.due_at);
    }
  } catch (error) {
    // Someone else holds the session (a client's call, a confirm, another process): leave it to them, quietly.
    if (isBusy(error)) { reschedule = "none"; return; }
    retryCapSeconds = 300;
    // Keep retrying recoverable storage/database failures until abandonment.
    // Persist only a generic message: provider errors may contain credentials.
    console.error(`[upload-reconcile] session=${session.id} failed`, error instanceof Error ? error.name : "unknown");
    // A terminal confirm failure (policy, a revoked key): apply it under the lock, only to the state that produced it.
    if (isTerminal(error) && observed !== null) {
      const seen = observed;
      await withDirectUploadLock(session.id, () => failIfUnchanged(session.id, seen), undefined, undefined, { lockClass: "reconcile" })
        .catch(lockError => { if (!isBusy(lockError)) throw lockError; });
    }
    await sql`update upload_sessions set last_error = 'Upload finalization is retrying' where id = ${session.id} and status in ('pending', 'uploading', 'ingesting')`;
  } finally {
    // Never push back a session that newer work (a client's last complete, a webhook) made due meanwhile.
    if (reschedule === "backoff") {
      await sql`update upload_sessions set reconcile_attempts = reconcile_attempts + 1,
        next_reconcile_at = now() + least(${retryCapSeconds}, 5 * power(2, least(reconcile_attempts, 6))) * interval '1 second'
        where id = ${session.id} and status in ('pending', 'uploading', 'ingesting') and next_reconcile_at = ${session.due_at}::timestamptz`;
    } else if (reschedule === "now") {
      await sql`update upload_sessions set next_reconcile_at = now()
        where id = ${session.id} and status in ('pending', 'uploading', 'ingesting') and next_reconcile_at = ${session.due_at}::timestamptz`;
    }
  }
}

/**
 * Reconciles one session soon, in this process, without waiting for the next sweep: called after the request that
 * completed a session's last file has released its lock. Non-blocking and best effort; the durable schedule
 * (next_reconcile_at = now()) still covers a kick that is lost, skipped or fails. A kick requested while one runs
 * gets one more pass afterwards.
 */
export function kickDirectUploadReconcile(sessionId: string): void {
  // Only where the reconciler runs (the API server): a process without it leaves the session to the sweep.
  if (!timer || stopped) return;
  if (kicks.has(sessionId)) { rekick.add(sessionId); return; }
  // Detached: the kick is started by the request that completed the last file, and must not run in its context.
  const run = detached(() => (async () => {
    const signal = stopping.signal;
    await new Promise<void>(resolve => {
      const t = setTimeout(done, DIRECT_UPLOAD_KICK_DELAY_MS);
      t.unref?.();
      function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
      signal.addEventListener("abort", done, { once: true });
    });
    if (stopped) return;
    const [session] = await sql<ScheduledSession[]>`
      select id, user_id, status, expires_at < now() as expired, next_reconcile_at::text as due_at from upload_sessions
      where id = ${sessionId} and status in ('pending', 'uploading', 'ingesting')`;
    if (session) await reconcileSession(session, "kick");
  })())
    .catch(error => console.error(`[upload-reconcile] kick session=${sessionId} failed`, error instanceof Error ? error.name : "unknown"))
    .finally(() => {
      kicks.delete(sessionId);
      if (rekick.delete(sessionId)) kickDirectUploadReconcile(sessionId);
    });
  kicks.set(sessionId, run);
}

/**
 * A storage notification made sessions due: sweep now (in this process, outside the notifying request's context)
 * rather than at the next tick. Coalesced: a request while a sweep runs gets one more pass after it.
 */
export function requestDirectUploadSweep(): void {
  if (!timer || stopped) return;
  if (running) { sweepRequested = true; return; }
  void detached(() => reconcileDirectUploads()).catch(error => console.error("[upload-reconcile] sweep failed", error instanceof Error ? error.name : "unknown"));
}

export function startDirectUploadReconciler(): void {
  if (timer) return;
  stopped = false;
  stopping = new AbortController();
  const tick = () => void reconcileDirectUploads().catch(error => console.error("[upload-reconcile] sweep failed", error instanceof Error ? error.name : "unknown"));
  timer = setInterval(tick, 15_000);
  timer.unref?.();
  tick();
}
export async function stopDirectUploadReconciler(): Promise<void> {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  rekick.clear();
  stopping.abort();
  while (kicks.size || sweepCompletion) await Promise.all([sweepCompletion, ...kicks.values()]);
}
