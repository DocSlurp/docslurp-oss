import { randomUUID } from "node:crypto";

import type { PipelineFeatureOverrides, WorkspaceTemplateKey } from "@docslurp/shared";

import { sql } from "../db.js";
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
  rawSourceKey,
  WorkspaceIntakeError,
  type IntakeExtract,
  type WorkspaceIntakeItem,
} from "./workspace-intake.js";

const SIGNED_UPLOAD_TTL_SECONDS = 900;
const MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;
const MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;

export interface DirectUploadSessionFileInput {
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  sha256?: string;
  canonicalId?: string | null;
  /** Request one signed PUT instead of multipart (maximum 5 GiB). */
  singlePart?: boolean;
  path?: string;
}

export interface CreateDirectUploadSessionInput {
  apiKeyId?: string | null;
  allowedWorkspaceIds?: readonly string[] | null;
  tags?: string[];
  userId: string;
  orgId?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  templateKey?: WorkspaceTemplateKey | null;
  /** Upload overrides, merged onto the target workspace pipeline at confirm. */
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
  result?: unknown;
  last_error?: string | null;
  api_key_id?: string | null;
  allowed_workspace_ids?: string[] | null;
  tags?: string[];
  extract_id?: string | null;
  id: string;
  user_id: string;
  org_id: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
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
};

export interface LoadedDirectUploadSession {
  session: UploadSessionRow;
  files: UploadSessionFileRow[];
}

export interface PreparedDirectUploadWorkspaceIntake {
  session: UploadSessionRow;
  items: WorkspaceIntakeItem[];
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
    select id, user_id, org_id, workspace_id, workspace_name, template_key, pipeline, tags, status, result, last_error, api_key_id, allowed_workspace_ids, extract_id
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
      unknown_size
    from upload_session_files
    where session_id = ${sessionId}
    order by created_at asc
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

export async function buildDirectUploadFileDescriptor(file: UploadSessionFileRow) {
  if (file.status === "completed" || file.status === "aborted") return { id: file.id, filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes, mode: file.upload_mode as "single" | "multipart", status: file.status };
  if (file.upload_mode === "single") {
    return {
      id: file.id,
      filename: file.filename,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      mode: "single" as const,
      status: file.status,
      method: "PUT" as const,
      headers: { "Content-Type": file.mime_type },
      expiresInSeconds: SIGNED_UPLOAD_TTL_SECONDS,
      putUrl: await signSingleUploadPut({
        key: file.source_key,
        contentType: file.mime_type,
        expiresInSeconds: SIGNED_UPLOAD_TTL_SECONDS,
      }),
    };
  }

  const partSize = file.part_size ?? MULTIPART_PART_SIZE_BYTES;
  const partCount = file.unknown_size ? 0 : toDirectUploadPartCount(file.size_bytes, partSize);
  if (!file.upload_id) {
    throw new Error(`Multipart session missing upload id for ${file.id}`);
  }
  const completed = new Set(
    (file.completed_parts ?? []).map((part) => part.partNumber),
  );
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
      }),
    });
  }

  return {
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
    completedParts: file.completed_parts ?? [],
  };
}

export async function createDirectUploadSession(input: CreateDirectUploadSessionInput) {
  if (input.files.some(file => file.singlePart && (file.sizeBytes === undefined || file.sizeBytes > 5 * 1024 ** 3))) {
    throw new WorkspaceIntakeError("Single-part uploads cannot exceed 5 GiB", 400);
  }
  // Workspace Intake's policy screens declared files before any upload target exists.
  const files = input.files.map((file) => ({
    ...file,
    unknownSize: file.sizeBytes === undefined,
    sizeBytes: file.sizeBytes ?? 0,
    ...admitIntakeFile(
      { filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes ?? 0 },
      "direct-upload",
    ),
  }));

  const sessionId = randomUUID();
  await sql`
    insert into upload_sessions (
      id,
      user_id,
      org_id,
      workspace_id,
      workspace_name,
      template_key,
      pipeline,
      tags,
      api_key_id,
      allowed_workspace_ids,
      extract_id,
      status
    )
    values (
      ${sessionId},
      ${input.userId},
      ${input.orgId ?? null},
      ${input.workspaceId ?? null},
      ${input.workspaceName ?? null},
      ${input.templateKey ?? null},
      ${sql.json(JSON.parse(JSON.stringify(input.pipeline)))},
      ${sql.array(input.tags ?? [])},
      ${input.apiKeyId ?? null},
      ${input.allowedWorkspaceIds ? sql.array([...input.allowedWorkspaceIds]) : null},
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
        unknown_size
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
        ${file.unknownSize}
      )
    `;
  }

  await sql`update upload_sessions set status = 'pending', next_reconcile_at = now() where id = ${sessionId}`;
  const loaded = await loadDirectUploadSession(sessionId, input.userId);
  if (!loaded) {
    throw new WorkspaceIntakeError("Upload session not found", 404);
  }
  return await describeDirectUploadSession(loaded);
}

export async function describeDirectUploadSession(
  loaded: LoadedDirectUploadSession,
  statusOnly = false,
) {
  const files = await Promise.all(
    loaded.files.map(async (file) => statusOnly || ["confirmed", "failed", "aborted"].includes(loaded.session.status) ? { id: file.id, filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes, mode: file.upload_mode as "single" | "multipart", status: file.status } : await buildDirectUploadFileDescriptor(file)),
  );
  return {
    sessionId: loaded.session.id,
    status: loaded.session.status,
    result: (loaded.session.result as { payload?: unknown } | null)?.payload ?? null,
    error: loaded.session.last_error ?? null,
    files,
  };
}

/** A native key may only operate on sessions created in its organization. */
export async function directUploadSessionBelongsToOrganization(sessionId: string, userId: string, orgId: string, allowedWorkspaceIds?: readonly string[] | null): Promise<boolean> {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  return loaded?.session.org_id === orgId && (!allowedWorkspaceIds?.length || Boolean(loaded.session.workspace_id && allowedWorkspaceIds.includes(loaded.session.workspace_id)));
}

export async function getDirectUploadSessionDescription(
  sessionId: string,
  userId: string,
  statusOnly = false,
) {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  return loaded ? await describeDirectUploadSession(loaded, statusOnly) : null;
}

/** Cross-process serialization: the dedicated connection owns the lock until release. */
export async function withDirectUploadLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const { connection, release } = await reserveDirectUploadLockConnection();
  try {
    const [lock] = await connection`select pg_try_advisory_lock(hashtextextended(${`upload:${sessionId}`}, 0)) as acquired`;
    if (!lock?.acquired) throw new WorkspaceIntakeError("Upload session is being finalized; retry shortly", 409);
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
    if (!file.unknown_size && finalSize !== file.size_bytes) throw new WorkspaceIntakeError("Declared upload size cannot change", 400);
    admitIntakeFile({ filename: file.filename, mimeType: file.mime_type, sizeBytes: finalSize }, "direct-upload");
    file = { ...file, size_bytes: finalSize };
    // Persist EOS before provider completion so recovery can verify an already assembled object.
    await sql`update upload_session_files set size_bytes = ${finalSize}, unknown_size = false where id = ${file.id}`;
  }
  let verified: { etag: string | null };
  try {
    verified = await verifyCompletedDirectUpload(file);
  } catch (error) {
    if (!isStorageNotFound(error) && !(error instanceof WorkspaceIntakeError && error.message.startsWith("No object found"))) throw error;
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
      throw new WorkspaceIntakeError("Upload ownership changed during finalization", 409);
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
  if (!etag) throw new WorkspaceIntakeError(`Unable to verify the uploaded version of ${file.filename}`, 400);
  const sealed = sealedSourceKey(file);
  try {
    await copyUploadedObject({ fromKey: file.source_key, toKey: sealed, ifMatch: etag });
  } catch (error) {
    if (storageErrorName(error) === "PreconditionFailed" || (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412) {
      throw new WorkspaceIntakeError(`${file.filename} changed while its upload was being completed; upload it again`, 409);
    }
    throw error;
  }
  // The sealed copy is what is hashed and ingested: check it is the verified size too.
  await verifyCompletedDirectUpload({ ...file, source_key: sealed });
  return sealed;
}

export async function completeDirectUploadFile(input: CompleteDirectUploadFileInput) {
  await withDirectUploadLock(input.sessionId, async () => {
    const loaded = await loadDirectUploadSession(input.sessionId, input.userId);
    if (!loaded) throw new WorkspaceIntakeError("Upload session not found", 404);
    if (["aborted", "failed"].includes(loaded.session.status)) throw new WorkspaceIntakeError("Upload session is closed", 409);
    const file = loaded.files.find(item => item.id === input.fileId);
    if (!file) throw new WorkspaceIntakeError("Upload file not found", 404);
    if (!await finalizeDirectUploadFile(file, input.sizeBytes)) throw new WorkspaceIntakeError("Upload parts are incomplete or have incorrect sizes", 409);
    await sql`update upload_sessions set next_reconcile_at = now() where id = ${input.sessionId}`;
  });
}

export async function signDirectUploadParts(sessionId: string, userId: string, fileId: string, partNumbers: number[]) {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  if (!loaded) throw new WorkspaceIntakeError("Upload session not found", 404);
  if (!["pending", "uploading"].includes(loaded.session.status)) throw new WorkspaceIntakeError("Upload session is closed", 409);
  const file = loaded.files.find(item => item.id === fileId);
  if (!file || file.status !== "pending" || !file.upload_id) throw new WorkspaceIntakeError("Open multipart file not found", 404);
  return { parts: await Promise.all(partNumbers.map(async partNumber => {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || partNumber > Math.max(1, Math.ceil(env.maxUploadBytes / (file.part_size ?? MULTIPART_PART_SIZE_BYTES))) || (!file.unknown_size && partNumber > toDirectUploadPartCount(file.size_bytes, file.part_size ?? MULTIPART_PART_SIZE_BYTES))) throw new WorkspaceIntakeError("Invalid part number", 400);
    return { partNumber, url: await signMultipartUploadPart({ key: file.source_key, uploadId: file.upload_id!, partNumber }) };
  })) };
}

async function abortDirectUploadSessionUnlocked(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  if (!loaded) {
    return false;
  }

  if (loaded.session.status === "confirmed" || loaded.session.status === "ingesting") throw new WorkspaceIntakeError("Ingested uploads cannot be aborted", 409);

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
    throw new WorkspaceIntakeError(
      "Upload session is already confirmed",
      409,
    );
  }

  if (["aborted", "failed"].includes(loaded.session.status)) {
    throw new WorkspaceIntakeError("Upload session has been aborted", 409);
  }

  if (loaded.files.length === 0) {
    throw new WorkspaceIntakeError("Upload session has no files", 400);
  }
}

export async function prepareDirectUploadWorkspaceIntake(
  sessionId: string,
  userId: string,
): Promise<PreparedDirectUploadWorkspaceIntake> {
  const loaded = await loadDirectUploadSession(sessionId, userId);
  if (!loaded) {
    throw new WorkspaceIntakeError("Upload session not found", 404);
  }

  assertDirectUploadSessionReadyForIntake(loaded);

  return {
    session: loaded.session,
    items: directUploadIntakeItems(loaded),
  };
}

export async function markDirectUploadSessionConfirmed(args: {
  sessionId: string;
  workspaceId: string;
  orgId: string;
}): Promise<void> {
  await sql`
    update upload_sessions
    set status = 'confirmed',
        workspace_id = ${args.workspaceId},
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
): WorkspaceIntakeItem[] {
  return loaded.files.map((file) => ({
    filename: file.filename,
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    canonicalId: file.canonical_id ?? null,
    path: file.source_path ?? "",
    content: file.status === "completed"
      ? { storedKey: file.source_key, verifiedSizeBytes: file.size_bytes }
      : { rejected: new WorkspaceIntakeError(`${file.filename} did not finish uploading`, 409) },
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
      throw new WorkspaceIntakeError(
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
    throw new WorkspaceIntakeError(`Unable to verify upload size for ${file.filename}`, 400);
  }
  admitIntakeFile(
    { filename: file.filename, mimeType: file.mime_type, sizeBytes: actualSize },
    "direct-upload",
  );
  if (actualSize !== file.size_bytes) {
    throw new WorkspaceIntakeError(
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
  return name === "NotFound" || name === "NoSuchKey" || (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
}

/** Maps S3 CompleteMultipartUpload failures to a specific, secret-free 400. Unknown errors rethrow. */
function multipartCompletionError(error: unknown, filename: string): unknown {
  switch (storageErrorName(error)) {
    case "InvalidPart":
      return new WorkspaceIntakeError(`Multipart completion for ${filename} failed: a part is missing or its etag does not match the uploaded part (InvalidPart)`, 400);
    case "InvalidPartOrder":
      return new WorkspaceIntakeError(`Multipart completion for ${filename} failed: parts must be in ascending partNumber order (InvalidPartOrder)`, 400);
    case "EntityTooSmall":
      return new WorkspaceIntakeError(`Multipart completion for ${filename} failed: a non-final part is smaller than the storage provider's minimum part size (EntityTooSmall)`, 400);
    case "NoSuchUpload":
      return new WorkspaceIntakeError(`Multipart upload for ${filename} is no longer open (expired, aborted or already completed); create a new upload session`, 400);
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
      jsonb_build_object('workspaceId', s.workspace_id), array_agg(f.source_key), 'abandoned_upload', now() + interval '16 minutes'
    from upload_sessions s join upload_session_files f on f.session_id = s.id
    where s.id = ${sessionId} and s.status in ('aborted', 'failed')
    group by s.id
    on conflict (kind, target) do update set artifact_uris = excluded.artifact_uris,
      not_before = greatest(storage_cleanup_queue.not_before, excluded.not_before)`;
}
