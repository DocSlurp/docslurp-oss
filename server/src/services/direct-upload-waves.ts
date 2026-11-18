/**
 * Early ingestion for direct uploads: a session starts runs ("waves") while its upload is still in progress.
 *
 * A wave takes every finalized file not yet in a run. It is due when `directUploadWaveFiles` such files are waiting,
 * `directUploadWaveDelayMs` after the first of them was finalized, when no file is still open, or when the client
 * confirms (a flush). Every wave is an ordinary billable run in the session's one project: the same reservation,
 * budget and admission checks, refused per wave. The first wave resolves the project (creating and self-titling it
 * when asked); later waves reuse it and never re-title it. Wave 1's run id is the session id, so `result` keeps meaning
 * the first run.
 *
 * Waves run under the session lock (with abort and confirm), never under a file's finalize lease, so finalizing files
 * never waits for a wave. A file joins a run once (`upload_session_files.run_id`, set only while it is null), so no file
 * is ingested twice; a refused or failed wave releases its files for the next attempt.
 */
import { randomUUID } from "node:crypto";

import { projectTemplateKeySchema, sanitizeStoredPipeline, type ChartExportTier } from "@docslurp/shared";

import { sql } from "../db.js";
import { env } from "../config.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { getLiveApiKeyById } from "./api-keys.js";
import { assertSessionProjectStillContributable } from "./direct-session-idempotency.js";
import {
  assertUploadSessionActive,
  listDirectUploadRuns,
  loadDirectUploadSessionRow,
  queueAbandonedDirectUploadCleanup,
  withDirectUploadLock,
  type DirectUploadRunSummary,
  type StoredFinalizeError,
  type UploadSessionRow,
} from "./direct-upload-session.js";
import { loadIntakeExtract } from "./extracts.js";
import {
  actionResult,
  assertIntakeChartExportTier,
  authorizeReceiptProject,
  requiredIntake,
  type ProjectIntakeActionResult,
  type ProjectIntakePayload,
} from "./project-intake-actions.js";
import {
  isAllRejectedError,
  ProjectIntakeError,
  projectIntakePorts,
  rejectionCode,
  type ProjectIntakeAudit,
  type ProjectIntakeItem,
  type ProjectIntakePorts,
} from "./project-intake.js";
import { discardUnstartedRun, isRunCreationBlockedError } from "./run-creation.js";

const ACTIVE = ["pending", "uploading", "ingesting"];
/** A wave refused by billing or admission is retried no sooner than this (a confirm still tries at once). */
export const WAVE_BLOCKED_RETRY_SECONDS = 60;

let wavePorts: ProjectIntakePorts = projectIntakePorts;
/** Tests: the intake ports background waves use (routes pass their own). */
export function setDirectUploadWavePortsForTesting(ports: ProjectIntakePorts | null): void {
  wavePorts = ports ?? projectIntakePorts;
}

type WaitingFile = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number | string;
  source_key: string;
  canonical_id: string | null;
  source_path: string | null;
};

type AdvanceOptions = { flush: boolean; audit?: ProjectIntakeAudit; ports: ProjectIntakePorts };
/** When the session should be looked at again (ms from now), or null when nothing is waiting on a timer. */
type AdvanceOutcome = { nextCheckMs: number | null; refusal?: unknown };

/**
 * Starts every wave that is due, then finishes the session once every file is in a run or failed. Holds the session
 * lock (busy: 409 `upload_session_busy`). Used by the reconciler's sweep and its in-process wave timers.
 */
export async function advanceDirectUploadWaves(sessionId: string, userId: string, lockWaitMs = 0): Promise<AdvanceOutcome> {
  return withDirectUploadLock(sessionId, () => advanceLocked(sessionId, userId, { flush: false, ports: wavePorts }), undefined, undefined, lockWaitMs);
}

async function advanceLocked(sessionId: string, userId: string, options: AdvanceOptions): Promise<AdvanceOutcome> {
  let flush = options.flush;
  // Each pass either starts a wave (taking at least one file) or returns, so this ends; the cap is a backstop.
  for (let pass = 0; pass < 10_000; pass += 1) {
    const session = await loadDirectUploadSessionRow(sessionId, userId);
    if (!session) throw new ProjectIntakeError("Upload session not found", 404);
    if (!ACTIVE.includes(session.status)) return { nextCheckMs: null };
    await recoverInterruptedWaves(session.id);
    const waiting = await sql<WaitingFile[]>`
      select id, filename, mime_type, size_bytes, source_key, canonical_id, source_path from upload_session_files
      where session_id = ${session.id} and status = 'completed' and run_id is null
      order by request_index asc nulls last, created_at asc`;
    const [state] = await sql<Array<{ open: boolean; delay_ms: number | null; blocked_ms: number | null }>>`
      select exists (select 1 from upload_session_files where session_id = ${session.id} and status = 'pending') as open,
        (select greatest(0, ceil(extract(epoch from (min(finalized_at) + ${env.directUploadWaveDelayMs}::int * interval '1 millisecond' - now())) * 1000))::int
          from upload_session_files where session_id = ${session.id} and status = 'completed' and run_id is null) as delay_ms,
        greatest(0, ceil(extract(epoch from (wave_blocked_until - now())) * 1000))::int as blocked_ms
      from upload_sessions where id = ${session.id}`;
    const open = state?.open ?? true;
    if (waiting.length === 0) {
      if (!open) await finishSession(session);
      return { nextCheckMs: null };
    }
    const extract = Boolean(session.extract_id);
    // An extract owns exactly one run: it starts once every file is in, as before waves existed.
    if (extract && open) {
      if (flush) throw new ProjectIntakeError("Upload session still has incomplete files", 409);
      return { nextCheckMs: null };
    }
    const delayMs = Number(state?.delay_ms ?? 0);
    const due = !open || flush || waiting.length >= env.directUploadWaveFiles || delayMs <= 0;
    if (!due) return { nextCheckMs: delayMs };
    const blockedMs = Number(state?.blocked_ms ?? 0);
    if (blockedMs > 0 && !flush) return { nextCheckMs: blockedMs };
    try {
      await startWave(session, waiting, options);
    } catch (error) {
      // A flush that billing refused still answers with the runs already started (and says why the rest waits).
      if (flush && isRunCreationBlockedError(error)) return { nextCheckMs: WAVE_BLOCKED_RETRY_SECONDS * 1000, refusal: error };
      throw error;
    }
    flush = false;
  }
  return { nextCheckMs: 0 };
}

/**
 * A wave whose holder died between taking its files and recording its run: adopt a committed run, otherwise discard
 * the half-created one and give its files back. Runs under the session lock, so no live holder is affected.
 */
async function recoverInterruptedWaves(sessionId: string): Promise<void> {
  const stuck = await sql<Array<{ wave: number; run_id: string }>>`
    select wave, run_id from upload_session_runs where session_id = ${sessionId} and status = 'creating'`;
  for (const row of stuck) {
    const [run] = await sql<Array<{ ready: boolean }>>`select creation_ready_at is not null as ready from project_runs where id = ${row.run_id}`;
    if (run?.ready) {
      await sql`update upload_session_runs set status = 'started', started_at = now() where session_id = ${sessionId} and wave = ${row.wave}`;
      continue;
    }
    if (run) await discardUnstartedRun(row.run_id);
    await releaseWave(sessionId, row.wave, row.run_id);
  }
}

async function releaseWave(sessionId: string, wave: number, runId: string): Promise<void> {
  await sql`update upload_session_files set run_id = null where session_id = ${sessionId} and run_id = ${runId}`;
  await sql`delete from upload_session_runs where session_id = ${sessionId} and wave = ${wave} and status = 'creating'`;
}

/** Every billable wave re-checks that its uploader may still contribute and its API key may still ingest. */
async function assertSessionMayStartRun(session: UploadSessionRow): Promise<void> {
  await assertSessionProjectStillContributable(session, session.user_id);
  if (!session.api_key_id) return;
  if (session.project_id) {
    await authorizeReceiptProject(session.project_id, session.user_id, session.org_id, session.api_key_id);
    return;
  }
  const key = await getLiveApiKeyById(session.api_key_id);
  if (!key || (session.org_id && key.orgId !== session.org_id) || !key.scopes.includes("ingest")) {
    throw new ProjectIntakeError("API key no longer permits this upload", 403);
  }
}

async function startWave(session: UploadSessionRow, waiting: WaitingFile[], options: AdvanceOptions): Promise<void> {
  const [last] = await sql<Array<{ wave: number | null; started: number }>>`
    select max(wave) as wave, count(*) filter (where status = 'started')::int as started from upload_session_runs where session_id = ${session.id}`;
  const wave = Number(last?.wave ?? 0) + 1;
  const earlierRuns = Number(last?.started ?? 0) > 0;
  const runId = wave === 1 ? session.id : randomUUID();

  try {
    await assertSessionMayStartRun(session);
  } catch (error) {
    // Fail closed: a revoked share, membership or key stops every further wave (runs already started are left alone).
    if (error instanceof ProjectIntakeError && [403, 404].includes(error.statusCode)) {
      await failSession(session.id, "Upload rejected: the uploader or API key may no longer add to this project");
    }
    throw error;
  }
  const extract = session.extract_id ? await loadIntakeExtract(session.extract_id, session.user_id) : null;
  if (session.extract_id && !extract) throw new ProjectIntakeError("This extract expired before its files were confirmed.", 409);
  const pipeline = session.pipeline ? sanitizeStoredPipeline(session.pipeline, `upload session ${session.id}`) : undefined;
  // Re-checked per wave: a session opened before the deployment stopped offering a tier is refused with the same code.
  assertIntakeChartExportTier((pipeline as { chartExport?: { tier?: ChartExportTier } } | undefined)?.chartExport?.tier, `upload session ${session.id}`);

  // The wave row first (a crash leaves it `creating` for recovery), then its files, each taken only while untaken.
  await sql`insert into upload_session_runs (session_id, wave, run_id, status, file_count) values (${session.id}, ${wave}, ${runId}, 'creating', 0)`;
  const taken = await sql<Array<{ id: string }>>`
    update upload_session_files set run_id = ${runId}, updated_at = now()
    where session_id = ${session.id} and id = any(${sql.array(waiting.map(file => file.id))}) and status = 'completed' and run_id is null
    returning id`;
  const takenIds = new Set(taken.map(row => row.id));
  const files = waiting.filter(file => takenIds.has(file.id));
  if (files.length === 0) {
    await releaseWave(session.id, wave, runId);
    return;
  }
  await sql`update upload_session_runs set file_count = ${files.length} where session_id = ${session.id} and wave = ${wave}`;

  // A run left by an attempt that died before its wave row existed (a session confirmed before waves): adopt a
  // committed one, discard a half-created one.
  const [leftover] = await sql<Array<{ ready: boolean }>>`select creation_ready_at is not null as ready from project_runs where id = ${runId}`;
  if (leftover?.ready) {
    await sql`update upload_session_runs set status = 'started', started_at = now() where session_id = ${session.id} and wave = ${wave}`;
    return;
  }
  if (leftover) await discardUnstartedRun(runId);

  const ports = options.ports;
  const sessionId = session.id;
  const intakePorts: ProjectIntakePorts = { ...ports, records: {
    ...ports.records,
    // Self-titling applies once: a later wave never re-titles the project from its own files.
    nameFromUpload: earlierRuns ? undefined : ports.records.nameFromUpload,
    async discardProject(projectId) {
      await ports.records.discardProject(projectId);
      await sql`update upload_sessions set project_id = null where id = ${sessionId} and project_id = ${projectId}`;
    },
    async createProject(input) {
      const project = await ports.records.createProject(input);
      await sql`update upload_sessions set project_id = ${project.id}, org_id = ${project.orgId} where id = ${sessionId}`;
      return project;
    },
  } };
  const items: ProjectIntakeItem[] = files.map(file => ({
    filename: file.filename,
    mimeType: file.mime_type,
    sizeBytes: Number(file.size_bytes),
    canonicalId: file.canonical_id ?? null,
    path: file.source_path ?? "",
    content: { storedKey: file.source_key, verifiedSizeBytes: Number(file.size_bytes) },
  }));

  let result: ProjectIntakeActionResult;
  try {
    const intake = await requiredIntake({
      userId: session.user_id,
      orgId: session.org_id,
      // The first wave resolves (or creates) the project and records it on the session; every later wave targets it.
      project: session.project_id ?? session.project_name,
      newProject: !session.project_id && !session.project_name,
      templateKey: !session.project_id && session.template_key ? projectTemplateKeySchema.parse(session.template_key) : undefined,
      speedBoost: session.pipeline?.speedBoost === true,
      pipeline,
      tags: session.tags ?? [],
      apiKeyId: session.api_key_id,
      // Recorded from the principal that opened the session (never a request field); older rows are machine.
      origin: session.origin === "app" ? "app" : "machine",
      allowedProjectIds: session.allowed_project_ids,
      runId,
      kind: "direct-upload",
      items,
      audit: options.audit ? { ...options.audit, metadata: { ...options.audit.metadata, wave } } : undefined,
      ...(extract ? { extract } : {}),
    }, intakePorts);
    result = actionResult(intake);
  } catch (error) {
    await releaseWave(session.id, wave, runId);
    // Files refused one by one fail on their own; the session carries on with the rest.
    if (await handleWaveRefusal(session, files, error)) return;
    throw error;
  }
  await sql`update upload_session_runs set status = 'started', started_at = now(), result = ${sql.json(JSON.parse(JSON.stringify(result)))}
    where session_id = ${session.id} and wave = ${wave}`;
  await sql`update upload_sessions set project_id = coalesce(project_id, ${result.payload.project.id}), org_id = coalesce(org_id, ${result.payload.project.orgId ?? null}),
      last_error = null, wave_blocked_until = null, updated_at = now()
    where id = ${session.id}`;
  console.log(`[upload-waves] session=${session.id} wave=${wave} run=${runId} files=${files.length}`);
}

/**
 * Classifies a refused wave (its files are already released). True: handled, the session carries on.
 * - billing or admission (402): the files wait, retried after a pause or at once by a confirm;
 * - every file of the wave rejected for its own reason: those files fail, the session carries on;
 * - a definite refusal of the session itself (access revoked, project gone): the session fails, started runs stay;
 * - anything else (storage, database, a busy lock): retried by the reconciler.
 */
async function handleWaveRefusal(session: UploadSessionRow, files: WaitingFile[], error: unknown): Promise<boolean> {
  if (isRunCreationBlockedError(error)) {
    await sql`update upload_sessions set wave_blocked_until = now() + ${WAVE_BLOCKED_RETRY_SECONDS}::int * interval '1 second',
      last_error = ${`Ingestion is waiting: ${error.code}`}, updated_at = now() where id = ${session.id}`;
    return false;
  }
  if (isAllRejectedError(error)) {
    const byName = new Map((error.issues ?? []).map(issue => [issue.path, issue]));
    for (const file of files) {
      const issue = byName.get(sanitizeUploadFilename(file.filename));
      const stored: StoredFinalizeError = { statusCode: error.statusCode, code: issue?.code ?? rejectionCode(error), message: issue?.message ?? error.message };
      await sql`update upload_session_files set status = 'failed', finalize_error = ${sql.json(stored)}, updated_at = now()
        where id = ${file.id} and status = 'completed' and run_id is null`;
    }
    console.error(`[upload-waves] session=${session.id} files-rejected=${files.length}`);
    return true;
  }
  if (error instanceof ProjectIntakeError && [400, 401, 403, 404, 413, 415, 422].includes(error.statusCode)) {
    await failSession(session.id, "Upload rejected: stored bytes or intake policy validation failed");
  }
  return false;
}

/** Stops the session: no further waves. Runs already started keep running; files no run took are cleaned up. */
async function failSession(sessionId: string, message: string): Promise<void> {
  await sql`update upload_sessions set status = 'failed', last_error = ${message}, updated_at = now()
    where id = ${sessionId} and status in ('pending', 'uploading', 'ingesting')`;
  await queueAbandonedDirectUploadCleanup(sessionId);
}

/** Every file is in a run or failed: the session is confirmed (its `result` is the first run), or failed with no run. */
async function finishSession(session: UploadSessionRow): Promise<void> {
  const [first] = await sql<Array<{ result: unknown }>>`
    select result from upload_session_runs where session_id = ${session.id} and status = 'started' order by wave limit 1`;
  if (!first) {
    await failSession(session.id, "Upload rejected: no file of this upload could be ingested");
    return;
  }
  await sql`update upload_sessions set status = 'confirmed', result = ${first.result === null ? null : sql.json(JSON.parse(JSON.stringify(first.result)))},
      last_error = null, client_finalizing_until = null, updated_at = now()
    where id = ${session.id} and status in ('pending', 'uploading', 'ingesting')`;
}

export type DirectUploadConfirmPayload = ProjectIntakePayload & {
  /** Every run this upload started, in order; `run` above is the first. */
  runs: DirectUploadRunSummary[];
  /** The session's status after this call: `confirmed` once every file is in a run. */
  sessionStatus: string;
  /** Files still uploading; each starts a later run as it arrives. */
  pendingFileCount: number;
};

/**
 * POST .../confirm: a flush. Starts a wave with every finalized file not yet in a run (even below the wave size), then
 * answers the session's runs, with the first run's intake response at the top level as before. Files still uploading
 * keep starting runs as they arrive. Idempotent: a confirmed session answers its runs again.
 */
export async function confirmDirectUploadProjectIntake(
  /** `lockWaitMs`: how long to wait out a wave or another request holding the session (0: answer busy at once). */
  args: { sessionId: string; userId: string; audit?: ProjectIntakeAudit; lockWaitMs?: number },
  ports: ProjectIntakePorts = projectIntakePorts,
): Promise<ProjectIntakeActionResult & { payload: DirectUploadConfirmPayload }> {
  return withDirectUploadLock(args.sessionId, async () => {
    const session = await loadDirectUploadSessionRow(args.sessionId, args.userId);
    if (!session) throw new ProjectIntakeError("Upload session not found", 404);
    if (["aborted", "failed"].includes(session.status)) throw new ProjectIntakeError("Upload session is closed", 409);
    let refusal: unknown;
    if (session.status !== "confirmed") {
      assertUploadSessionActive(session);
      const [files] = await sql<Array<{ count: number }>>`select count(*)::int as count from upload_session_files where session_id = ${session.id}`;
      if (!files || Number(files.count) === 0) throw new ProjectIntakeError("Upload session has no files", 400);
      refusal = (await advanceLocked(session.id, args.userId, { flush: true, audit: args.audit, ports })).refusal;
    }
    const [first] = await sql<Array<{ result: ProjectIntakeActionResult | null }>>`
      select result from upload_session_runs where session_id = ${session.id} and status = 'started' order by wave limit 1`;
    if (!first) {
      if (refusal) throw refusal;
      const [now] = await sql<Array<{ status: string }>>`select status from upload_sessions where id = ${session.id}`;
      if (now && ["failed", "aborted"].includes(now.status)) throw new ProjectIntakeError("Upload session is closed", 409);
      throw new ProjectIntakeError("Upload session still has incomplete files", 409);
    }
    if (!first.result) throw new ProjectIntakeError("Committed intake response requires reconciliation", 409, undefined, "intake_reconciliation_required");
    await authorizeReceiptProject(first.result.payload.project.id, args.userId, session.org_id, session.api_key_id);
    const runs = await listDirectUploadRuns(session.id);
    const [state] = await sql<Array<{ status: string; pending: number }>>`
      select status, (select count(*)::int from upload_session_files where session_id = ${session.id} and status = 'pending') as pending
      from upload_sessions where id = ${session.id}`;
    const warnings = [...first.result.payload.warnings];
    if (refusal instanceof Error) warnings.push(`Further files are waiting to start: ${refusal.message}`);
    return {
      ...first.result,
      payload: { ...first.result.payload, warnings, runs, sessionStatus: state?.status ?? session.status, pendingFileCount: Number(state?.pending ?? 0) },
    };
  }, undefined, undefined, args.lockWaitMs ?? 0);
}
