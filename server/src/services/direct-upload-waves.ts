/**
 * Run creation for direct uploads: waves of runs while the upload is in progress ('waves' sessions), or one run once
 * every file is in ('single' sessions, and every extract). A session's protocol is fixed when it is created
 * (DOCSLURP_UPLOAD_WAVES); nothing here reads the live setting, so turning it off never changes a session in flight.
 *
 * A wave takes every finalized file not yet in a run. In a 'waves' session it is due when enough such files are waiting
 * (`directUploadWaveFiles`, growing by `directUploadWaveGrowth` per committed run), `directUploadWaveDelayMs` after the
 * first of them was finalized, when no file is still open, on a confirm (a flush) or at expiry (a last flush). A
 * 'single' session's one wave is due when no file is still open. Every wave is an ordinary billable run in the
 * session's one project, admitted, reserved and refused on its own. The first run resolves the project (creating and
 * self-titling it when asked); later runs reuse it and never re-title it.
 *
 * Exactly once (enforced by the database, migration 0193): a wave row is 'pending' while its run is created, then
 * 'committed' (moved there by the run's own publication, in the same transaction) or 'failed' (a tombstone: its run id
 * can never be published). A file joins only a pending wave and leaves only a failed one. An error after the run
 * committed adopts the run; a holder that lost its lock is fenced by the next holder and its run is refused at publish.
 *
 * Waves run under the session lock (with abort and confirm), never under a file's finalize lease, so finalizing files
 * never waits for a wave.
 */
import { randomUUID } from "node:crypto";

import { projectTemplateKeySchema, sanitizeStoredPipeline, type ChartExportTier } from "@docslurp/shared";

import { sql } from "../db.js";
import { env } from "../config.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import {
  assertUploadSessionActive,
  closeDirectUploadSession,
  describeFileFailure,
  directUploadWaveThreshold,
  fenceInterruptedWaves,
  freeFailedWaveFiles,
  listDirectUploadRuns,
  loadDirectUploadSessionRow,
  sessionProtocol,
  storedFinalizeFailure,
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
  liveDirectUploadAdmission,
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
import { mapDocument, mapProjectRun, type DocumentRow, type ProjectRunRow } from "./run-records.js";
import { getProject } from "./projects.js";
import { errorClass, recordWaveFiles, uploadEvent } from "../lib/upload-telemetry.js";

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
  status: string;
  filename: string;
  mime_type: string;
  size_bytes: number | string;
  source_key: string;
  canonical_id: string | null;
  source_path: string | null;
};

/** `background`: started by the reconciler (a refusal then closes the session), not by a client's confirm. */
type AdvanceOptions = { flush: boolean; background: boolean; expiry?: boolean; audit?: ProjectIntakeAudit; ports: ProjectIntakePorts };
/** When the session should be looked at again (ms from now), or null when nothing is waiting on a timer. */
type AdvanceOutcome = { nextCheckMs: number | null; refusal?: unknown };

/**
 * Starts every wave that is due, then finishes the session once every file is in a run or failed. Holds the session
 * lock (busy: 409 `upload_session_busy`). Used by the reconciler's sweep and its in-process wave timers.
 */
export async function advanceDirectUploadWaves(sessionId: string, userId: string, options: { lockWaitMs?: number; orgId?: string | null } = {}): Promise<AdvanceOutcome> {
  // Background waves hold their own lock class (bounded per process and per organization), so one upload's waves never
  // wait behind another's or behind the reconciler's sweep, and never take every lock connection.
  return withDirectUploadLock(sessionId, () => advanceLocked(sessionId, userId, { flush: false, background: true, ports: wavePorts }), undefined, undefined,
    { waitMs: options.lockWaitMs ?? 0, lockClass: "wave", orgId: options.orgId ?? null });
}

/**
 * The last wave of an expired session (see the reconciler's expiry): every finalized file not in a run, at once and
 * whatever the count, in the `wave` lock class. A refusal by billing is thrown (the caller then aborts the leftovers); a
 * refused admission has already failed the session. An extract session still takes its one run only with every file in.
 */
export async function flushExpiredDirectUploadSession(sessionId: string, userId: string, orgId: string | null): Promise<void> {
  const outcome = await withDirectUploadLock(sessionId, () => advanceLocked(sessionId, userId, { flush: true, background: true, expiry: true, ports: wavePorts }),
    undefined, undefined, { lockClass: "wave", orgId });
  if (outcome.refusal) throw outcome.refusal;
}

async function advanceLocked(sessionId: string, userId: string, options: AdvanceOptions): Promise<AdvanceOutcome> {
  let flush = options.flush;
  // Each pass either starts a wave (taking at least one file) or returns, so this ends; the cap is a backstop.
  for (let pass = 0; pass < 10_000; pass += 1) {
    const session = await loadDirectUploadSessionRow(sessionId, userId);
    if (!session) throw new ProjectIntakeError("Upload session not found", 404);
    if (!ACTIVE.includes(session.status)) return { nextCheckMs: null };
    // We hold the session lock: a pending wave belongs to a holder that crashed or lost the lock. Fence it.
    if (await fenceInterruptedWaves(session.id) > 0) uploadEvent("wave", { outcome: "fenced", protocol: sessionProtocol(session), trigger: "recovery" });
    const waiting = await sql<WaitingFile[]>`
      select id, status, filename, mime_type, size_bytes, source_key, canonical_id, source_path from upload_session_files
      where session_id = ${session.id} and status in ('completed', 'finalized') and run_id is null
      order by request_index asc nulls last, created_at asc`;
    const [state] = await sql<Array<{ open: boolean; waves: number; delay_ms: number | null; blocked_ms: number | null }>>`
      select exists (select 1 from upload_session_files where session_id = ${session.id} and status = 'pending') as open,
        (select count(*)::int from upload_session_runs where session_id = ${session.id} and status = 'committed') as waves,
        (select greatest(0, ceil(extract(epoch from (min(finalized_at) + ${env.directUploadWaveDelayMs}::int * interval '1 millisecond' - now())) * 1000))::int
          from upload_session_files where session_id = ${session.id} and status in ('completed', 'finalized') and run_id is null) as delay_ms,
        greatest(0, ceil(extract(epoch from (wave_blocked_until - now())) * 1000))::int as blocked_ms
      from upload_sessions where id = ${session.id}`;
    const open = state?.open ?? true;
    if (waiting.length === 0) {
      if (!open) await finishSession(session);
      return { nextCheckMs: null };
    }
    // One run once every file is in: a 'single' session and an extract (which owns exactly one run), as before waves.
    const singleRun = sessionProtocol(session) === "single" || Boolean(session.extract_id);
    if (singleRun && open) {
      if (flush && !options.expiry) throw new ProjectIntakeError("Upload session still has incomplete files", 409);
      return { nextCheckMs: null };
    }
    const delayMs = Number(state?.delay_ms ?? 0);
    const trigger = !open ? "last" : options.expiry ? "expiry" : flush ? "flush"
      : waiting.length >= directUploadWaveThreshold(Number(state?.waves ?? 0)) ? "count" : delayMs <= 0 ? "delay" : null;
    if (!trigger) return { nextCheckMs: delayMs };
    const blockedMs = Number(state?.blocked_ms ?? 0);
    if (blockedMs > 0 && !flush) return { nextCheckMs: blockedMs };
    try {
      await startWave(session, waiting, options, trigger);
    } catch (error) {
      // A flush that billing refused still answers with the runs already started (and says why the rest waits).
      if (flush && isRunCreationBlockedError(error)) return { nextCheckMs: WAVE_BLOCKED_RETRY_SECONDS * 1000, refusal: error };
      throw error;
    }
    flush = false;
  }
  return { nextCheckMs: 0 };
}

async function startWave(session: UploadSessionRow, waiting: WaitingFile[], options: AdvanceOptions, trigger: string): Promise<void> {
  const protocol = sessionProtocol(session);
  const [last] = await sql<Array<{ wave: number | null; attempts: number; committed: number }>>`
    select max(wave) as wave, count(*)::int as attempts, count(*) filter (where status = 'committed')::int as committed
    from upload_session_runs where session_id = ${session.id}`;
  const wave = Number(last?.wave ?? 0) + 1;
  const earlierRuns = Number(last?.committed ?? 0) > 0;
  // The first attempt's run id is the session id (as before waves; a server from before waves confirming the same session
  // would collide on it). Any other attempt gets a fresh id: a failed wave's id is a tombstone and never commits.
  const runId = Number(last?.attempts ?? 0) === 0 ? session.id : randomUUID();

  // Billable admission per wave: the principal's rights as they are now (the user may still contribute; a key-opened
  // session needs a live server key of its organization with `ingest` and an allowlist that still admits the target),
  // never as stored when the session was opened.
  let admission: { allowedProjectIds: string[] | null };
  try {
    admission = await liveDirectUploadAdmission(session, session.user_id);
  } catch (error) {
    // Fail closed: a revoked share, membership or key stops every further wave (runs already started are left alone).
    // A client's confirm is only refused (403); the reconciler's next pass closes the session.
    if (options.background && error instanceof ProjectIntakeError && [403, 404].includes(error.statusCode)) {
      await failSession(session.id, "Upload rejected: the uploader or API key may no longer add to this project");
    }
    uploadEvent("wave", { outcome: "refused", protocol, trigger, error_class: errorClass(error) });
    throw error;
  }
  const extract = session.extract_id ? await loadIntakeExtract(session.extract_id, session.user_id) : null;
  if (session.extract_id && !extract) throw new ProjectIntakeError("This extract expired before its files were confirmed.", 409);
  const pipeline = session.pipeline ? sanitizeStoredPipeline(session.pipeline, `upload session ${session.id}`) : undefined;
  // Re-checked per wave: a session opened before the deployment stopped offering a tier is refused with the same code.
  assertIntakeChartExportTier((pipeline as { chartExport?: { tier?: ChartExportTier } } | undefined)?.chartExport?.tier, `upload session ${session.id}`);

  // The wave row first ('pending'), then its files, each taken only while untaken (the database admits a file only into a
  // pending wave of its session). A 'waves' session's files are 'finalized' (a 'completed' one was finalized by a server
  // from before waves during a deploy), so no older server ever confirms them. The session is 'ingesting' from here:
  // older servers neither abort it nor let its expiry delete these files.
  await sql`insert into upload_session_runs (session_id, wave, run_id, status, file_count) values (${session.id}, ${wave}, ${runId}, 'pending', 0)`;
  const taken = await sql<Array<{ id: string }>>`
    update upload_session_files set run_id = ${runId}, status = case when ${protocol} = 'waves' then 'finalized' else status end, updated_at = now()
    where session_id = ${session.id} and id = any(${sql.array(waiting.map(file => file.id))}) and status in ('completed', 'finalized') and run_id is null
    returning id`;
  const takenIds = new Set(taken.map(row => row.id));
  const files = waiting.filter(file => takenIds.has(file.id));
  if (files.length === 0) {
    await failWave(session.id, wave);
    return;
  }
  await sql`update upload_session_runs set file_count = ${files.length} where session_id = ${session.id} and wave = ${wave}`;
  await sql`update upload_sessions set status = 'ingesting', updated_at = now() where id = ${session.id} and status in ('pending', 'uploading')`;

  // A run already under this id (only the session id: a server from before waves confirmed this session): its
  // publication committed this wave (the database trigger), or it is discarded before we create ours.
  const [leftover] = await sql<Array<{ ready: boolean }>>`select creation_ready_at is not null as ready from project_runs where id = ${runId}`;
  if (leftover && (leftover.ready || !await discardUnstartedRun(runId))) {
    await adoptCommittedWave(session, wave, runId, options.ports, files.length, protocol, trigger);
    return;
  }

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
  // A 'single' session's one run reports the whole upload, as before waves: files refused before it are listed too.
  if (protocol === "single") {
    const failed = await sql<Array<{ filename: string; mime_type: string; size_bytes: number | string; finalize_error: StoredFinalizeError | null }>>`
      select filename, mime_type, size_bytes, finalize_error from upload_session_files where session_id = ${session.id} and status = 'failed'
      order by request_index asc nulls last, created_at asc`;
    for (const file of failed) {
      items.push({ filename: file.filename, mimeType: file.mime_type, sizeBytes: Number(file.size_bytes), canonicalId: null, path: "",
        content: { rejected: storedFinalizeFailure({ filename: file.filename }, file.finalize_error) } });
    }
  }

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
      allowedProjectIds: admission.allowedProjectIds,
      runId,
      kind: "direct-upload",
      items,
      audit: options.audit ? { ...options.audit, metadata: { ...options.audit.metadata, wave } } : undefined,
      ...(extract ? { extract } : {}),
    }, intakePorts);
    result = actionResult(intake);
  } catch (error) {
    await settleFailedWave(session, wave, runId, files, error, options, protocol, trigger);
    return;
  }
  // The run's publication normally committed the wave already (trigger); intake ports that publish no run row (tests)
  // commit it here. A wave fenced meanwhile (its run was refused at publish) never reaches this point.
  const committed = await sql<Array<{ wave: number }>>`
    update upload_session_runs set status = 'committed', started_at = coalesce(started_at, now()), result = ${sql.json(JSON.parse(JSON.stringify(result)))}
    where session_id = ${session.id} and wave = ${wave} and status in ('pending', 'committed') returning wave`;
  if (committed.length !== 1) throw new Error(`upload wave ${wave} of session ${session.id} was fenced after its intake returned`);
  await sql`update upload_sessions set project_id = coalesce(project_id, ${result.payload.project.id}), org_id = coalesce(org_id, ${result.payload.project.orgId ?? null}),
      last_error = null, wave_blocked_until = null, updated_at = now()
    where id = ${session.id}`;
  waveCommitted(session.id, wave, runId, files.length, protocol, trigger, "committed");
}

function waveCommitted(sessionId: string, wave: number, runId: string, files: number, protocol: string, trigger: string, outcome: "committed" | "adopted"): void {
  recordWaveFiles(files, { protocol, trigger });
  uploadEvent("wave", { outcome, protocol, trigger }, { body: `upload session ${sessionId} wave ${wave} ${outcome}: run ${runId}, ${files} files`,
    attributes: { "docslurp.upload.session_id": sessionId, "docslurp.runId": runId, "docslurp.upload.wave": wave, "docslurp.upload.files": files } });
}

/**
 * The intake for a wave threw. Its run may still have committed (an error after publication): then the run is adopted
 * and its files stay in it. Otherwise the wave is failed (its run id becomes a tombstone that can never publish) and its
 * files wait for the next wave; a wave another holder fenced meanwhile is left to that holder.
 */
async function settleFailedWave(session: UploadSessionRow, wave: number, runId: string, files: WaitingFile[], error: unknown, options: AdvanceOptions, protocol: string, trigger: string): Promise<void> {
  const [run] = await sql<Array<{ ready: boolean }>>`select creation_ready_at is not null as ready from project_runs where id = ${runId}`;
  // A half-created run is discarded first; a run that published meanwhile cannot be (discardUnstartedRun locks it).
  const runCommitted = Boolean(run) && (run!.ready || !await discardUnstartedRun(runId));
  const fenced = runCommitted ? [] : await sql<Array<{ wave: number }>>`
    update upload_session_runs set status = 'failed' where session_id = ${session.id} and wave = ${wave} and status = 'pending' returning wave`;
  if (fenced.length === 0) {
    const [row] = await sql<Array<{ status: string }>>`select status from upload_session_runs where session_id = ${session.id} and wave = ${wave}`;
    if (row?.status === "committed") {
      console.error(`[upload-waves] session=${session.id} wave=${wave} run=${runId} committed before its intake failed; adopted error_class=${errorClass(error)}`);
      await adoptCommittedWave(session, wave, runId, options.ports, files.length, protocol, trigger);
      return;
    }
    // Fenced by another holder (it frees the files): nothing more is ours to do.
    uploadEvent("wave", { outcome: "fenced", protocol, trigger }, { severity: "warn", body: `upload session ${session.id} wave ${wave} was fenced by another holder`,
      attributes: { "docslurp.upload.session_id": session.id, "docslurp.runId": runId } });
    throw error;
  }
  await freeFailedWaveFiles(session.id);
  // With no run yet, the session is no longer being ingested (older servers may abort or expire it again).
  await sql`update upload_sessions set status = 'pending', updated_at = now() where id = ${session.id} and status = 'ingesting'
    and not exists (select 1 from upload_session_runs where session_id = ${session.id} and status = 'committed')`;
  const handled = await handleWaveRefusal(session, files, error);
  uploadEvent("wave", { outcome: handled ? "rejected" : isRunCreationBlockedError(error) ? "refused" : "failed", protocol, trigger, error_class: errorClass(error) },
    { severity: handled || isRunCreationBlockedError(error) ? "warn" : "error", body: `upload session ${session.id} wave ${wave} did not start`,
      attributes: { "docslurp.upload.session_id": session.id, "docslurp.upload.files": files.length } });
  if (!handled) throw error;
}

async function failWave(sessionId: string, wave: number): Promise<void> {
  await sql`update upload_session_runs set status = 'failed' where session_id = ${sessionId} and wave = ${wave} and status = 'pending'`;
  await freeFailedWaveFiles(sessionId);
}

/**
 * A wave whose run committed although its intake did not return a response: the run and its files stand. The session's
 * response for it is rebuilt from the database (the run, its documents, the project), so `result` and `runs[]` stay
 * complete.
 */
async function adoptCommittedWave(session: UploadSessionRow, wave: number, runId: string, ports: ProjectIntakePorts, files: number, protocol: string, trigger: string): Promise<void> {
  const result = await rebuiltWaveResult(session, runId);
  await sql`update upload_session_runs set status = 'committed', started_at = coalesce(started_at, now()), result = coalesce(result, ${sql.json(JSON.parse(JSON.stringify(result)))})
    where session_id = ${session.id} and wave = ${wave} and status in ('pending', 'committed')`;
  await sql`update upload_sessions set project_id = coalesce(project_id, ${result.payload.project.id}), org_id = coalesce(org_id, ${result.payload.project.orgId ?? null}),
      updated_at = now() where id = ${session.id}`;
  void ports;
  waveCommitted(session.id, wave, runId, files, protocol, trigger, "adopted");
}

async function rebuiltWaveResult(session: UploadSessionRow, runId: string): Promise<ProjectIntakeActionResult> {
  const [run] = await sql<ProjectRunRow[]>`select * from project_runs where id = ${runId}`;
  const documents = await sql<DocumentRow[]>`select * from documents where run_id = ${runId} order by created_at`;
  const projectId = (run as { project_id?: string } | undefined)?.project_id ?? session.project_id ?? "";
  const project = await getProject(projectId, session.user_id).catch(() => null) ?? { id: projectId, orgId: session.org_id };
  let mappedRun: unknown;
  try { mappedRun = run ? mapProjectRun(run) : { id: runId }; } catch { mappedRun = { id: runId, projectId }; }
  let mappedDocuments: unknown[];
  try { mappedDocuments = documents.map(row => mapDocument(row)); } catch { mappedDocuments = []; }
  return {
    status: 201,
    temporalDeferred: false,
    payload: { project, run: mappedRun, documents: mappedDocuments, warnings: [] } as unknown as ProjectIntakeActionResult["payload"],
  };
}

/**
 * Classifies a refused wave (already failed, its files waiting again). True: handled, the session carries on.
 * - billing or admission (402): the files wait, retried after a pause or at once by a confirm;
 * - every file of the wave rejected for its own reason: those files fail, the session carries on;
 * - a definite refusal of the session itself (access revoked, project gone): the session ends (runs already started
 *   stay, and with any the session ends confirmed);
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
        where id = ${file.id} and status in ('completed', 'finalized') and run_id is null`;
    }
    return true;
  }
  if (error instanceof ProjectIntakeError && [400, 401, 403, 404, 413, 415, 422].includes(error.statusCode)) {
    await failSession(session.id, "Upload rejected: stored bytes or intake policy validation failed");
  }
  return false;
}

/** Stops the session: no further runs. Runs already started keep running, and with any the session ends confirmed. */
async function failSession(sessionId: string, message: string): Promise<void> {
  await closeDirectUploadSession(sessionId, "failed", message);
}

/** Every file is in a run or failed: the session is confirmed (its `result` is the first run), or failed with no run. */
async function finishSession(session: UploadSessionRow): Promise<void> {
  const [first] = await sql<Array<{ result: unknown }>>`
    select result from upload_session_runs where session_id = ${session.id} and status = 'committed' order by wave limit 1`;
  if (!first) {
    await failSession(session.id, "Upload rejected: no file of this upload could be ingested");
    return;
  }
  await sql`update upload_sessions set status = 'confirmed', result = ${first.result === null ? null : sql.json(JSON.parse(JSON.stringify(first.result)))},
      last_error = null, client_finalizing_until = null, updated_at = now()
    where id = ${session.id} and status in ('pending', 'uploading', 'ingesting')`;
  uploadEvent("session_closed", { outcome: "confirmed" });
}

export type DirectUploadConfirmPayload = ProjectIntakePayload & {
  /** Every run this upload started, in order; `run` above is the first. */
  runs: DirectUploadRunSummary[];
  /** The session's status after this call: `confirmed` once every file is in a run. */
  sessionStatus: string;
  /** Files still uploading; each starts a later run as it arrives. */
  pendingFileCount: number;
  /** Files whose stored bytes were refused (final), and files no run took because the session ended first. */
  failedFileCount: number;
  abortedFileCount: number;
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
      refusal = (await advanceLocked(session.id, args.userId, { flush: true, background: false, audit: args.audit, ports })).refusal;
    }
    const [first] = await sql<Array<{ result: ProjectIntakeActionResult | null }>>`
      select result from upload_session_runs where session_id = ${session.id} and status = 'committed' order by wave limit 1`;
    if (!first) {
      if (refusal) throw refusal;
      const [now] = await sql<Array<{ status: string }>>`select status from upload_sessions where id = ${session.id}`;
      if (now && ["failed", "aborted"].includes(now.status)) throw new ProjectIntakeError("Upload session is closed", 409);
      throw new ProjectIntakeError("Upload session still has incomplete files", 409);
    }
    if (!first.result) throw new ProjectIntakeError("Committed intake response requires reconciliation", 409, undefined, "intake_reconciliation_required");
    await authorizeReceiptProject(first.result.payload.project.id, args.userId, session.org_id, session.api_key_id);
    const runs = await listDirectUploadRuns(session.id);
    const [state] = await sql<Array<{ status: string; pending: number; failed: number; aborted: number }>>`
      select status,
        (select count(*)::int from upload_session_files where session_id = ${session.id} and status = 'pending') as pending,
        (select count(*)::int from upload_session_files where session_id = ${session.id} and status = 'failed') as failed,
        (select count(*)::int from upload_session_files where session_id = ${session.id} and status = 'aborted') as aborted
      from upload_sessions where id = ${session.id}`;
    const warnings = [...first.result.payload.warnings];
    if (refusal instanceof Error) warnings.push(`Further files are waiting to start: ${refusal.message}`);
    return {
      ...first.result,
      payload: { ...first.result.payload, warnings, runs, sessionStatus: state?.status ?? session.status, pendingFileCount: Number(state?.pending ?? 0),
        failedFileCount: Number(state?.failed ?? 0), abortedFileCount: Number(state?.aborted ?? 0) },
    };
  }, undefined, undefined, args.lockWaitMs ?? 0);
}
