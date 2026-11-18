import { createHash, randomUUID } from "node:crypto";

import type { RunOrigin } from "@docslurp/shared";
import type { PipelineFeatureOverrides, ProjectTemplateKey } from "@docslurp/shared";

import { sql } from "../db.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { env } from "../config.js";
import { DirectUploadLockUnavailable, reserveDirectUploadLockConnection, type DirectUploadLockClass } from "../lib/direct-upload-locks.js";
import { NOT_STARTED, settleBounded } from "../lib/bounded-settle.js";
import { isTransientStorageError, withStorageRetry } from "../lib/storage-retry.js";
import { MAX_DIRECT_UPLOAD_COMPLETE_BATCH } from "../lib/direct-upload-limits.js";
import { normalizeUploadPath } from "../lib/canonical-id.js";
import { requestDirectUploadWaveCheck } from "./direct-upload-wave-scheduler.js";
import { errorClass, recordLockWait, uploadEvent } from "../lib/upload-telemetry.js";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  copyUploadedObject,
  deleteUploadedObject,
  createMultipartUpload,
  getUploadedObjectMetadata,
  listMultipartUploadParts,
  signMultipartUploadPart,
  signSingleUploadPut,
} from "../lib/storage.js";
import {
  admitIntakeFile,
  allRejectedError,
  rawSourceKey,
  rejectionCode,
  ProjectIntakeError,
  type IntakeExtract,
  type RejectedIntakeFile,
  type ProjectIntakeErrorCode,
  type ProjectIntakeItem,
} from "./project-intake.js";

const SIGNED_UPLOAD_TTL_SECONDS = 900;
const MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;
const MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;

export interface DirectUploadSessionFileInput {
  /** The client's own id for this file; echoed on the session's file and on a rejection so clients never match by filename. */
  clientId?: string;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  sha256?: string;
  /** Client-claimed identity for re-selection, not a storage-verified checksum. */
  identity?: { algorithm: "sha256"; digest: string };
  canonicalId?: string | null;
  /** Request one signed PUT instead of multipart (maximum 5 GiB). */
  singlePart?: boolean;
  path?: string;
}

export interface CreateDirectUploadSessionInput {
  apiKeyId?: string | null;
  /** Where the run will come from, derived from the authenticated principal at session creation. Unset: machine. */
  origin?: RunOrigin;
  allowedProjectIds?: readonly string[] | null;
  tags?: string[];
  userId: string;
  orgId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  templateKey?: ProjectTemplateKey | null;
  /** Upload overrides, merged onto the target project pipeline at confirm. */
  pipeline: PipelineFeatureOverrides;
  files: DirectUploadSessionFileInput[];
  /** Extract mode: sources are stored under the extract's prefix and confirm creates the extract's run. */
  extract?: IntakeExtract | null;
}

export interface CompleteDirectUploadFileEntry {
  fileId: string;
  etag?: string;
  /** Final byte count; required to finalize an unknown-size (streamed) file. */
  sizeBytes?: number;
  /** Accepted for clients that send it; storage's own part list is authoritative. */
  parts?: Array<{ partNumber: number; etag: string }>;
}

export interface CompleteDirectUploadFileInput extends CompleteDirectUploadFileEntry {
  sessionId: string;
  userId: string;
}

export type UploadSessionRow = {
  expires_at?: Date | string;
  result?: unknown;
  last_error?: string | null;
  api_key_id?: string | null;
  origin?: RunOrigin | null;
  allowed_project_ids?: string[] | null;
  tags?: string[];
  extract_id?: string | null;
  id: string;
  user_id: string;
  org_id: string | null;
  project_id: string | null;
  project_name: string | null;
  template_key: string | null;
  pipeline: PipelineFeatureOverrides | null;
  status: string;
  /** Fixed at creation: 'single' (one run once every file is in) or 'waves' (runs while uploading). */
  finalize_protocol?: "single" | "waves" | null;
};

export type UploadSessionFileRow = {
  id: string;
  session_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  unknown_size?: boolean;
  source_key: string;
  upload_mode: string;
  upload_id: string | null;
  part_size: number | null;
  status: string;
  completed_parts: Array<{ partNumber: number; etag: string }> | null;
  canonical_id?: string | null;
  source_path?: string | null;
  /** Position of the file in the create request. */
  request_index?: number | null;
  client_id?: string | null;
  content_identity?: { algorithm: "sha256"; digest: string } | null;
  /** The run (wave) that took this file; null while it waits for one. */
  run_id?: string | null;
  /** A definite rejection found in the background (webhook or fallback reconciler); the file is `failed`. */
  finalize_error?: StoredFinalizeError | null;
};

/** Client-safe: only ProjectIntakeError fields, which the API already answers to the uploader. */
export type StoredFinalizeError = { statusCode: number; code: string; message: string };

export interface LoadedDirectUploadSession {
  session: UploadSessionRow;
  files: UploadSessionFileRow[];
}

export interface PreparedDirectUploadProjectIntake {
  session: UploadSessionRow;
  items: ProjectIntakeItem[];
}

export function toDirectUploadPartCount(
  sizeBytes: number,
  partSize: number,
): number {
  return Math.max(1, Math.ceil(sizeBytes / partSize));
}

/**
 * A file whose bytes are verified and sealed: 'completed' in a 'single' session, 'finalized' in a 'waves' session.
 * Servers from before waves confirm a session only when every file is 'completed', so they never confirm (and so never
 * re-ingest) a waves session during a rolling deploy or after a rollback.
 */
export const FINALIZED_FILE_STATUSES = ["completed", "finalized"] as const;
export function isFinalizedFileStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "finalized";
}

/** Clients see one finalized status: 'completed'. */
export function publicFileStatus(status: string): string {
  return status === "finalized" ? "completed" : status;
}

/** The protocol a session was created with (rows from before waves are 'single'). */
export function sessionProtocol(session: Pick<UploadSessionRow, "finalize_protocol">): "single" | "waves" {
  return session.finalize_protocol === "waves" ? "waves" : "single";
}

/** The session row alone, scoped to its user: what authorization and session-level checks need, at O(1) in session size. */
export async function loadDirectUploadSessionRow(
  sessionId: string,
  userId: string,
): Promise<UploadSessionRow | null> {
  const [session] = await sql<UploadSessionRow[]>`
    select expires_at, id, user_id, org_id, project_id, project_name, template_key, pipeline, tags, status, result, last_error, api_key_id, origin, allowed_project_ids, extract_id, finalize_protocol
    from upload_sessions
    where id = ${sessionId} and user_id = ${userId}
    limit 1
  `;
  return session ?? null;
}

/**
 * A session's file rows: every file, or only `fileIds` (looked up by primary key within this session, so a file of
 * another session never matches). Callers must have loaded the session row with its user scope first.
 */
async function loadDirectUploadSessionFiles(sessionId: string, fileIds?: readonly string[]): Promise<UploadSessionFileRow[]> {
  const rows = fileIds
    ? await sql<RawFileRow[]>`
      select id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status,
        completed_parts, canonical_id, source_path, unknown_size, request_index, client_id, content_identity, run_id, finalize_error
      from upload_session_files
      where session_id = ${sessionId} and id = any(${sql.array([...fileIds])})
      order by request_index asc nulls last, created_at asc`
    : await sql<RawFileRow[]>`
      select id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status,
        completed_parts, canonical_id, source_path, unknown_size, request_index, client_id, content_identity, run_id, finalize_error
      from upload_session_files
      where session_id = ${sessionId}
      order by request_index asc nulls last, created_at asc`;

  return rows.map(normalizeFileRow);
}

type RawFileRow = Omit<UploadSessionFileRow, "size_bytes" | "part_size"> & { size_bytes: number | string; part_size: number | string | null };

// PostgreSQL bigint columns arrive as strings; browser file matching and
// storage size verification require numbers on both sides of the comparison.
function normalizeFileRow(file: RawFileRow): UploadSessionFileRow {
  return { ...file, size_bytes: Number(file.size_bytes), part_size: file.part_size === null ? null : Number(file.part_size) };
}

export async function loadDirectUploadSession(
  sessionId: string,
  userId: string,
): Promise<LoadedDirectUploadSession | null> {
  const session = await loadDirectUploadSessionRow(sessionId, userId);
  if (!session) return null;
  return { session, files: await loadDirectUploadSessionFiles(sessionId) };
}

/** How a client matches a session file to the file it sent: its position in the request and its own id. */
function fileRef(file: UploadSessionFileRow) {
  return { identity: file.content_identity ?? null, index: file.request_index ?? null, clientId: file.client_id ?? null };
}

async function storedPartsAtExpectedSize(file: UploadSessionFileRow, partSize: number, partCount: number): Promise<Array<{ partNumber: number; etag: string }>> {
  if (file.status !== "pending" || !file.upload_id) return [];
  let parts: Awaited<ReturnType<typeof listMultipartUploadParts>>;
  const uploadId = file.upload_id;
  try { parts = await withStorageRetry(() => listMultipartUploadParts({ key: file.source_key, uploadId })); }
  catch (error) {
    if (storageErrorName(error) === "NoSuchUpload") throw new ProjectIntakeError("Upload transfer no longer exists; reconciliation is required", 409, undefined, "intake_reconciliation_required");
    throw error;
  }
  return parts.filter((part) => part.partNumber <= partCount
    && part.sizeBytes === Math.min(partSize, file.size_bytes - (part.partNumber - 1) * partSize));
}

export async function buildDirectUploadFileDescriptor(file: UploadSessionFileRow, ttl = SIGNED_UPLOAD_TTL_SECONDS, expiresAt?: Date | string) {
  const remainingTtl = () => expiresAt ? assertUploadSessionActive({ status: "pending", expires_at: expiresAt } as UploadSessionRow) : ttl;
  if (isFinalizedFileStatus(file.status) || file.status === "aborted") return { transferState: isFinalizedFileStatus(file.status) ? "complete" as const : "unavailable" as const, verifiedBytes: isFinalizedFileStatus(file.status) ? file.size_bytes : null, ...fileRef(file), id: file.id, filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes, mode: file.upload_mode as "single" | "multipart", status: publicFileStatus(file.status) };
  if (file.upload_mode === "single") {
    return {
      ...fileRef(file),
      id: file.id,
      filename: file.filename,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      transferState: "missing" as const,
      verifiedBytes: 0,
      mode: "single" as const,
      status: file.status,
      method: "PUT" as const,
      headers: { "Content-Type": file.mime_type },
      expiresInSeconds: remainingTtl(),
      putUrl: await signSingleUploadPut({
        key: file.source_key,
        contentType: file.mime_type,
        expiresInSeconds: remainingTtl(),
      }),
    };
  }

  const partSize = file.part_size ?? MULTIPART_PART_SIZE_BYTES;
  const partCount = file.unknown_size ? 0 : toDirectUploadPartCount(file.size_bytes, partSize);
  if (!file.upload_id) {
    throw new Error(`Multipart session missing upload id for ${file.id}`);
  }
  // Storage is authoritative for which parts arrived: a client that lost a connection resumes from these pendingParts
  // instead of re-sending the whole file. A part counts only at its exact expected size.
  const stored = file.unknown_size ? [] : await storedPartsAtExpectedSize(file, partSize, partCount);
  const completed = new Set(stored.map((part) => part.partNumber));
  const pendingParts: Array<{
    partNumber: number;
    sizeBytes: number;
    url: string;
  }> = [];

  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    if (completed.has(partNumber)) {
      continue;
    }
    const offset = (partNumber - 1) * partSize;
    const remaining = Math.max(0, file.size_bytes - offset);
    const sizeBytes = Math.min(partSize, remaining);
    pendingParts.push({
      partNumber,
      sizeBytes,
      url: await signMultipartUploadPart({
        key: file.source_key,
        uploadId: file.upload_id,
        partNumber,
        expiresInSeconds: remainingTtl(),
      }),
    });
  }

  return {
    ...fileRef(file),
    id: file.id,
    filename: file.filename,
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    mode: "multipart" as const,
    status: file.status,
    uploadId: file.upload_id,
    partSize,
    partCount,
    unknownSize: Boolean(file.unknown_size),
    pendingParts,
    completedParts: stored,
    transferState: file.unknown_size || stored.length ? "incomplete" as const : "missing" as const,
    verifiedBytes: file.unknown_size ? null : stored.reduce((sum, part) => sum + Math.min(partSize, file.size_bytes - (part.partNumber - 1) * partSize), 0),
  };
}

export async function createDirectUploadSession(input: CreateDirectUploadSessionInput) {
  // Project Intake's policy screens each declared file before any upload target exists. One bad file never fails the
  // request: the good files get a session and the rest come back as per-file rejections keyed by request index. Only a
  // request in which nothing is acceptable fails, with every rejection named.
  const rejected: RejectedIntakeFile[] = [];
  const files: Array<DirectUploadSessionFileInput & { index: number; unknownSize: boolean; sizeBytes: number; filename: string; mimeType: string }> = [];
  input.files.forEach((file, index) => {
    try {
      if (file.singlePart && (file.sizeBytes === undefined || file.sizeBytes > 5 * 1024 ** 3)) {
        throw new ProjectIntakeError("Single-part uploads cannot exceed 5 GiB", 413);
      }
      files.push({
        ...file,
        index,
        unknownSize: file.sizeBytes === undefined,
        sizeBytes: file.sizeBytes ?? 0,
        ...admitIntakeFile(
          { filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes ?? 0 },
          "direct-upload",
        ),
      });
    } catch (error) {
      if (!(error instanceof ProjectIntakeError)) throw error;
      rejected.push({
        index,
        ...(file.clientId ? { clientId: file.clientId } : {}),
        filename: sanitizeUploadFilename(file.filename),
        statusCode: error.statusCode,
        code: rejectionCode(error),
        message: error.message,
      });
    }
  });
  if (files.length === 0) throw allRejectedError(rejected);

  const sessionId = randomUUID();
  await sql`
    insert into upload_sessions (
      id,
      user_id,
      org_id,
      project_id,
      project_name,
      template_key,
      pipeline,
      tags,
      api_key_id,
      origin,
      allowed_project_ids,
      extract_id,
      finalize_protocol,
      status
    )
    values (
      ${sessionId},
      ${input.userId},
      ${input.orgId ?? null},
      ${input.projectId ?? null},
      ${input.projectName ?? null},
      ${input.templateKey ?? null},
      ${sql.json(JSON.parse(JSON.stringify(input.pipeline)))},
      ${sql.array(input.tags ?? [])},
      ${input.apiKeyId ?? null},
      ${input.origin ?? "machine"},
      ${input.allowedProjectIds ? sql.array([...input.allowedProjectIds]) : null},
      ${input.extract?.id ?? null},
      -- Recorded once: turning DOCSLURP_UPLOAD_WAVES off later (a kill switch) never changes a session in flight. An
      -- extract always takes its one run.
      ${env.directUploadWaves && !input.extract ? "waves" : "single"},
      'initializing'
    )
  `;

  for (const file of files) {
    const sourceKey = rawSourceKey(input.userId, file.filename, input.extract);
    const isMultipart = file.unknownSize || (!file.singlePart && file.sizeBytes >= MULTIPART_THRESHOLD_BYTES);
    const partSize = isMultipart ? MULTIPART_PART_SIZE_BYTES : null;
    const uploadId = isMultipart
      ? await createMultipartUpload(sourceKey, file.mimeType)
      : null;
    const fileId = randomUUID();

    await sql`
      insert into upload_session_files (
        id,
        session_id,
        filename,
        mime_type,
        size_bytes,
        source_key,
        upload_mode,
        upload_id,
        part_size,
        status,
        sha256,
        canonical_id,
        source_path,
        unknown_size,
        request_index,
        client_id,
        content_identity,
        next_check_at
      )
      values (
        ${fileId},
        ${sessionId},
        ${file.filename},
        ${file.mimeType},
        ${file.sizeBytes},
        ${sourceKey},
        ${isMultipart ? "multipart" : "single"},
        ${uploadId},
        ${partSize},
        'pending',
        ${file.sha256 ?? null},
        ${file.canonicalId ?? null},
        ${normalizeUploadPath(file.path)},
        ${file.unknownSize},
        ${file.index},
        ${file.clientId ?? null},
        ${file.identity ? sql.json(file.identity) : null},
        now() + ${env.directUploadFinalizeGraceSeconds}::int * interval '1 second'
      )
    `;
  }

  await sql`update upload_sessions set status = 'pending', next_reconcile_at = now() where id = ${sessionId}`;
  const loaded = await loadDirectUploadSession(sessionId, input.userId);
  if (!loaded) {
    throw new ProjectIntakeError("Upload session not found", 404);
  }
  return { ...(await describeDirectUploadSession(loaded)), ...(rejected.length > 0 ? { rejected } : {}) };
}

export async function describeDirectUploadSession(
  loaded: LoadedDirectUploadSession,
  statusOnly = false,
) {
  const ttl = statusOnly || ["confirmed", "failed", "aborted", "expired"].includes(loaded.session.status) ? SIGNED_UPLOAD_TTL_SECONDS : assertUploadSessionActive(loaded.session);
  const files = await Promise.all(
    loaded.files.map(async (file) => statusOnly || ["confirmed", "failed", "aborted"].includes(loaded.session.status) || file.status === "failed"
      ? { ...fileRef(file), id: file.id, filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes, mode: file.upload_mode as "single" | "multipart", status: publicFileStatus(file.status), ...fileOutcome(file) }
      : { ...await buildDirectUploadFileDescriptor(file, ttl, loaded.session.expires_at), ...fileOutcome(file) }),
  );
  const runs = await listDirectUploadRuns(loaded.session.id);
  return {
    expiresAt: loaded.session.expires_at ? new Date(loaded.session.expires_at).toISOString() : null,
    sessionId: loaded.session.id,
    status: loaded.session.status,
    /** 'single': one run once every file is in; 'waves': runs while the upload is in progress. */
    protocol: sessionProtocol(loaded.session),
    /** The first run's intake response, once every file is in a run (or failed); kept for clients that read one run. */
    result: (loaded.session.result as { payload?: unknown } | null)?.payload ?? null,
    error: loaded.session.last_error ?? null,
    /** The project the session's runs went to (set by its first run). */
    projectId: runs.length > 0 ? loaded.session.project_id : null,
    /** Every run this upload started, in order ('single' sessions: at most one). */
    runs,
    // A `confirmed` session with failed or aborted files partly succeeded: its runs hold every other file. Never ask
    // the user to upload the session again; only these files were not ingested.
    /** Files whose stored bytes were refused (final). */
    failedFileCount: loaded.files.filter(file => file.status === "failed").length,
    /** Files no run took because the session was aborted, expired or refused before they joined one. */
    abortedFileCount: loaded.files.filter(file => file.status === "aborted").length,
    files,
  };
}

/** A file's run, or its definite rejection: only what the uploader may see. */
function fileOutcome(file: UploadSessionFileRow): { runId?: string; error?: DirectUploadFileError } {
  return {
    ...(file.run_id ? { runId: file.run_id } : {}),
    // The same per-file shape a batched files/complete answers: a failed file is final.
    ...(file.status === "failed" ? { error: describeFileFailure(storedFinalizeFailure(file, file.finalize_error ?? null)) } : {}),
  };
}

export type DirectUploadRunSummary = {
  runId: string;
  /** 1 for the first run of the upload, 2 for the next, ... */
  wave: number;
  /** `starting` while the run is being created; `started` once it exists (its own status is on the run). */
  status: "starting" | "started";
  fileCount: number;
  documentCount: number | null;
  createdAt: string;
};

/**
 * The runs a session has started (or is starting), in order and numbered from 1. A wave that failed never had a run
 * (its row is a tombstone that keeps its run id from ever committing) and is not listed.
 */
export async function listDirectUploadRuns(sessionId: string): Promise<DirectUploadRunSummary[]> {
  const rows = await sql<Array<{ run_id: string; wave: number; status: string; file_count: number; documents: number | null; created_at: Date | string }>>`
    select run_id, wave, status, file_count, jsonb_array_length(result -> 'payload' -> 'documents') as documents, created_at
    from upload_session_runs where session_id = ${sessionId} and status <> 'failed' order by wave`;
  return rows.map((row, index) => ({
    runId: row.run_id,
    wave: index + 1,
    status: row.status === "committed" ? "started" as const : "starting" as const,
    fileCount: Number(row.file_count),
    documentCount: row.documents === null || row.documents === undefined ? null : Number(row.documents),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

/** A native key may only operate on sessions created in its organization. */
export async function directUploadSessionBelongsToOrganization(sessionId: string, userId: string, orgId: string, allowedProjectIds?: readonly string[] | null, apiKeyId?: string): Promise<boolean> {
  const session = await loadDirectUploadSessionRow(sessionId, userId);
  return Boolean(apiKeyId) && session?.org_id === orgId && session.api_key_id === apiKeyId && (!allowedProjectIds?.length || Boolean(session.project_id && allowedProjectIds.includes(session.project_id)));
}

export async function getDirectUploadSessionDescription(
  sessionId: string,
  userId: string,
  statusOnly = false,
  signal?: AbortSignal,
) {
  if (statusOnly) {
    const loaded = await loadDirectUploadSession(sessionId, userId);
    return loaded ? describeDirectUploadSession(loaded, true) : null;
  }
  // No session lock: each file is finalized under its own lease, so a recovery read runs beside webhooks, client
  // completes and waves instead of waiting for them.
  let loaded = await loadDirectUploadSession(sessionId, userId);
  if (!loaded) return null;
  if (loaded.session.status === "confirmed") return describeDirectUploadSession(loaded, true);
  assertUploadSessionActive(loaded.session);
  const { assertSessionProjectStillContributable } = await import("./direct-session-idempotency.js");
  await assertSessionProjectStillContributable(loaded.session, userId);
  // Inspect all final objects before authorizing any retry. An outage is not absence.
  try {
    const open = loaded.files.filter(file => file.status === "pending" && !file.unknown_size);
    let finalized = 0;
    // Bounded like a lock hold: new files start only within the budget, and a disconnecting client cancels the rest.
    const budget = lockHoldBudget(signal);
    const inspected = await settleBounded(open, env.directUploadFinalizeConcurrency, async file => {
      let exists = false;
      try { await withStorageRetry(() => getUploadedObjectMetadata(file.source_key, budget.signal), undefined, budget.signal); exists = true; }
      catch (error) { if (!isStorageNotFound(error)) throw error; }
      if (!exists) return;
      try { if (await finalizeLeasedDirectUploadFile(file, { signal: budget.signal, path: "recovery" })) finalized += 1; }
      catch (error) {
        // Another finalizer (a webhook, the client, the reconciler) holds this file: it will settle it.
        if (!(error instanceof ProjectIntakeError && error.code === "upload_session_busy")) throw error;
      }
    }, { shouldStart: budget.shouldStart });
    if (finalized > 0) await scheduleDirectUploadWaves(sessionId);
    // Every file is inspected before any failure is reported; the first failure (in file order) decides the answer.
    // A file this read did not reach was not inspected: no URL is signed for it, so the answer is "retry later".
    const failure = inspected.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    loaded = (await loadDirectUploadSession(sessionId, userId))!;
    return await describeDirectUploadSession(loaded);
  } catch (error) {
    if (error instanceof ProjectIntakeError && error.code === "intake_reconciliation_required") throw error;
    throw new ProjectIntakeError("Upload storage evidence is unavailable; retry status later", 503, undefined, "upload_storage_unavailable");
  }
}

/** Confirmed results remain readable after the transfer deadline. */
export function assertUploadSessionActive(session: UploadSessionRow): number {
  if (["confirmed", "failed", "aborted", "expired"].includes(session.status)) throw new ProjectIntakeError("Upload session is closed", 409);
  const remaining = session.expires_at ? Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000) : 0;
  if (!Number.isFinite(remaining) || remaining < 1) throw new ProjectIntakeError("Upload session has expired", 409);
  return Math.min(SIGNED_UPLOAD_TTL_SECONDS, remaining);
}

/** How often a caller that may wait for a held session lock tries it again. */
const LOCK_RETRY_INTERVAL_MS = 250;

export interface DirectUploadLockOptions {
  /** How long to wait out another holder of the session (0: answer busy at once). */
  waitMs?: number;
  /** Which connection class to hold (lib/direct-upload-locks.ts); default `short`. */
  lockClass?: DirectUploadLockClass;
  /** The organization a `batch` holder counts against. */
  orgId?: string | null;
}

/**
 * Cross-process serialization: the dedicated connection owns the lock until release. A held lock answers 409
 * `upload_session_busy` at once, or after `waitMs` of retries; so does a saturated lock pool, on the caller's deadline.
 * A waiting caller releases its lock connection between tries: the pool must stay free for the holder and other sessions.
 */
export async function withDirectUploadLock<T>(sessionId: string, run: () => Promise<T>, busyMessage = "Upload session is being finalized; retry shortly", busyCode: ProjectIntakeErrorCode = "upload_session_busy", waitOrOptions: number | DirectUploadLockOptions = 0): Promise<T> {
  const options = typeof waitOrOptions === "number" ? { waitMs: waitOrOptions } : waitOrOptions;
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, options.waitMs ?? 0);
  const lockClass = options.lockClass ?? "short";
  const busy = () => {
    recordLockWait((Date.now() - startedAt) / 1000, lockClass, "busy");
    return new ProjectIntakeError(busyMessage, 409, undefined, busyCode);
  };
  for (;;) {
    let reserved: Awaited<ReturnType<typeof reserveDirectUploadLockConnection>>;
    try {
      reserved = await reserveDirectUploadLockConnection({ lockClass: options.lockClass, orgId: options.orgId, deadline });
    } catch (error) {
      if (error instanceof DirectUploadLockUnavailable) throw busy();
      throw error;
    }
    const { connection, release } = reserved;
    try {
      const [lock] = await connection`select pg_try_advisory_lock(hashtextextended(${`upload:${sessionId}`}, 0)) as acquired`;
      if (lock?.acquired) {
        recordLockWait((Date.now() - startedAt) / 1000, lockClass, "acquired");
        try { return await run(); }
        finally { await connection`select pg_advisory_unlock(hashtextextended(${`upload:${sessionId}`}, 0))`; }
      }
    } finally { release(); }
    if (Date.now() >= deadline) throw busy();
    await new Promise(resolve => setTimeout(resolve, Math.min(LOCK_RETRY_INTERVAL_MS, Math.max(1, deadline - Date.now()))));
  }
}

/**
 * The cancellation for storage work under one lock hold: the caller's own (a disconnected client) or the hard cap,
 * and a predicate that stops starting new files once the hold's budget is spent.
 */
export function lockHoldBudget(signal?: AbortSignal): { signal: AbortSignal; shouldStart: () => boolean } {
  const startedAt = Date.now();
  const hard = AbortSignal.timeout(env.directUploadLockHoldMaxMs);
  const combined = signal ? AbortSignal.any([signal, hard]) : hard;
  return { signal: combined, shouldStart: () => !combined.aborted && Date.now() - startedAt < env.directUploadLockHoldBudgetMs };
}

/** A file this hold did not get to: repeat it (the next call starts with it). */
export function notStartedError(): ProjectIntakeError {
  return new ProjectIntakeError("Not started within this request's time budget; repeat this file", 409, undefined, "upload_session_busy");
}

export function validMultipartLayout(parts: Array<{ partNumber: number; sizeBytes: number }>, size: number, partSize: number): boolean {
  if (!Number.isSafeInteger(size) || size < 0 || parts.length !== toDirectUploadPartCount(size, partSize) || parts.length > 10_000) return false;
  return parts.every((part, i) => part.partNumber === i + 1 && part.sizeBytes === Math.min(partSize, size - i * partSize));
}

export const DECLARED_SIZE_CHANGE_MESSAGE = "Declared upload size cannot change";

/**
 * A failure of storage or the database while finalizing is the server's, never the client's: it is a retryable 503
 * (`upload_storage_unavailable`), with the provider's own error only in the log. Definite answers stay as they are.
 */
export function uploadStorageUnavailable(error: unknown, context: string): ProjectIntakeError {
  console.error(`[direct-upload] status=storage-unavailable ${context} error_class=${errorClass(error)} ${isTransientStorageError(error) ? "transient" : "other"}`);
  return new ProjectIntakeError("Upload storage is temporarily unavailable; retry shortly", 503, undefined, "upload_storage_unavailable");
}

/**
 * How long one finalizer owns a file. Storage steps retry for well under this; a holder that dies loses the file to the
 * next finalizer when it lapses. Correctness never rests on the lease: every completion write is fenced on the
 * file still being pending at its original key, so of two finalizers only one publishes.
 */
export const FINALIZE_LEASE_SECONDS = 120;
const LEASE_POLL_MS = 100;

/**
 * Finalizes one file under its own lease, so a storage webhook, a client `files/complete` and the fallback reconciler
 * never work on the same file at once and need no session-wide lock. Idempotent: an already completed file answers true
 * without touching storage. A file another finalizer holds is waited for up to `waitMs`, then answers 409
 * `upload_session_busy` (retryable). Callers must have scoped `file` to the caller's session (it is re-checked here).
 */
export async function finalizeLeasedDirectUploadFile(file: UploadSessionFileRow, options: { finalSize?: number; waitMs?: number; signal?: AbortSignal; path?: "client" | "webhook" | "fallback" | "recovery" } = {}): Promise<boolean> {
  if (isFinalizedFileStatus(file.status)) return true;
  const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
  let contended = false;
  for (;;) {
    const token = randomUUID();
    const [claimed] = await sql<RawFileRow[]>`
      update upload_session_files set finalize_lease_until = now() + ${FINALIZE_LEASE_SECONDS}::int * interval '1 second', finalize_lease_token = ${token}
      where id = ${file.id} and session_id = ${file.session_id} and status = 'pending'
        and (finalize_lease_until is null or finalize_lease_until < now())
      returning id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status,
        completed_parts, canonical_id, source_path, unknown_size, request_index, client_id, content_identity, run_id, finalize_error`;
    if (claimed) {
      try {
        return await finalizeDirectUploadFile(normalizeFileRow(claimed), options.finalSize, { signal: options.signal });
      } finally {
        // A no-op once the completion write cleared it; best effort otherwise (the lease lapses on its own).
        try { await sql`update upload_session_files set finalize_lease_until = null, finalize_lease_token = null where id = ${file.id} and finalize_lease_token = ${token}`; }
        catch { console.error(`[direct-upload] status=lease-release-failed file=${file.id}`); }
      }
    }
    const current = await readFileState(file);
    if (isFinalizedFileStatus(current.status)) return true;
    if (current.status === "failed") throw storedFinalizeFailure(file, current.finalize_error);
    if (current.status !== "pending") throw new ProjectIntakeError("Upload session is closed", 409, undefined, "upload_session_closed");
    if (current.leased) {
      if (!contended) {
        contended = true;
        uploadEvent("lease_contention", { path: options.path ?? "client" });
      }
      if (Date.now() >= deadline) throw new ProjectIntakeError(`${file.filename} is being finalized; retry shortly`, 409, undefined, "upload_session_busy");
      await new Promise(resolve => setTimeout(resolve, Math.min(LEASE_POLL_MS, Math.max(1, deadline - Date.now()))));
    }
  }
}

async function readFileState(file: Pick<UploadSessionFileRow, "id" | "session_id">): Promise<{ status: string; leased: boolean; finalize_error: StoredFinalizeError | null }> {
  const [row] = await sql<Array<{ status: string; leased: boolean; finalize_error: StoredFinalizeError | null }>>`
    select status, coalesce(finalize_lease_until >= now(), false) as leased, finalize_error
    from upload_session_files where id = ${file.id} and session_id = ${file.session_id}`;
  if (!row) throw new ProjectIntakeError("Upload file not found", 404);
  return row;
}

/** The rejection the background finalizer recorded, answered again with its own status and message. */
export function storedFinalizeFailure(file: Pick<UploadSessionFileRow, "filename">, stored: StoredFinalizeError | null): ProjectIntakeError {
  const status = stored && [400, 409, 413, 415, 422].includes(stored.statusCode) ? stored.statusCode as 400 : 400;
  const error = new ProjectIntakeError(stored?.message ?? `${file.filename} was rejected`, status);
  finalFileFailures.set(error, stored?.code ?? rejectionCode(error));
  return error;
}

/** Failures of a file already marked `failed`, with their stored code: final, so no repeat or re-upload changes them. */
const finalFileFailures = new WeakMap<ProjectIntakeError, string>();

/** Storage is authoritative: never assemble a caller's unverified part manifest. */
export async function finalizeDirectUploadFile(file: UploadSessionFileRow, finalSize?: number, options: { signal?: AbortSignal } = {}): Promise<boolean> {
  try {
    return await finalizeDirectUploadFileUnclassified(file, finalSize, options.signal);
  } catch (error) {
    if (error instanceof ProjectIntakeError) throw error;
    throw uploadStorageUnavailable(error, `file=${file.id}`);
  }
}

async function finalizeDirectUploadFileUnclassified(file: UploadSessionFileRow, finalSize: number | undefined, signal: AbortSignal | undefined): Promise<boolean> {
  if (isFinalizedFileStatus(file.status)) return true;
  if (file.status !== "pending") return false;
  if (file.unknown_size && finalSize === undefined) return false;
  if (finalSize !== undefined) {
    if (!file.unknown_size && finalSize !== file.size_bytes) throw new ProjectIntakeError(DECLARED_SIZE_CHANGE_MESSAGE, 400);
    admitIntakeFile({ filename: file.filename, mimeType: file.mime_type, sizeBytes: finalSize }, "direct-upload");
    file = { ...file, size_bytes: finalSize };
    // Persist EOS before provider completion so recovery can verify an already assembled object.
    await sql`update upload_session_files set size_bytes = ${finalSize}, unknown_size = false where id = ${file.id} and status = 'pending'`;
  }
  let verified: { etag: string | null };
  try {
    verified = await verifyCompletedDirectUpload(file, signal);
  } catch (error) {
    if (!isStorageNotFound(error) && !(error instanceof ProjectIntakeError && error.message.startsWith("No object found"))) throw error;
    // A finalizer holding a stale row may find the original already gone because another one published it.
    if (file.upload_mode !== "multipart" || !file.upload_id) return await completedMeanwhile(file);
    const assembled = await assembleMultipartUpload(file, file.upload_id, signal);
    if (!assembled) return false;
    verified = assembled;
  }
  if (file.upload_mode !== "single") {
    // A completed multipart upload needs no copy: its part URLs are bound to an upload ID that completion closed.
    const published = await sql<{ id: string }[]>`update upload_session_files set status = (select case when ps.finalize_protocol = 'waves' then 'finalized' else 'completed' end from upload_sessions ps where ps.id = upload_session_files.session_id), updated_at = now(), finalized_at = now(),
        finalize_lease_until = null, finalize_lease_token = null, finalize_error = null
      where id = ${file.id} and status = 'pending' and source_key = ${file.source_key} returning id`;
    if (published.length === 1) return true;
    return await alreadyPublishedAs(file, file.source_key);
  }
  // A single-part file's presigned PUT stays valid for its whole TTL, so the client could replace the bytes after this
  // check (and after the server hashed them). Seal it: copy exactly the verified version to a key no URL names, and
  // ingest that. The sealed key is derived from the verified version, so a late or repeated copy of a different
  // version can never land on the key that was verified and published.
  const sourceKey = await sealSingleUpload(file, verified.etag, signal);
  // Publish the sealed key and durable cleanup of the original together, fenced on the row still being pending at
  // the original key: of two finalizers (a lost lock connection lets an old one run on), only one publishes.
  // Wait a day beyond completion for the 15-minute PUT authorization and in-flight writes.
  const published = await sql<{ id: string; source_key: string }[]>`with target as (
      select s.org_id from upload_sessions s join upload_session_files f on f.session_id = s.id
      where f.id = ${file.id} and s.id = ${file.session_id} and f.status = 'pending' and f.source_key = ${file.source_key}
    ), ownership as (
      insert into upload_cleanup_owners (original_key, sealed_key, org_id)
      select ${file.source_key}, ${sourceKey}, target.org_id from target
      on conflict (original_key) do update set original_key = excluded.original_key
      where upload_cleanup_owners.sealed_key = excluded.sealed_key
        and upload_cleanup_owners.org_id is not distinct from excluded.org_id
      returning org_id
    ), queued as (
      insert into storage_cleanup_queue (kind, org_id, target, payload, reason, not_before)
      select 'upload_original', ownership.org_id, ${file.source_key},
        jsonb_build_object('sealedKey', ${sourceKey}::text), 'sealed_upload', now() + interval '1 day'
      from ownership
      on conflict (kind, target) do update set not_before = greatest(storage_cleanup_queue.not_before, excluded.not_before)
      returning id
    ) update upload_session_files set status = (select case when ps.finalize_protocol = 'waves' then 'finalized' else 'completed' end from upload_sessions ps where ps.id = upload_session_files.session_id), source_key = ${sourceKey}, updated_at = now(), finalized_at = now(),
        finalize_lease_until = null, finalize_lease_token = null, finalize_error = null
      where id = ${file.id} and status = 'pending' and source_key = ${file.source_key} and exists (select 1 from queued)
      returning id, source_key`;
  if (published.length === 1 && published[0]?.id === file.id && published[0]?.source_key === sourceKey) {
    // The original stays writable until its URL expires; nothing reads it again. Best effort.
    await deleteUploadedObject(file.source_key).catch(() =>
      console.error(`[direct-upload] status=unsealed-delete-failed file=${file.id}`));
    return true;
  }
  return await alreadyPublishedAs(file, sourceKey);
}

async function completedMeanwhile(file: UploadSessionFileRow): Promise<boolean> {
  const [current] = await sql<Array<{ status: string }>>`select status from upload_session_files where id = ${file.id}`;
  return isFinalizedFileStatus(current?.status);
}

/**
 * After a fenced publish matched nothing: true when this same version was already published (an identical attempt won),
 * else 409. A losing sealed copy of another version is queued for cleanup once a winner is known, never before (an
 * identical attempt may still be about to publish it).
 */
async function alreadyPublishedAs(file: UploadSessionFileRow, attemptedKey: string): Promise<boolean> {
  const [current] = await sql<Array<{ status: string; source_key: string; org_id: string | null }>>`
    select f.status, f.source_key, s.org_id from upload_session_files f join upload_sessions s on s.id = f.session_id where f.id = ${file.id}`;
  if (isFinalizedFileStatus(current?.status) && current!.source_key === attemptedKey) return true;
  if (isFinalizedFileStatus(current?.status) && attemptedKey !== file.source_key && current!.source_key !== attemptedKey) {
    await discardLosingSeal(attemptedKey, current.source_key, current.org_id, file.id);
  }
  throw new ProjectIntakeError("Upload ownership changed during finalization", 409);
}

async function discardLosingSeal(losingKey: string, winningKey: string, orgId: string | null, fileId: string): Promise<void> {
  // Durable: the worker deletes an 'upload_original' target only while an ownership row vouches for it and nothing
  // references it. A copy still in flight may recreate the key, so the tombstone repeats the delete.
  try {
    await sql`with ownership as (
        insert into upload_cleanup_owners (original_key, sealed_key, org_id) values (${losingKey}, ${winningKey}, ${orgId})
        on conflict (original_key) do nothing returning org_id
      ) insert into storage_cleanup_queue (kind, org_id, target, payload, reason, not_before)
        select 'upload_original', ownership.org_id, ${losingKey}, jsonb_build_object('sealedKey', ${winningKey}::text), 'losing_seal', now() + interval '15 minutes'
        from ownership
        on conflict (kind, target) do nothing`;
  } catch { console.error(`[direct-upload] status=losing-seal-queue-failed file=${fileId}`); }
  await deleteUploadedObject(losingKey).catch(() => console.error(`[direct-upload] status=losing-seal-delete-failed file=${fileId}`));
}

/**
 * Assembles a multipart upload from storage's own part list. Returns the verified object, or null when the parts are
 * not all there yet. A closed upload (NoSuchUpload, from ListParts or from completion) goes through one recovery path.
 */
async function assembleMultipartUpload(file: UploadSessionFileRow, uploadId: string, signal: AbortSignal | undefined): Promise<{ etag: string | null } | null> {
  let parts: Awaited<ReturnType<typeof listMultipartUploadParts>>;
  try { parts = await withStorageRetry(() => listMultipartUploadParts({ key: file.source_key, uploadId, signal }), undefined, signal); }
  catch (error) {
    if (storageErrorName(error) === "NoSuchUpload") return await recoverClosedMultipart(file, error, signal);
    throw error;
  }
  if (!validMultipartLayout(parts, file.size_bytes, file.part_size ?? MULTIPART_PART_SIZE_BYTES)) return null;
  try { await withStorageRetry(() => completeMultipartUpload({ key: file.source_key, uploadId, parts, signal }), undefined, signal); }
  catch (error) {
    if (storageErrorName(error) === "NoSuchUpload") return await recoverClosedMultipart(file, error, signal);
    throw multipartCompletionError(error, file.filename);
  }
  await sql`update upload_session_files set completed_parts = ${sql.json(parts)} where id = ${file.id} and status = 'pending'`;
  return await verifyCompletedDirectUpload(file, signal);
}

/**
 * The multipart upload is closed: completed by an attempt whose answer was lost, or aborted. Storage decides. Only the
 * server completes uploads (clients hold part URLs only), so an object of the verified size is this one. No object is
 * the client's 400; a storage failure while looking stays retryable (it is never turned into a 400).
 */
async function recoverClosedMultipart(file: UploadSessionFileRow, closed: unknown, signal: AbortSignal | undefined): Promise<{ etag: string | null }> {
  try {
    return await verifyCompletedDirectUpload(file, signal);
  } catch (error) {
    if (error instanceof ProjectIntakeError && error.message.startsWith("No object found")) throw multipartCompletionError(closed, file.filename);
    throw error;
  }
}

/**
 * Where a single-part upload is sealed: beside the original, named by the (server-chosen) file id and the verified
 * version, so each verified version has its own destination.
 */
export function sealedSourceKey(file: Pick<UploadSessionFileRow, "id" | "source_key">, etag: string): string {
  const slash = file.source_key.lastIndexOf("/");
  const name = file.source_key.slice(slash + 1).replace(/^[0-9a-f-]{36}-/i, "");
  const version = createHash("sha256").update(etag).digest("hex").slice(0, 16);
  return `${file.source_key.slice(0, slash)}/sealed-${file.id}-${version}-${name}`;
}

async function sealSingleUpload(file: UploadSessionFileRow, etag: string | null, signal: AbortSignal | undefined): Promise<string> {
  if (!etag) throw new ProjectIntakeError(`Unable to verify the uploaded version of ${file.filename}`, 400);
  const sealed = sealedSourceKey(file, etag);
  try {
    // Idempotent: the same If-Match copy to the same version's key writes the same bytes again.
    await withStorageRetry(() => copyUploadedObject({ fromKey: file.source_key, toKey: sealed, ifMatch: etag, signal }), undefined, signal);
  } catch (error) {
    if (storageErrorName(error) === "PreconditionFailed" || (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412) {
      throw new ProjectIntakeError(`${file.filename} changed while its upload was being completed; upload it again`, 409);
    }
    throw error;
  }
  // The sealed copy is what is hashed and ingested: check it is the verified size too.
  await verifyCompletedDirectUpload({ ...file, source_key: sealed }, signal);
  return sealed;
}

export { MAX_DIRECT_UPLOAD_COMPLETE_BATCH };
/**
 * How long a `files/complete` call holds the reconciler off its session while files remain open. A client that stops
 * completing loses the hold after this and the reconciler takes over; an expired session is reconciled regardless.
 */
export const CLIENT_FINALIZING_HOLD_SECONDS = 30;
/** The longest a run of client holds can keep the reconciler off a session, from the first hold. */
export const CLIENT_FINALIZING_MAX_HOLD_SECONDS = 15 * 60;
export const PARTS_INCOMPLETE_MESSAGE = "Upload parts are incomplete or have incorrect sizes";

/**
 * What a client does about a failed file:
 * - `retryable` (with `action: "retry"`): repeat the same request for this file as it is (storage briefly unavailable,
 *   the session busy, or this call's time budget spent).
 * - `action: "reupload"`: put the file's bytes again (or finish its parts), then repeat (missing object, parts
 *   incomplete, bytes changed or of the wrong size).
 * - `action: "none"`: nothing a repeat can fix (unknown file, refused type or size, changed declared size).
 * - `blocksSession`: always false. Files are finalized one by one, so no file fails its session: a file whose stored
 *   bytes are definitely refused (wrong size, refused type or size) is failed on its own, permanently, by the storage
 *   webhook or the fallback reconciler once the client stops completing it, and the session's other files go on.
 *   A file already failed answers with its stored error and `action: "none"`.
 */
export type DirectUploadFileError = { statusCode: number; code: string; message: string; retryable: boolean; action: "retry" | "reupload" | "none"; blocksSession: boolean };

export type DirectUploadFileCompletion =
  | { fileId: string; status: "completed" }
  | { fileId: string; status: "failed"; error: DirectUploadFileError };

const REUPLOAD_MESSAGES = ["Upload parts are incomplete", "No object found", "Uploaded size for", "Multipart completion for"];

/** The public, per-file description of a file's failure (see DirectUploadFileError). */
export function describeFileFailure(error: ProjectIntakeError): DirectUploadFileError {
  const code = error.code ?? rejectionCode(error);
  const retryable = error.statusCode >= 500 || code === "upload_session_busy";
  const reupload = !retryable && (error.message.includes("changed while its upload was being completed")
    || REUPLOAD_MESSAGES.some(prefix => error.message.startsWith(prefix)));
  // A file already failed is final; anything else may still be fixed by a repeat or a re-upload before the file fails.
  const finalCode = finalFileFailures.get(error);
  if (finalCode) return { statusCode: error.statusCode, code: finalCode, message: error.message, retryable: false, action: "none", blocksSession: false };
  return { statusCode: error.statusCode, code, message: error.message, retryable, action: retryable ? "retry" : reupload ? "reupload" : "none", blocksSession: false };
}

type FinalizeOutcome = { fileId: string; completed: true } | { fileId: string; completed: false; error: unknown };

/** How long a client complete waits for a file another finalizer (usually the storage webhook) is working on. */
export const CLIENT_COMPLETE_LEASE_WAIT_MS = 5_000;

/**
 * Finalizes the named files of one session, at most `directUploadFinalizeConcurrency` at a time, each under its own
 * lease (no session lock: the storage webhook, waves and other completes proceed beside it). Session-level problems
 * (not found, closed, expired, a revoked share) throw before any file is touched. Each file is looked up in this caller's
 * session only (an id from another session or user is "not found"), and a file is completed only through
 * `finalizeDirectUploadFile`: verified size, sealed by an If-Match copy or a storage-validated multipart assembly,
 * re-admitted by intake policy. A file's failure never affects the others. Idempotent: a file the webhook already
 * finalized answers completed, also once the session's last run has started.
 */
async function finalizeSessionFiles(sessionId: string, userId: string, entries: readonly CompleteDirectUploadFileEntry[], options: { signal?: AbortSignal } = {}): Promise<{ outcomes: FinalizeOutcome[]; sessionComplete: boolean }> {
  if (entries.length < 1 || entries.length > MAX_DIRECT_UPLOAD_COMPLETE_BATCH) {
    throw new ProjectIntakeError(`Complete between 1 and ${MAX_DIRECT_UPLOAD_COMPLETE_BATCH} files per request`, 400);
  }
  // Two finalizers on one file would race the sealing copy and the completion write.
  if (new Set(entries.map(entry => entry.fileId)).size !== entries.length) throw new ProjectIntakeError("Each fileId may appear once per request", 400);
  // Only the session row and the named files: per-call work must not grow with the session (a 1,000-file session is
  // completed in 10+ calls, and loading every row on each made the whole upload quadratic).
  const session = await loadDirectUploadSessionRow(sessionId, userId);
  if (!session) throw new ProjectIntakeError("Upload session not found", 404);
  // Background finalization can confirm a session before its client gets to complete: completing a finalized file of
  // a confirmed session is still a success. Nothing else is touched once the session is closed.
  const confirmed = session.status === "confirmed";
  if (!confirmed) assertUploadSessionActive(session);
  if (["aborted", "failed"].includes(session.status)) throw new ProjectIntakeError("Upload session is closed", 409);
  // This client is finalizing: the fallback reconciler leaves the session's files to it. Only the first call opens a
  // hold; later ones extend it only on new progress (below), up to a cap from when it began.
  if (["pending", "uploading"].includes(session.status)) {
    await sql`update upload_sessions set client_finalizing_since = now(),
      client_finalizing_until = now() + ${CLIENT_FINALIZING_HOLD_SECONDS}::int * interval '1 second'
      where id = ${sessionId} and user_id = ${userId} and status in ('pending', 'uploading') and client_finalizing_since is null`;
  }
  const targeted = await loadDirectUploadSessionFiles(sessionId, entries.map(entry => entry.fileId));
  const { assertSessionProjectStillContributable } = await import("./direct-session-idempotency.js");
  await assertSessionProjectStillContributable(session, userId);
  const byId = new Map(targeted.map(file => [file.id, file]));
  let finalizedHere = 0;
  // One request starts new files only within a time budget (the rest answer retryable busy); a client that disconnects
  // cancels its in-flight storage work (fenced, so nothing is half-published).
  const budget = lockHoldBudget(options.signal);
  const settled = await settleBounded(entries, env.directUploadFinalizeConcurrency, async entry => {
    const file = byId.get(entry.fileId);
    if (!file) throw new ProjectIntakeError("Upload file not found", 404);
    if (isFinalizedFileStatus(file.status)) return;
    if (file.status === "failed") throw storedFinalizeFailure(file, file.finalize_error ?? null);
    if (confirmed) throw new ProjectIntakeError("Upload session is closed", 409);
    if (!await finalizeLeasedDirectUploadFile(file, { finalSize: entry.sizeBytes, waitMs: CLIENT_COMPLETE_LEASE_WAIT_MS, signal: budget.signal, path: "client" })) {
      throw new ProjectIntakeError(PARTS_INCOMPLETE_MESSAGE, 409);
    }
    finalizedHere += 1;
  }, { shouldStart: budget.shouldStart });
  const outcomes = settled.map((result, i): FinalizeOutcome => result.status === "fulfilled"
    ? { fileId: entries[i]!.fileId, completed: true }
    : { fileId: entries[i]!.fileId, completed: false, error: result.reason === NOT_STARTED ? notStartedError() : result.reason });
  // Stops at the first open file, so it is cheap while the session is still filling.
  const [open] = await sql<Array<{ open: boolean }>>`select exists (select 1 from upload_session_files where session_id = ${sessionId} and status = 'pending') as open`;
  const sessionComplete = open?.open === false;
  // Files still open: this client is finalizing, so the fallback reconciler leaves the session's files to it for a
  // while instead of inspecting storage beside it. Waves are not held: they start as files arrive.
  if (sessionComplete) {
    await sql`update upload_sessions set client_finalizing_until = null, client_finalizing_since = null where id = ${sessionId} and client_finalizing_since is not null`;
  } else if (finalizedHere > 0 && ["pending", "uploading"].includes(session.status)) {
    // New progress persisted: extend the hold, never beyond the cap from when the hold began.
    await sql`update upload_sessions set client_finalizing_until = least(
        now() + ${CLIENT_FINALIZING_HOLD_SECONDS}::int * interval '1 second',
        coalesce(client_finalizing_since, now()) + ${CLIENT_FINALIZING_MAX_HOLD_SECONDS}::int * interval '1 second')
      where id = ${sessionId} and status in ('pending', 'uploading')`;
  }
  if (finalizedHere > 0 || sessionComplete) await scheduleDirectUploadWaves(sessionId);
  return { outcomes, sessionComplete };
}

/**
 * After files of a session were finalized (or failed): records when its next wave is due and asks this process to check
 * then. A wave is due at once when `directUploadWaveFiles` finalized files are waiting or no file is still open, else
 * `directUploadWaveDelayMs` after the first waiting file was finalized. An extract session takes one run, once every
 * file is in. Durable first (`next_reconcile_at`, read by the sweep), then the in-process timer.
 */
/** How many finalized files start the next wave, after `startedWaves` waves (see `directUploadWaveGrowth`). */
export function directUploadWaveThreshold(startedWaves: number): number {
  return Math.min(10_000, Math.ceil(env.directUploadWaveFiles * env.directUploadWaveGrowth ** Math.max(0, startedWaves)));
}

export async function scheduleDirectUploadWaves(sessionId: string): Promise<void> {
  const [state] = await sql<Array<{ waiting: number; waves: number; open: boolean; extract: boolean; protocol: string | null; delay_ms: number | null; blocked_ms: number | null }>>`
    select
      (select count(*)::int from upload_session_files where session_id = s.id and status in ('completed', 'finalized') and run_id is null) as waiting,
      (select count(*)::int from upload_session_runs where session_id = s.id and status = 'committed') as waves,
      exists (select 1 from upload_session_files where session_id = s.id and status = 'pending') as open,
      s.extract_id is not null as extract,
      s.finalize_protocol as protocol,
      (select greatest(0, ceil(extract(epoch from (min(finalized_at) + ${env.directUploadWaveDelayMs}::int * interval '1 millisecond' - now())) * 1000))::int
        from upload_session_files where session_id = s.id and status in ('completed', 'finalized') and run_id is null) as delay_ms,
      greatest(0, ceil(extract(epoch from (s.wave_blocked_until - now())) * 1000))::int as blocked_ms
    from upload_sessions s where s.id = ${sessionId} and s.status in ('pending', 'uploading', 'ingesting')`;
  if (!state) return;
  let delayMs: number;
  if (!state.open) delayMs = 0;
  // A 'single' session (and an extract) takes its one run once every file is in: nothing is due before that.
  else if (state.extract || state.protocol !== "waves" || state.waiting === 0) return;
  else if (state.waiting >= directUploadWaveThreshold(Number(state.waves ?? 0))) delayMs = 0;
  else delayMs = Number(state.delay_ms ?? env.directUploadWaveDelayMs);
  delayMs = Math.max(delayMs, Number(state.blocked_ms ?? 0));
  await sql`update upload_sessions set next_reconcile_at = least(next_reconcile_at, now() + ${delayMs}::int * interval '1 millisecond')
    where id = ${sessionId} and status in ('pending', 'uploading', 'ingesting')`;
  requestDirectUploadWaveCheck(sessionId, delayMs);
}

export type BackgroundFinalizeOutcome = "completed" | "not-ready" | "failed" | "busy" | "retry" | "skipped";

/**
 * Finalizes one file without a client: after a storage webhook names its key, or when the fallback reconciler finds it
 * still open past its grace period. The file is read by id within its session and user, never from webhook fields.
 * A definite rejection of the stored bytes (wrong size, refused by intake policy) fails that file only, with a client-safe
 * message; anything else is retried later. Never throws.
 */
export async function finalizeDirectUploadFileInBackground(ref: { fileId: string; sessionId: string; userId: string }, path: "webhook" | "fallback" = "webhook"): Promise<BackgroundFinalizeOutcome> {
  const outcome = await finalizeInBackground(ref, path);
  uploadEvent(path === "webhook" ? "webhook_finalize" : "fallback_finalize", { outcome: outcome.outcome.replace("-", "_"), ...(outcome.errorClass ? { error_class: outcome.errorClass } : {}) },
    outcome.outcome === "failed" || outcome.errorClass
      ? { severity: outcome.outcome === "failed" ? "warn" : "error", body: `upload file ${ref.fileId} ${path} finalize ${outcome.outcome}`, attributes: { "docslurp.upload.file_id": ref.fileId, "docslurp.upload.session_id": ref.sessionId } }
      : undefined);
  return outcome.outcome;
}

async function finalizeInBackground(ref: { fileId: string; sessionId: string; userId: string }, path: "webhook" | "fallback"): Promise<{ outcome: BackgroundFinalizeOutcome; errorClass?: string }> {
  try {
    const [row] = await sql<RawFileRow[]>`
      select f.id, f.session_id, f.filename, f.mime_type, f.size_bytes, f.source_key, f.upload_mode, f.upload_id, f.part_size, f.status,
        f.completed_parts, f.canonical_id, f.source_path, f.unknown_size, f.request_index, f.client_id, f.content_identity, f.run_id, f.finalize_error
      from upload_session_files f join upload_sessions s on s.id = f.session_id
      where f.id = ${ref.fileId} and f.session_id = ${ref.sessionId} and s.user_id = ${ref.userId}
        and s.status in ('pending', 'uploading', 'ingesting') and s.expires_at > now()`;
    if (!row || row.status !== "pending") return { outcome: "skipped" };
    const file = normalizeFileRow(row);
    let completed: boolean;
    try {
      completed = await finalizeLeasedDirectUploadFile(file, { path });
    } catch (error) {
      if (error instanceof ProjectIntakeError && error.code === "upload_session_busy") return { outcome: "busy" };
      if (error instanceof ProjectIntakeError && error.code === "upload_session_closed") return { outcome: "skipped" };
      if (error instanceof ProjectIntakeError && [400, 413, 415, 422].includes(error.statusCode)) {
        const stored: StoredFinalizeError = { statusCode: error.statusCode, code: error.code ?? rejectionCode(error), message: error.message };
        const failed = await sql`update upload_session_files set status = 'failed', finalize_error = ${sql.json(stored)}, updated_at = now()
          where id = ${file.id} and status = 'pending' and (finalize_lease_until is null or finalize_lease_until < now()) returning id`;
        if (failed.length === 1) {
          await scheduleDirectUploadWaves(file.session_id);
          return { outcome: "failed", errorClass: errorClass(error) };
        }
        return { outcome: "busy" };
      }
      // A replaced object (409), a storage outage (503): the file stays open and is tried again.
      await deferBackgroundCheck(file.id);
      return { outcome: "retry", errorClass: errorClass(error) };
    }
    if (!completed) {
      await deferBackgroundCheck(file.id);
      return { outcome: "not-ready" };
    }
    await scheduleDirectUploadWaves(file.session_id);
    return { outcome: "completed" };
  } catch (error) {
    return { outcome: "retry", errorClass: errorClass(error) };
  }
}

/** The fallback reconciler looks at a file again later, backing off while its bytes have not arrived. */
async function deferBackgroundCheck(fileId: string): Promise<void> {
  await sql`update upload_session_files set check_attempts = check_attempts + 1,
    next_check_at = now() + least(300, 15 * power(2, least(check_attempts, 4))) * interval '1 second'
    where id = ${fileId} and status = 'pending'`;
}

/** The single-file `files/complete` body: throws the file's own error, exactly as before batching existed. */
export async function completeDirectUploadFile(input: CompleteDirectUploadFileInput & { signal?: AbortSignal }): Promise<{ sessionComplete: boolean }> {
  const { signal, sessionId, userId, ...entry } = input;
  const { outcomes: [outcome], sessionComplete } = await finalizeSessionFiles(sessionId, userId, [entry], { signal });
  if (outcome && !outcome.completed) throw outcome.error;
  return { sessionComplete };
}

/**
 * The batched `files/complete` body. Good files complete and bad ones are reported per file (with the status code and
 * message the single-file call would have answered); only a session-level problem fails the request.
 */
export async function completeDirectUploadFiles(input: { sessionId: string; userId: string; files: readonly CompleteDirectUploadFileEntry[]; signal?: AbortSignal }): Promise<{ files: DirectUploadFileCompletion[]; completedCount: number; failedCount: number; sessionComplete: boolean }> {
  const { outcomes, sessionComplete } = await finalizeSessionFiles(input.sessionId, input.userId, input.files, { signal: input.signal });
  const files = outcomes.map((outcome): DirectUploadFileCompletion => {
    if (outcome.completed) return { fileId: outcome.fileId, status: "completed" };
    if (outcome.error instanceof ProjectIntakeError) {
      return { fileId: outcome.fileId, status: "failed", error: describeFileFailure(outcome.error) };
    }
    // Provider and database errors can carry credentials or internals: log the name only, answer a generic retryable error.
    const unavailable = uploadStorageUnavailable(outcome.error, `session=${input.sessionId} file=${outcome.fileId}`);
    return { fileId: outcome.fileId, status: "failed", error: describeFileFailure(unavailable) };
  });
  const completedCount = files.filter(file => file.status === "completed").length;
  return { files, completedCount, failedCount: files.length - completedCount, sessionComplete };
}

/** How long part signing waits out a wave or an abort holding the session. */
const SIGN_PARTS_LOCK_WAIT_MS = 10_000;

export async function signDirectUploadParts(sessionId: string, userId: string, fileId: string, partNumbers: number[]) {
  return withDirectUploadLock(sessionId, async () => {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  if (!loaded) throw new ProjectIntakeError("Upload session not found", 404);
  const ttl = assertUploadSessionActive(loaded.session);
  const { assertSessionProjectStillContributable } = await import("./direct-session-idempotency.js");
  await assertSessionProjectStillContributable(loaded.session, userId);
  if (!["pending", "uploading"].includes(loaded.session.status)) throw new ProjectIntakeError("Upload session is closed", 409);
  const file = loaded.files.find(item => item.id === fileId);
  if (!file || file.status !== "pending" || !file.upload_id) throw new ProjectIntakeError("Open multipart file not found", 404);
  try {
    await getUploadedObjectMetadata(file.source_key);
    // A completed object closes the transfer; completion will seal it without another PUT.
    throw new ProjectIntakeError("Upload object already exists; refresh session", 409);
  } catch (error) {
    if (!isStorageNotFound(error)) {
      if (error instanceof ProjectIntakeError) throw error;
      throw new ProjectIntakeError("Upload storage evidence is unavailable", 503);
    }
  }
  try { await listMultipartUploadParts({ key: file.source_key, uploadId: file.upload_id }); }
  catch { throw new ProjectIntakeError("Upload storage evidence is unavailable", 503); }
  return { parts: await Promise.all(partNumbers.map(async partNumber => {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || partNumber > Math.max(1, Math.ceil(env.maxUploadBytes / (file.part_size ?? MULTIPART_PART_SIZE_BYTES))) || (!file.unknown_size && partNumber > toDirectUploadPartCount(file.size_bytes, file.part_size ?? MULTIPART_PART_SIZE_BYTES))) throw new ProjectIntakeError("Invalid part number", 400);
    return { partNumber, url: await signMultipartUploadPart({ key: file.source_key, uploadId: file.upload_id!, partNumber, expiresInSeconds: assertUploadSessionActive(loaded.session) }) };
  })) };
  }, undefined, undefined, SIGN_PARTS_LOCK_WAIT_MS);
}

/**
 * A pending wave whose holder is gone (a crash, or a lost lock connection while the holder runs on) is fenced: moved to
 * 'failed' in one statement, which the database orders against its run's publication (trigger on project_runs). If the
 * run committed first, the wave is already 'committed' and is left alone; otherwise its run can never commit. Then files
 * of failed waves go back to waiting. Both steps are idempotent, so a crash between them is repaired on the next pass.
 * Callers hold the session lock; a live holder that lost it only loses its run, never ingests a file twice.
 */
export async function fenceInterruptedWaves(sessionId: string): Promise<number> {
  const fenced = await sql<Array<{ run_id: string }>>`
    update upload_session_runs set status = 'failed' where session_id = ${sessionId} and status = 'pending' returning run_id`;
  await freeFailedWaveFiles(sessionId);
  if (fenced.length > 0) console.warn(`[upload-waves] session=${sessionId} fenced=${fenced.length} reason=interrupted-wave`);
  return fenced.length;
}

/** Files held by a failed wave wait for the next one. The database refuses this for any other wave. */
export async function freeFailedWaveFiles(sessionId: string): Promise<void> {
  await sql`update upload_session_files set run_id = null, updated_at = now()
    where session_id = ${sessionId} and run_id in (select run_id from upload_session_runs where session_id = ${sessionId} and status = 'failed')`;
}

/**
 * Ends a session that will start no further run (aborted, expired, refused). Files no run took are aborted and cleaned
 * up. A session with any committed run ends `confirmed`, never `failed` or `aborted`: its runs are ingesting or done,
 * and `failedFileCount` / `abortedFileCount` say which files were not, so no client asks to upload it again.
 */
export async function closeDirectUploadSession(sessionId: string, outcome: "aborted" | "failed", message: string | null): Promise<"confirmed" | "aborted" | "failed"> {
  await fenceInterruptedWaves(sessionId);
  await sql`update upload_session_files set status = 'aborted', finalize_lease_until = null, finalize_lease_token = null, updated_at = now()
    where session_id = ${sessionId} and run_id is null and status in ('pending', 'completed', 'finalized')`;
  const [first] = await sql<Array<{ result: unknown }>>`
    select result from upload_session_runs where session_id = ${sessionId} and status = 'committed' order by wave limit 1`;
  let closed: "confirmed" | "aborted" | "failed";
  if (first) {
    closed = "confirmed";
    await sql`update upload_sessions set status = 'confirmed', result = coalesce(result, ${first.result === null ? null : sql.json(JSON.parse(JSON.stringify(first.result)))}),
        last_error = ${message}, client_finalizing_until = null, client_finalizing_since = null, updated_at = now()
      where id = ${sessionId} and status <> 'confirmed'`;
  } else {
    closed = outcome;
    await sql`update upload_sessions set status = ${outcome}, last_error = coalesce(${message}, last_error), updated_at = now()
      where id = ${sessionId} and status <> 'confirmed'`;
  }
  await queueAbandonedDirectUploadCleanup(sessionId);
  uploadEvent("session_closed", { outcome: closed === "confirmed" ? "partial" : closed }, { body: `upload session ${sessionId} closed (${closed})`, attributes: { "docslurp.upload.session_id": sessionId } });
  return closed;
}

async function abortDirectUploadSessionUnlocked(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const session = await loadDirectUploadSessionRow(sessionId, userId);
  if (!session) {
    return false;
  }
  // Every file is in a run: nothing is left to abort. A 'single' session's one run is being started ('ingesting').
  if (session.status === "confirmed" || (session.status === "ingesting" && sessionProtocol(session) === "single")) {
    throw new ProjectIntakeError("Ingested uploads cannot be aborted", 409);
  }
  // A 'waves' session stops starting runs. Runs already started keep their files; files no run took are aborted and
  // cleaned up (a finalizer still working on one loses its fenced completion write), and with any run the session ends
  // confirmed (partly), not aborted.
  const closed = await closeDirectUploadSession(sessionId, "aborted", null);
  // An aborted extract session has nothing to keep: its prefix is emptied on the next sweep.
  if (session.extract_id && closed !== "confirmed") {
    await sql`update extracts set expires_at = least(expires_at, now()), updated_at = now()
      where id = ${session.extract_id} and run_id is null and state = 'active'`;
  }
  return true;
}

/** `lockWaitMs`: how long to wait out a reconciler pass or another request holding the session (0: answer busy at once). */
export async function abortDirectUploadSession(sessionId: string, userId: string, lockWaitMs = 0): Promise<boolean> {
  return withDirectUploadLock(sessionId, () => abortDirectUploadSessionUnlocked(sessionId, userId), undefined, undefined, lockWaitMs);
}

export function assertDirectUploadSessionReadyForIntake(
  loaded: LoadedDirectUploadSession,
): void {
  if (loaded.session.status === "confirmed") {
    throw new ProjectIntakeError(
      "Upload session is already confirmed",
      409,
    );
  }

  if (["aborted", "failed"].includes(loaded.session.status)) {
    throw new ProjectIntakeError("Upload session has been aborted", 409);
  }

  assertUploadSessionActive(loaded.session);
  if (loaded.files.length === 0) {
    throw new ProjectIntakeError("Upload session has no files", 400);
  }
}

export async function prepareDirectUploadProjectIntake(
  sessionId: string,
  userId: string,
): Promise<PreparedDirectUploadProjectIntake> {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  if (!loaded) {
    throw new ProjectIntakeError("Upload session not found", 404);
  }

  assertDirectUploadSessionReadyForIntake(loaded);

  return {
    session: loaded.session,
    items: directUploadIntakeItems(loaded),
  };
}

export async function markDirectUploadSessionConfirmed(args: {
  sessionId: string;
  projectId: string;
  orgId: string;
}): Promise<void> {
  await sql`
    update upload_sessions
    set status = 'confirmed',
        project_id = ${args.projectId},
        org_id = ${args.orgId},
        updated_at = now()
    where id = ${args.sessionId}
  `;
}

/**
 * Completed session files are already in object storage; intake reuses their
 * keys. A file that never finished uploading is reported as rejected, so the
 * completed ones are still ingested.
 */
export function directUploadIntakeItems(
  loaded: LoadedDirectUploadSession,
): ProjectIntakeItem[] {
  return loaded.files.map((file) => ({
    filename: file.filename,
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    canonicalId: file.canonical_id ?? null,
    path: file.source_path ?? "",
    content: file.status === "completed"
      ? { storedKey: file.source_key, verifiedSizeBytes: file.size_bytes }
      : { rejected: new ProjectIntakeError(`${file.filename} did not finish uploading`, 409) },
  }));
}

async function verifyCompletedDirectUpload(
  file: UploadSessionFileRow,
  signal?: AbortSignal,
): Promise<{ etag: string | null }> {
  let metadata: Awaited<ReturnType<typeof getUploadedObjectMetadata>>;
  try {
    metadata = await withStorageRetry(() => getUploadedObjectMetadata(file.source_key, signal), undefined, signal);
  } catch (error) {
    if (isStorageNotFound(error)) {
      throw new ProjectIntakeError(
        file.upload_mode === "single"
          ? `No object found in storage for ${file.filename}: this file uses single-part mode, so PUT its bytes to the file's putUrl before completing (the session has no parts to upload)`
          : `No object found in storage for ${file.filename} after completing the multipart upload`,
        400,
      );
    }
    throw error;
  }
  const actualSize = metadata.contentLength;
  if (actualSize === null) {
    throw new ProjectIntakeError(`Unable to verify upload size for ${file.filename}`, 400);
  }
  admitIntakeFile(
    { filename: file.filename, mimeType: file.mime_type, sizeBytes: actualSize },
    "direct-upload",
  );
  if (actualSize !== file.size_bytes) {
    throw new ProjectIntakeError(
      `Uploaded size for ${file.filename} (${actualSize} bytes) did not match the declared size (${file.size_bytes} bytes)`,
      400,
    );
  }
  return { etag: metadata.etag };
}

function storageErrorName(error: unknown): string {
  const e = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: number } } | null;
  const name = typeof e?.name === "string" ? e.name : typeof e?.Code === "string" ? e.Code : "";
  if (e?.$metadata?.httpStatusCode === 404 && !name) return "NotFound";
  return name;
}

function isStorageNotFound(error: unknown): boolean {
  const name = storageErrorName(error);
  return name === "NotFound" || name === "NoSuchKey";
}

/** Maps S3 CompleteMultipartUpload failures to a specific, secret-free 400. Unknown errors rethrow. */
function multipartCompletionError(error: unknown, filename: string): unknown {
  switch (storageErrorName(error)) {
    case "InvalidPart":
      return new ProjectIntakeError(`Multipart completion for ${filename} failed: a part is missing or its etag does not match the uploaded part (InvalidPart)`, 400);
    case "InvalidPartOrder":
      return new ProjectIntakeError(`Multipart completion for ${filename} failed: parts must be in ascending partNumber order (InvalidPartOrder)`, 400);
    case "EntityTooSmall":
      return new ProjectIntakeError(`Multipart completion for ${filename} failed: a non-final part is smaller than the storage provider's minimum part size (EntityTooSmall)`, 400);
    case "NoSuchUpload":
      return new ProjectIntakeError(`Multipart upload for ${filename} is no longer open (expired, aborted or already completed); create a new upload session`, 400);
    default:
      return error;
  }
}

/** Wait out outstanding signed PUTs before deleting abandoned raw objects. */
export async function queueAbandonedDirectUploadCleanup(sessionId: string): Promise<void> {
  // Only files no run took and that will never join one (aborted or failed); a run's sources are never touched.
  const files = await sql<Array<{ source_key: string; upload_id: string }>>`
    select f.source_key, f.upload_id from upload_session_files f join upload_sessions s on s.id = f.session_id
    where s.id = ${sessionId} and f.status in ('aborted', 'failed') and f.upload_id is not null and f.run_id is null`;
  for (const file of files) {
    // Abort is idempotent at the service boundary; an assembled or already
    // aborted MPU may legitimately return NoSuchUpload.
    await abortMultipartUpload({ key: file.source_key, uploadId: file.upload_id }).catch(error => {
      if (storageErrorName(error) !== "NoSuchUpload") console.error(`[upload-cleanup] multipart abort failed session=${sessionId}`);
    });
  }
  await sql`insert into storage_cleanup_queue (kind, org_id, target, payload, artifact_uris, reason, not_before)
    select 'storage_prefix', coalesce(s.org_id, ''), s.user_id || '/' || s.id || '/',
      jsonb_build_object('projectId', s.project_id), array_agg(f.source_key), 'abandoned_upload', now() + interval '16 minutes'
    from upload_sessions s join upload_session_files f on f.session_id = s.id
    where s.id = ${sessionId} and f.status in ('aborted', 'failed') and f.run_id is null
    group by s.id
    on conflict (kind, target) do update set artifact_uris = excluded.artifact_uris,
      not_before = greatest(storage_cleanup_queue.not_before, excluded.not_before)`;
}
