import { randomUUID } from "node:crypto";

import type { RunOrigin, UploadSessionProgress } from "@docslurp/shared";
import { estimateRunEta, observedPagesPerMinute } from "@docslurp/shared";
import type { PipelineFeatureOverrides, ProjectTemplateKey } from "@docslurp/shared";

import { sql } from "../db.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { notePrediction } from "./run-activity-summary.js";
import { env } from "../config.js";
import { reserveDirectUploadLockConnection } from "../lib/direct-upload-locks.js";
import { normalizeUploadPath } from "../lib/canonical-id.js";
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

export interface CompleteDirectUploadFileInput {
  sessionId: string;
  userId: string;
  fileId: string;
  etag?: string;
  sizeBytes?: number;
  parts?: Array<{ partNumber: number; etag: string }>;
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
};

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

export async function loadDirectUploadSession(
  sessionId: string,
  userId: string,
): Promise<LoadedDirectUploadSession | null> {
  const [session] = await sql<UploadSessionRow[]>`
    select expires_at, id, user_id, org_id, project_id, project_name, template_key, pipeline, tags, status, result, last_error, api_key_id, origin, allowed_project_ids, extract_id
    from upload_sessions
    where id = ${sessionId} and user_id = ${userId}
    limit 1
  `;

  if (!session) {
    return null;
  }

  const rows = await sql<Array<Omit<UploadSessionFileRow, "size_bytes" | "part_size"> & {
    size_bytes: number | string;
    part_size: number | string | null;
  }>>`
    select
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
      completed_parts,
      canonical_id,
      source_path,
      unknown_size,
      request_index,
      client_id,
      content_identity
    from upload_session_files
    where session_id = ${sessionId}
    order by request_index asc nulls last, created_at asc
  `;

  // PostgreSQL bigint columns arrive as strings; browser file matching and
  // storage size verification require numbers on both sides of the comparison.
  const files = rows.map((file) => ({
    ...file,
    size_bytes: Number(file.size_bytes),
    part_size: file.part_size === null ? null : Number(file.part_size),
  }));
  return { session, files };
}

/** How a client matches a session file to the file it sent: its position in the request and its own id. */
function fileRef(file: UploadSessionFileRow) {
  return { identity: file.content_identity ?? null, index: file.request_index ?? null, clientId: file.client_id ?? null };
}

async function storedPartsAtExpectedSize(file: UploadSessionFileRow, partSize: number, partCount: number): Promise<Array<{ partNumber: number; etag: string }>> {
  if (file.status !== "pending" || !file.upload_id) return [];
  let parts: Awaited<ReturnType<typeof listMultipartUploadParts>>;
  try { parts = await listMultipartUploadParts({ key: file.source_key, uploadId: file.upload_id }); }
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
        content_identity
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
        ${file.identity ? sql.json(file.identity) : null}
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
    loaded.files.map(async (file) => statusOnly || ["confirmed", "failed", "aborted"].includes(loaded.session.status) ? { ...fileRef(file), id: file.id, filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes, mode: file.upload_mode as "single" | "multipart", status: file.status } : await buildDirectUploadFileDescriptor(file, ttl, loaded.session.expires_at)),
  );
  return {
    expiresAt: loaded.session.expires_at ? new Date(loaded.session.expires_at).toISOString() : null,
    sessionId: loaded.session.id,
    status: loaded.session.status,
    result: (loaded.session.result as { payload?: unknown } | null)?.payload ?? null,
    error: loaded.session.last_error ?? null,
    files,
    progress: await directUploadSessionProgress(loaded),
  };
}

/**
 * Transfer progress from the session's own files, then the run it started (the run id is the session id), with its
 * pages per minute and ETA bucket. The run is read only for the session's own user and organization. A progress read
 * never fails the status response: an unreadable run is reported as null and the error goes to telemetry.
 */
export async function directUploadSessionProgress(loaded: LoadedDirectUploadSession, now = Date.now()): Promise<UploadSessionProgress> {
  const completed = loaded.files.filter(file => file.status === "completed");
  const progress: UploadSessionProgress = {
    files: { total: loaded.files.length, completed: completed.length },
    bytes: {
      total: loaded.files.reduce((sum, file) => sum + (Number.isFinite(file.size_bytes) ? file.size_bytes : 0), 0),
      completed: completed.reduce((sum, file) => sum + (Number.isFinite(file.size_bytes) ? file.size_bytes : 0), 0),
    },
    run: null,
  };
  const { session } = loaded;
  if (!session.org_id || !["ingesting", "confirmed"].includes(session.status)) return progress;
  try {
    const [run] = await sql<Array<{
      id: string; status: string; total_documents: number | string; processed_documents: number | string;
      pages_total: number | string; pages_processed: number | string; worker_started_at: string | Date | null; created_at: string | Date;
      history_pages: number | string | null; history_runtime_ms: number | string | null;
    }>>`
      select r.id, r.status, r.total_documents, r.processed_documents, r.pages_total, r.pages_processed, r.worker_started_at, r.created_at,
        cs.completed_run_pages_processed as history_pages, cs.completed_run_runtime_ms as history_runtime_ms
      from project_runs r
      left join project_corpus_stats cs on cs.project_id = r.project_id
      where r.id = ${session.id} and r.user_id = ${session.user_id} and r.org_id = ${session.org_id}
      limit 1`;
    if (!run) return progress;
    const pagesTotal = Math.max(0, Number(run.pages_total) || 0);
    const pagesProcessed = Math.min(pagesTotal, Math.max(0, Number(run.pages_processed) || 0));
    const history = run.history_pages === null ? null : { pages: Number(run.history_pages), runtimeMs: Number(run.history_runtime_ms) };
    const eta = estimateRunEta({ status: run.status, pagesTotal, pagesProcessed, startedAt: run.worker_started_at, history, now });
    if (eta) notePrediction(run.id, session.org_id, eta, (now - new Date(run.created_at).getTime()) / 1000);
    const observed = run.status === "processing" ? observedPagesPerMinute({ pagesProcessed, startedAt: run.worker_started_at, now }) : null;
    progress.run = {
      id: run.id,
      status: run.status,
      documents: { total: Math.max(0, Number(run.total_documents) || 0), processed: Math.max(0, Number(run.processed_documents) || 0) },
      pages: { total: pagesTotal, processed: pagesProcessed },
      pagesPerMinute: observed === null ? null : Math.round(observed * 10) / 10,
      eta: eta ? { ...eta, seconds: Math.round(eta.seconds), pagesPerMinute: Math.round(eta.pagesPerMinute * 10) / 10 } : null,
    };
  } catch (error) {
    console.error(`[upload-progress] session=${session.id} run progress unavailable`, error instanceof Error ? error.name : "unknown");
  }
  return progress;
}

/** A native key may only operate on sessions created in its organization. */
export async function directUploadSessionBelongsToOrganization(sessionId: string, userId: string, orgId: string, allowedProjectIds?: readonly string[] | null, apiKeyId?: string): Promise<boolean> {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  return Boolean(apiKeyId) && loaded?.session.org_id === orgId && loaded.session.api_key_id === apiKeyId && (!allowedProjectIds?.length || Boolean(loaded.session.project_id && allowedProjectIds.includes(loaded.session.project_id)));
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
  return withDirectUploadLock(sessionId, async () => {
    let loaded = await loadDirectUploadSession(sessionId, userId);
    if (!loaded) return null;
    if (loaded.session.status === "confirmed") return describeDirectUploadSession(loaded, true);
    assertUploadSessionActive(loaded.session);
    const { assertSessionProjectStillContributable } = await import("./direct-session-idempotency.js");
    await assertSessionProjectStillContributable(loaded.session, userId);
    // Inspect all final objects before authorizing any retry. An outage is not absence.
    try {
      for (const file of loaded.files) {
        if (file.status !== "pending" || file.unknown_size) continue;
        let exists = false;
        try { await getUploadedObjectMetadata(file.source_key); exists = true; }
        catch (error) { if (!isStorageNotFound(error)) throw error; }
        if (exists) await finalizeDirectUploadFile(file);
      }
      loaded = (await loadDirectUploadSession(sessionId, userId))!;
      return await describeDirectUploadSession(loaded);
    } catch (error) {
      if (error instanceof ProjectIntakeError && error.code === "intake_reconciliation_required") throw error;
      throw new ProjectIntakeError("Upload storage evidence is unavailable; retry status later", 503, undefined, "upload_storage_unavailable");
    }
  });
}

/** Confirmed results remain readable after the transfer deadline. */
export function assertUploadSessionActive(session: UploadSessionRow): number {
  if (["confirmed", "failed", "aborted", "expired"].includes(session.status)) throw new ProjectIntakeError("Upload session is closed", 409);
  const remaining = session.expires_at ? Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000) : 0;
  if (!Number.isFinite(remaining) || remaining < 1) throw new ProjectIntakeError("Upload session has expired", 409);
  return Math.min(SIGNED_UPLOAD_TTL_SECONDS, remaining);
}

/** Cross-process serialization: the dedicated connection owns the lock until release. */
export async function withDirectUploadLock<T>(sessionId: string, run: () => Promise<T>, busyMessage = "Upload session is being finalized; retry shortly", busyCode: ProjectIntakeErrorCode = "upload_session_busy"): Promise<T> {
  const { connection, release } = await reserveDirectUploadLockConnection();
  try {
    const [lock] = await connection`select pg_try_advisory_lock(hashtextextended(${`upload:${sessionId}`}, 0)) as acquired`;
    if (!lock?.acquired) throw new ProjectIntakeError(busyMessage, 409, undefined, busyCode);
    try { return await run(); }
    finally { await connection`select pg_advisory_unlock(hashtextextended(${`upload:${sessionId}`}, 0))`; }
  } finally { release(); }
}

export function validMultipartLayout(parts: Array<{ partNumber: number; sizeBytes: number }>, size: number, partSize: number): boolean {
  if (!Number.isSafeInteger(size) || size < 0 || parts.length !== toDirectUploadPartCount(size, partSize) || parts.length > 10_000) return false;
  return parts.every((part, i) => part.partNumber === i + 1 && part.sizeBytes === Math.min(partSize, size - i * partSize));
}

/** Storage is authoritative: never assemble a caller's unverified part manifest. */
export async function finalizeDirectUploadFile(file: UploadSessionFileRow, finalSize?: number): Promise<boolean> {
  if (file.status === "completed") return true;
  if (file.status !== "pending") return false;
  if (file.unknown_size && finalSize === undefined) return false;
  if (finalSize !== undefined) {
    if (!file.unknown_size && finalSize !== file.size_bytes) throw new ProjectIntakeError("Declared upload size cannot change", 400);
    admitIntakeFile({ filename: file.filename, mimeType: file.mime_type, sizeBytes: finalSize }, "direct-upload");
    file = { ...file, size_bytes: finalSize };
    // Persist EOS before provider completion so recovery can verify an already assembled object.
    await sql`update upload_session_files set size_bytes = ${finalSize}, unknown_size = false where id = ${file.id}`;
  }
  let verified: { etag: string | null };
  try {
    verified = await verifyCompletedDirectUpload(file);
  } catch (error) {
    if (!isStorageNotFound(error) && !(error instanceof ProjectIntakeError && error.message.startsWith("No object found"))) throw error;
    if (file.upload_mode !== "multipart" || !file.upload_id) return false;
    const parts = await listMultipartUploadParts({ key: file.source_key, uploadId: file.upload_id });
    if (!validMultipartLayout(parts, file.size_bytes, file.part_size ?? MULTIPART_PART_SIZE_BYTES)) return false;
    try { await completeMultipartUpload({ key: file.source_key, uploadId: file.upload_id, parts }); }
    catch (error) { throw multipartCompletionError(error, file.filename); }
    verified = await verifyCompletedDirectUpload(file);
    await sql`update upload_session_files set completed_parts = ${sql.json(parts)} where id = ${file.id}`;
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
    ) update upload_session_files set status = 'completed', source_key = ${sourceKey}, updated_at = now()
      where id = ${file.id} and exists (select 1 from queued)
      returning id, source_key`;
    if (published.length !== 1 || published[0]?.id !== file.id || published[0]?.source_key !== sourceKey) {
      throw new ProjectIntakeError("Upload ownership changed during finalization", 409);
    }
    // The original stays writable until its URL expires; nothing reads it again. Best effort.
    await deleteUploadedObject(file.source_key).catch(() =>
      console.error(`[direct-upload] status=unsealed-delete-failed file=${file.id}`));
  } else {
    await sql`update upload_session_files set status = 'completed', source_key = ${sourceKey}, updated_at = now() where id = ${file.id}`;
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
    await copyUploadedObject({ fromKey: file.source_key, toKey: sealed, ifMatch: etag });
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

/** Resolves with whether every file of the session is now complete (the session can be confirmed). */
export async function completeDirectUploadFile(input: CompleteDirectUploadFileInput): Promise<{ allFilesCompleted: boolean }> {
  return await withDirectUploadLock(input.sessionId, async () => {
    const loaded = await loadDirectUploadSession(input.sessionId, input.userId);
    if (!loaded) throw new ProjectIntakeError("Upload session not found", 404);
    assertUploadSessionActive(loaded.session);
    if (["aborted", "failed"].includes(loaded.session.status)) throw new ProjectIntakeError("Upload session is closed", 409);
    const { assertSessionProjectStillContributable } = await import("./direct-session-idempotency.js");
    await assertSessionProjectStillContributable(loaded.session, input.userId);
    const file = loaded.files.find(item => item.id === input.fileId);
    if (!file) throw new ProjectIntakeError("Upload file not found", 404);
    if (!await finalizeDirectUploadFile(file, input.sizeBytes)) throw new ProjectIntakeError("Upload parts are incomplete or have incorrect sizes", 409);
    await sql`update upload_sessions set next_reconcile_at = now() where id = ${input.sessionId}`;
    return {
      allFilesCompleted: ["pending", "uploading"].includes(loaded.session.status)
        && loaded.files.every(item => item.id === file.id || item.status === "completed"),
    };
  });
}

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
  });
}

async function abortDirectUploadSessionUnlocked(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  if (!loaded) {
    return false;
  }

  if (loaded.session.status === "confirmed" || loaded.session.status === "ingesting") throw new ProjectIntakeError("Ingested uploads cannot be aborted", 409);

  await sql`
    update upload_session_files
    set status = 'aborted',
        updated_at = now()
    where session_id = ${sessionId}
  `;
  await sql`
    update upload_sessions
    set status = 'aborted',
        updated_at = now()
    where id = ${sessionId}
  `;

  await queueAbandonedDirectUploadCleanup(sessionId);
  // An aborted extract session has nothing to keep: its prefix is emptied on the next sweep.
  if (loaded.session.extract_id) {
    await sql`update extracts set expires_at = least(expires_at, now()), updated_at = now()
      where id = ${loaded.session.extract_id} and run_id is null and state = 'active'`;
  }
  return true;
}

export async function abortDirectUploadSession(sessionId: string, userId: string): Promise<boolean> {
  return withDirectUploadLock(sessionId, () => abortDirectUploadSessionUnlocked(sessionId, userId));
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
    metadata = await getUploadedObjectMetadata(file.source_key);
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
    where s.id = ${sessionId} and s.status in ('aborted', 'failed') and f.upload_id is not null`;
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
    where s.id = ${sessionId} and s.status in ('aborted', 'failed')
    group by s.id
    on conflict (kind, target) do update set artifact_uris = excluded.artifact_uris,
      not_before = greatest(storage_cleanup_queue.not_before, excluded.not_before)`;
}
