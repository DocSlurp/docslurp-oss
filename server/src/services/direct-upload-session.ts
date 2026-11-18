import { randomUUID } from "node:crypto";

import type { RunOrigin } from "@docslurp/shared";
import type { PipelineFeatureOverrides, ProjectTemplateKey } from "@docslurp/shared";

import { sql } from "../db.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { env } from "../config.js";
import { reserveDirectUploadLockConnection } from "../lib/direct-upload-locks.js";
import { settleBounded } from "../lib/bounded-settle.js";
import { isTransientStorageError, withStorageRetry } from "../lib/storage-retry.js";
import { MAX_DIRECT_UPLOAD_COMPLETE_BATCH } from "../lib/direct-upload-limits.js";
import { normalizeUploadPath } from "../lib/canonical-id.js";
import { requestDirectUploadWaveCheck } from "./direct-upload-wave-scheduler.js";
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

/** The session row alone, scoped to its user: what authorization and session-level checks need, at O(1) in session size. */
export async function loadDirectUploadSessionRow(
  sessionId: string,
  userId: string,
): Promise<UploadSessionRow | null> {
  const [session] = await sql<UploadSessionRow[]>`
    select expires_at, id, user_id, org_id, project_id, project_name, template_key, pipeline, tags, status, result, last_error, api_key_id, origin, allowed_project_ids, extract_id
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
  if (file.status === "completed" || file.status === "aborted") return { transferState: file.status === "completed" ? "complete" as const : "unavailable" as const, verifiedBytes: file.status === "completed" ? file.size_bytes : null, ...fileRef(file), id: file.id, filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes, mode: file.upload_mode as "single" | "multipart", status: file.status };
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
      ? { ...fileRef(file), id: file.id, filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes, mode: file.upload_mode as "single" | "multipart", status: file.status, ...fileOutcome(file) }
      : { ...await buildDirectUploadFileDescriptor(file, ttl, loaded.session.expires_at), ...fileOutcome(file) }),
  );
  const runs = await listDirectUploadRuns(loaded.session.id);
  return {
    expiresAt: loaded.session.expires_at ? new Date(loaded.session.expires_at).toISOString() : null,
    sessionId: loaded.session.id,
    status: loaded.session.status,
    /** The first run's intake response, once every file is in a run (or failed); kept for clients that read one run. */
    result: (loaded.session.result as { payload?: unknown } | null)?.payload ?? null,
    error: loaded.session.last_error ?? null,
    /** The project the session's runs went to (set by its first run). */
    projectId: runs.length > 0 ? loaded.session.project_id : null,
    /** Every run this upload started, in order. Files are ingested in waves while the upload is still in progress. */
    runs,
    files,
  };
}

/** A file's run, or its definite rejection: only what the uploader may see. */
function fileOutcome(file: UploadSessionFileRow): { runId?: string; error?: StoredFinalizeError } {
  return {
    ...(file.run_id ? { runId: file.run_id } : {}),
    ...(file.status === "failed" && file.finalize_error ? { error: { statusCode: file.finalize_error.statusCode, code: file.finalize_error.code, message: file.finalize_error.message } } : {}),
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

/** The runs a session has started (or is starting), in wave order. */
export async function listDirectUploadRuns(sessionId: string): Promise<DirectUploadRunSummary[]> {
  const rows = await sql<Array<{ run_id: string; wave: number; status: string; file_count: number; documents: number | null; created_at: Date | string }>>`
    select run_id, wave, status, file_count, jsonb_array_length(result -> 'payload' -> 'documents') as documents, created_at
    from upload_session_runs where session_id = ${sessionId} order by wave`;
  return rows.map(row => ({
    runId: row.run_id,
    wave: Number(row.wave),
    status: row.status === "started" ? "started" as const : "starting" as const,
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
    const inspected = await settleBounded(open, env.directUploadFinalizeConcurrency, async file => {
      let exists = false;
      try { await withStorageRetry(() => getUploadedObjectMetadata(file.source_key)); exists = true; }
      catch (error) { if (!isStorageNotFound(error)) throw error; }
      if (!exists) return;
      try { if (await finalizeLeasedDirectUploadFile(file)) finalized += 1; }
      catch (error) {
        // Another finalizer (a webhook, the client, the reconciler) holds this file: it will settle it.
        if (!(error instanceof ProjectIntakeError && error.code === "upload_session_busy")) throw error;
      }
    });
    if (finalized > 0) await scheduleDirectUploadWaves(sessionId);
    // Every file is inspected before any failure is reported; the first failure (in file order) decides the answer.
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

/**
 * Cross-process serialization: the dedicated connection owns the lock until release. A held lock answers 409
 * `upload_session_busy` at once, or after `waitMs` of retries. A waiting caller releases its lock connection between
 * tries: the per-process lock pool is tiny and must stay free for the holder and other sessions.
 */
export async function withDirectUploadLock<T>(sessionId: string, run: () => Promise<T>, busyMessage = "Upload session is being finalized; retry shortly", busyCode: ProjectIntakeErrorCode = "upload_session_busy", waitMs = 0): Promise<T> {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const { connection, release } = await reserveDirectUploadLockConnection();
    try {
      const [lock] = await connection`select pg_try_advisory_lock(hashtextextended(${`upload:${sessionId}`}, 0)) as acquired`;
      if (lock?.acquired) {
        try { return await run(); }
        finally { await connection`select pg_advisory_unlock(hashtextextended(${`upload:${sessionId}`}, 0))`; }
      }
    } finally { release(); }
    if (Date.now() >= deadline) throw new ProjectIntakeError(busyMessage, 409, undefined, busyCode);
    await new Promise(resolve => setTimeout(resolve, Math.min(LOCK_RETRY_INTERVAL_MS, Math.max(1, deadline - Date.now()))));
  }
}

export function validMultipartLayout(parts: Array<{ partNumber: number; sizeBytes: number }>, size: number, partSize: number): boolean {
  if (!Number.isSafeInteger(size) || size < 0 || parts.length !== toDirectUploadPartCount(size, partSize) || parts.length > 10_000) return false;
  return parts.every((part, i) => part.partNumber === i + 1 && part.sizeBytes === Math.min(partSize, size - i * partSize));
}

/**
 * A failure of storage or the database while finalizing is the server's, never the client's: it is a retryable 503
 * (`upload_storage_unavailable`), with the provider's own error only in the log. Definite answers stay as they are.
 */
export function uploadStorageUnavailable(error: unknown, context: string): ProjectIntakeError {
  console.error(`[direct-upload] status=storage-unavailable ${context}`, error instanceof Error ? error.name : "unknown", isTransientStorageError(error) ? "transient" : "other");
  return new ProjectIntakeError("Upload storage is temporarily unavailable; retry shortly", 503, undefined, "upload_storage_unavailable");
}

/**
 * How long one finalizer owns a file. Storage steps retry for well under this; a holder that dies loses the file to the
 * next finalizer when it lapses, and its late writes are fenced off by the lease token.
 */
export const FINALIZE_LEASE_SECONDS = 120;
const LEASE_POLL_MS = 100;

/**
 * Finalizes one file under its own lease, so a storage webhook, a client `files/complete` and the fallback reconciler
 * never work on the same file at once and need no session-wide lock. Idempotent: an already completed file answers true
 * without touching storage. A file another finalizer holds is waited for up to `waitMs`, then answers 409
 * `upload_session_busy` (retryable). Callers must have scoped `file` to the caller's session (it is re-checked here).
 */
export async function finalizeLeasedDirectUploadFile(file: UploadSessionFileRow, options: { finalSize?: number; waitMs?: number } = {}): Promise<boolean> {
  if (file.status === "completed") return true;
  const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
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
        return await finalizeDirectUploadFile(normalizeFileRow(claimed), options.finalSize, token);
      } finally {
        // A no-op once the completion write cleared it; best effort otherwise (the lease lapses on its own).
        try { await sql`update upload_session_files set finalize_lease_until = null, finalize_lease_token = null where id = ${file.id} and finalize_lease_token = ${token}`; }
        catch { console.error(`[direct-upload] status=lease-release-failed file=${file.id}`); }
      }
    }
    const current = await readFileState(file);
    if (current.status === "completed") return true;
    if (current.status === "failed") throw storedFinalizeFailure(file, current.finalize_error);
    if (current.status !== "pending") throw new ProjectIntakeError("Upload session is closed", 409, undefined, "upload_session_closed");
    if (current.leased) {
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
function storedFinalizeFailure(file: Pick<UploadSessionFileRow, "filename">, stored: StoredFinalizeError | null): ProjectIntakeError {
  const status = stored && [400, 409, 413, 415, 422].includes(stored.statusCode) ? stored.statusCode as 400 : 400;
  return new ProjectIntakeError(stored?.message ?? `${file.filename} was rejected`, status);
}

/** Storage is authoritative: never assemble a caller's unverified part manifest. `leaseToken` fences every write. */
export async function finalizeDirectUploadFile(file: UploadSessionFileRow, finalSize: number | undefined, leaseToken: string): Promise<boolean> {
  try {
    return await finalizeDirectUploadFileUnclassified(file, finalSize, leaseToken);
  } catch (error) {
    if (error instanceof ProjectIntakeError) throw error;
    throw uploadStorageUnavailable(error, `file=${file.id}`);
  }
}

/** A fenced completion write matched nothing: another finalizer finished the file, or the session was aborted. */
async function lostLease(file: UploadSessionFileRow): Promise<boolean> {
  const current = await readFileState(file);
  if (current.status === "completed") return true;
  if (current.status === "pending") throw new ProjectIntakeError(`${file.filename} is being finalized; retry shortly`, 409, undefined, "upload_session_busy");
  throw new ProjectIntakeError("Upload session is closed", 409, undefined, "upload_session_closed");
}

async function finalizeDirectUploadFileUnclassified(file: UploadSessionFileRow, finalSize: number | undefined, leaseToken: string): Promise<boolean> {
  if (file.status === "completed") return true;
  if (file.status !== "pending") return false;
  if (file.unknown_size && finalSize === undefined) return false;
  if (finalSize !== undefined) {
    if (!file.unknown_size && finalSize !== file.size_bytes) throw new ProjectIntakeError("Declared upload size cannot change", 400);
    admitIntakeFile({ filename: file.filename, mimeType: file.mime_type, sizeBytes: finalSize }, "direct-upload");
    file = { ...file, size_bytes: finalSize };
    // Persist EOS before provider completion so recovery can verify an already assembled object.
    const persisted = await sql`update upload_session_files set size_bytes = ${finalSize}, unknown_size = false
      where id = ${file.id} and status = 'pending' and finalize_lease_token = ${leaseToken} returning id`;
    if (persisted.length !== 1) return await lostLease(file);
  }
  let verified: { etag: string | null };
  try {
    verified = await verifyCompletedDirectUpload(file);
  } catch (error) {
    if (!isStorageNotFound(error) && !(error instanceof ProjectIntakeError && error.message.startsWith("No object found"))) throw error;
    if (file.upload_mode !== "multipart" || !file.upload_id) return false;
    const uploadId = file.upload_id;
    const parts = await withStorageRetry(() => listMultipartUploadParts({ key: file.source_key, uploadId }));
    if (!validMultipartLayout(parts, file.size_bytes, file.part_size ?? MULTIPART_PART_SIZE_BYTES)) return false;
    let assembled: { etag: string | null } | null = null;
    try { await withStorageRetry(() => completeMultipartUpload({ key: file.source_key, uploadId, parts })); }
    catch (error) {
      // A retried completion whose earlier answer was lost finds the upload already closed: storage decides. Only the
      // server completes uploads (clients hold part URLs only), so an object of the verified size is this one.
      if (storageErrorName(error) !== "NoSuchUpload") throw multipartCompletionError(error, file.filename);
      assembled = await verifyCompletedDirectUpload(file).catch(() => null);
      if (!assembled) throw multipartCompletionError(error, file.filename);
    }
    verified = assembled ?? await verifyCompletedDirectUpload(file);
    await sql`update upload_session_files set completed_parts = ${sql.json(parts)} where id = ${file.id} and finalize_lease_token = ${leaseToken}`;
  }
  // A single-part file's presigned PUT stays valid for its whole TTL, so the client could replace
  // the bytes after this check (and after the server hashed them). Seal it: copy exactly the
  // verified version to a key no URL names, and ingest that. A completed multipart upload needs no
  // copy: its part URLs are bound to an upload ID that completion closed, and no PUT URL exists.
  const sourceKey = file.upload_mode === "single" ? await sealSingleUpload(file, verified.etag) : file.source_key;
  if (sourceKey !== file.source_key) {
    // Publish the sealed key and durable cleanup together: a crash must not lose the old key.
    // Wait a day beyond completion for the 15-minute PUT authorization and in-flight writes.
    const published = await sql<{ id: string; source_key: string }[]>`with ownership as (
      insert into upload_cleanup_owners (original_key, sealed_key, org_id)
      select ${file.source_key}, ${sourceKey}, s.org_id from upload_sessions s where s.id = ${file.session_id}
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
    ) update upload_session_files set status = 'completed', source_key = ${sourceKey}, updated_at = now(), finalized_at = now(),
        finalize_lease_until = null, finalize_lease_token = null, finalize_error = null
      where id = ${file.id} and status = 'pending' and finalize_lease_token = ${leaseToken} and exists (select 1 from queued)
      returning id, source_key`;
    if (published.length === 0) {
      // Another finalizer completed it (with the same sealed key) or the session was aborted: never publish twice.
      if (await lostLease(file)) return true;
    }
    if (published.length !== 1 || published[0]?.id !== file.id || published[0]?.source_key !== sourceKey) {
      throw new ProjectIntakeError("Upload ownership changed during finalization", 409);
    }
    // The original stays writable until its URL expires; nothing reads it again. Best effort.
    await deleteUploadedObject(file.source_key).catch(() =>
      console.error(`[direct-upload] status=unsealed-delete-failed file=${file.id}`));
  } else {
    const completed = await sql`update upload_session_files set status = 'completed', source_key = ${sourceKey}, updated_at = now(), finalized_at = now(),
        finalize_lease_until = null, finalize_lease_token = null, finalize_error = null
      where id = ${file.id} and status = 'pending' and finalize_lease_token = ${leaseToken} returning id`;
    if (completed.length !== 1) return await lostLease(file);
  }
  return true;
}

/** Where a single-part upload is sealed: beside the original, named by the (server-chosen) file id. */
export function sealedSourceKey(file: Pick<UploadSessionFileRow, "id" | "source_key">): string {
  const slash = file.source_key.lastIndexOf("/");
  const name = file.source_key.slice(slash + 1).replace(/^[0-9a-f-]{36}-/i, "");
  return `${file.source_key.slice(0, slash)}/sealed-${file.id}-${name}`;
}

async function sealSingleUpload(file: UploadSessionFileRow, etag: string | null): Promise<string> {
  if (!etag) throw new ProjectIntakeError(`Unable to verify the uploaded version of ${file.filename}`, 400);
  const sealed = sealedSourceKey(file);
  try {
    // Idempotent: the same If-Match copy repeated after a lost answer writes the same bytes again.
    await withStorageRetry(() => copyUploadedObject({ fromKey: file.source_key, toKey: sealed, ifMatch: etag }));
  } catch (error) {
    if (storageErrorName(error) === "PreconditionFailed" || (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412) {
      throw new ProjectIntakeError(`${file.filename} changed while its upload was being completed; upload it again`, 409);
    }
    throw error;
  }
  // The sealed copy is what is hashed and ingested: check it is the verified size too.
  await verifyCompletedDirectUpload({ ...file, source_key: sealed });
  return sealed;
}

export { MAX_DIRECT_UPLOAD_COMPLETE_BATCH };
/**
 * How long a `files/complete` call holds the reconciler off its session while files remain open. A client that stops
 * completing loses the hold after this and the reconciler takes over; an expired session is reconciled regardless.
 */
export const CLIENT_FINALIZING_HOLD_SECONDS = 30;

export type DirectUploadFileCompletion =
  | { fileId: string; status: "completed" }
  | { fileId: string; status: "failed"; error: { statusCode: number; code: string; message: string; retryable: boolean } };

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
async function finalizeSessionFiles(sessionId: string, userId: string, entries: readonly CompleteDirectUploadFileEntry[]): Promise<{ outcomes: FinalizeOutcome[]; sessionComplete: boolean }> {
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
  const targeted = await loadDirectUploadSessionFiles(sessionId, entries.map(entry => entry.fileId));
  const { assertSessionProjectStillContributable } = await import("./direct-session-idempotency.js");
  await assertSessionProjectStillContributable(session, userId);
  const byId = new Map(targeted.map(file => [file.id, file]));
  let finalizedHere = 0;
  const settled = await settleBounded(entries, env.directUploadFinalizeConcurrency, async entry => {
    const file = byId.get(entry.fileId);
    if (!file) throw new ProjectIntakeError("Upload file not found", 404);
    if (file.status === "completed") return;
    if (file.status === "failed") throw storedFinalizeFailure(file, file.finalize_error ?? null);
    if (confirmed) throw new ProjectIntakeError("Upload session is closed", 409);
    if (!await finalizeLeasedDirectUploadFile(file, { finalSize: entry.sizeBytes, waitMs: CLIENT_COMPLETE_LEASE_WAIT_MS })) {
      throw new ProjectIntakeError("Upload parts are incomplete or have incorrect sizes", 409);
    }
    finalizedHere += 1;
  });
  const outcomes = settled.map((result, i): FinalizeOutcome => result.status === "fulfilled"
    ? { fileId: entries[i]!.fileId, completed: true }
    : { fileId: entries[i]!.fileId, completed: false, error: result.reason });
  // Stops at the first open file, so it is cheap while the session is still filling.
  const [open] = await sql<Array<{ open: boolean }>>`select exists (select 1 from upload_session_files where session_id = ${sessionId} and status = 'pending') as open`;
  const sessionComplete = open?.open === false;
  // Files still open: this client is finalizing, so the fallback reconciler leaves the session's files to it for a
  // while instead of inspecting storage beside it. Waves are not held: they start as files arrive.
  if (sessionComplete) {
    await sql`update upload_sessions set client_finalizing_until = null where id = ${sessionId} and client_finalizing_until is not null`;
  } else if (["pending", "uploading"].includes(session.status)) {
    await sql`update upload_sessions set client_finalizing_until = now() + ${CLIENT_FINALIZING_HOLD_SECONDS}::int * interval '1 second' where id = ${sessionId}`;
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
export async function scheduleDirectUploadWaves(sessionId: string): Promise<void> {
  const [state] = await sql<Array<{ waiting: number; open: boolean; extract: boolean; delay_ms: number | null; blocked_ms: number | null }>>`
    select
      (select count(*)::int from upload_session_files where session_id = s.id and status = 'completed' and run_id is null) as waiting,
      exists (select 1 from upload_session_files where session_id = s.id and status = 'pending') as open,
      s.extract_id is not null as extract,
      (select greatest(0, ceil(extract(epoch from (min(finalized_at) + ${env.directUploadWaveDelayMs}::int * interval '1 millisecond' - now())) * 1000))::int
        from upload_session_files where session_id = s.id and status = 'completed' and run_id is null) as delay_ms,
      greatest(0, ceil(extract(epoch from (s.wave_blocked_until - now())) * 1000))::int as blocked_ms
    from upload_sessions s where s.id = ${sessionId} and s.status in ('pending', 'uploading', 'ingesting')`;
  if (!state) return;
  let delayMs: number;
  if (!state.open) delayMs = 0;
  else if (state.extract || state.waiting === 0) return;
  else if (state.waiting >= env.directUploadWaveFiles) delayMs = 0;
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
export async function finalizeDirectUploadFileInBackground(ref: { fileId: string; sessionId: string; userId: string }): Promise<BackgroundFinalizeOutcome> {
  try {
    const [row] = await sql<RawFileRow[]>`
      select f.id, f.session_id, f.filename, f.mime_type, f.size_bytes, f.source_key, f.upload_mode, f.upload_id, f.part_size, f.status,
        f.completed_parts, f.canonical_id, f.source_path, f.unknown_size, f.request_index, f.client_id, f.content_identity, f.run_id, f.finalize_error
      from upload_session_files f join upload_sessions s on s.id = f.session_id
      where f.id = ${ref.fileId} and f.session_id = ${ref.sessionId} and s.user_id = ${ref.userId}
        and s.status in ('pending', 'uploading', 'ingesting') and s.expires_at > now()`;
    if (!row || row.status !== "pending") return "skipped";
    const file = normalizeFileRow(row);
    let completed: boolean;
    try {
      completed = await finalizeLeasedDirectUploadFile(file);
    } catch (error) {
      if (error instanceof ProjectIntakeError && error.code === "upload_session_busy") return "busy";
      if (error instanceof ProjectIntakeError && error.code === "upload_session_closed") return "skipped";
      if (error instanceof ProjectIntakeError && [400, 413, 415, 422].includes(error.statusCode)) {
        const stored: StoredFinalizeError = { statusCode: error.statusCode, code: error.code ?? rejectionCode(error), message: error.message };
        const failed = await sql`update upload_session_files set status = 'failed', finalize_error = ${sql.json(stored)}, updated_at = now()
          where id = ${file.id} and status = 'pending' and (finalize_lease_until is null or finalize_lease_until < now()) returning id`;
        if (failed.length === 1) {
          console.error(`[direct-upload] status=file-rejected file=${file.id} code=${stored.code}`);
          await scheduleDirectUploadWaves(file.session_id);
          return "failed";
        }
        return "busy";
      }
      // A replaced object (409), a storage outage (503): the file stays open and is tried again.
      await deferBackgroundCheck(file.id);
      return "retry";
    }
    if (!completed) {
      await deferBackgroundCheck(file.id);
      return "not-ready";
    }
    await scheduleDirectUploadWaves(file.session_id);
    return "completed";
  } catch (error) {
    console.error(`[direct-upload] status=background-finalize-failed file=${ref.fileId}`, error instanceof Error ? error.name : "unknown");
    return "retry";
  }
}

/** The fallback reconciler looks at a file again later, backing off while its bytes have not arrived. */
async function deferBackgroundCheck(fileId: string): Promise<void> {
  await sql`update upload_session_files set check_attempts = check_attempts + 1,
    next_check_at = now() + least(300, 15 * power(2, least(check_attempts, 4))) * interval '1 second'
    where id = ${fileId} and status = 'pending'`;
}

/** The single-file `files/complete` body: throws the file's own error, exactly as before batching existed. */
export async function completeDirectUploadFile(input: CompleteDirectUploadFileInput): Promise<{ sessionComplete: boolean }> {
  const { outcomes: [outcome], sessionComplete } = await finalizeSessionFiles(input.sessionId, input.userId, [input]);
  if (outcome && !outcome.completed) throw outcome.error;
  return { sessionComplete };
}

/**
 * The batched `files/complete` body. Good files complete and bad ones are reported per file (with the status code and
 * message the single-file call would have answered); only a session-level problem fails the request.
 */
export async function completeDirectUploadFiles(input: { sessionId: string; userId: string; files: readonly CompleteDirectUploadFileEntry[] }): Promise<{ files: DirectUploadFileCompletion[]; completedCount: number; failedCount: number; sessionComplete: boolean }> {
  const { outcomes, sessionComplete } = await finalizeSessionFiles(input.sessionId, input.userId, input.files);
  const files = outcomes.map((outcome): DirectUploadFileCompletion => {
    if (outcome.completed) return { fileId: outcome.fileId, status: "completed" };
    if (outcome.error instanceof ProjectIntakeError) {
      const code = outcome.error.code ?? rejectionCode(outcome.error);
      return { fileId: outcome.fileId, status: "failed", error: { statusCode: outcome.error.statusCode, code, message: outcome.error.message, retryable: outcome.error.statusCode >= 500 || code === "upload_session_busy" } };
    }
    // Provider and database errors can carry credentials or internals: log the name only, answer a generic retryable error.
    const unavailable = uploadStorageUnavailable(outcome.error, `session=${input.sessionId} file=${outcome.fileId}`);
    return { fileId: outcome.fileId, status: "failed", error: { statusCode: unavailable.statusCode, code: unavailable.code!, message: unavailable.message, retryable: true } };
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

async function abortDirectUploadSessionUnlocked(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const session = await loadDirectUploadSessionRow(sessionId, userId);
  if (!session) {
    return false;
  }
  const loaded = { session };

  if (loaded.session.status === "confirmed" || loaded.session.status === "ingesting") throw new ProjectIntakeError("Ingested uploads cannot be aborted", 409);

  // Runs already started keep their files: only files no run has taken are aborted (and cleaned up). A finalizer still
  // working on one of them loses its fenced completion write.
  await sql`
    update upload_session_files
    set status = 'aborted',
        finalize_lease_until = null,
        finalize_lease_token = null,
        updated_at = now()
    where session_id = ${sessionId} and run_id is null
  `;
  await sql`
    update upload_sessions
    set status = 'aborted',
        updated_at = now()
    where id = ${sessionId}
  `;

  await queueAbandonedDirectUploadCleanup(sessionId);
  // An aborted extract session has nothing to keep: its prefix is emptied on the next sweep.
  if (loaded.session.extract_id && (await listDirectUploadRuns(sessionId)).length === 0) {
    await sql`update extracts set expires_at = least(expires_at, now()), updated_at = now()
      where id = ${loaded.session.extract_id} and run_id is null and state = 'active'`;
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
): Promise<{ etag: string | null }> {
  let metadata: Awaited<ReturnType<typeof getUploadedObjectMetadata>>;
  try {
    metadata = await withStorageRetry(() => getUploadedObjectMetadata(file.source_key));
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
  const files = await sql<Array<{ source_key: string; upload_id: string }>>`
    select f.source_key, f.upload_id from upload_session_files f join upload_sessions s on s.id = f.session_id
    where s.id = ${sessionId} and s.status in ('aborted', 'failed') and f.upload_id is not null and f.run_id is null`;
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
    where s.id = ${sessionId} and s.status in ('aborted', 'failed') and f.run_id is null
    group by s.id
    on conflict (kind, target) do update set artifact_uris = excluded.artifact_uris,
      not_before = greatest(storage_cleanup_queue.not_before, excluded.not_before)`;
}
