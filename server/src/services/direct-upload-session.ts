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
  type RawFileRow = Omit<UploadSessionFileRow, "size_bytes" | "part_size"> & { size_bytes: number | string; part_size: number | string | null };
  const rows = fileIds
    ? await sql<RawFileRow[]>`
      select id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status,
        completed_parts, canonical_id, source_path, unknown_size, request_index, client_id, content_identity
      from upload_session_files
      where session_id = ${sessionId} and id = any(${sql.array([...fileIds])})
      order by request_index asc nulls last, created_at asc`
    : await sql<RawFileRow[]>`
      select id, session_id, filename, mime_type, size_bytes, source_key, upload_mode, upload_id, part_size, status,
        completed_parts, canonical_id, source_path, unknown_size, request_index, client_id, content_identity
      from upload_session_files
      where session_id = ${sessionId}
      order by request_index asc nulls last, created_at asc`;

  // PostgreSQL bigint columns arrive as strings; browser file matching and
  // storage size verification require numbers on both sides of the comparison.
  return rows.map((file) => ({
    ...file,
    size_bytes: Number(file.size_bytes),
    part_size: file.part_size === null ? null : Number(file.part_size),
  }));
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

/** Provider multipart uploads a session create opens at once. */
const SESSION_UPLOAD_CREATE_CONCURRENCY = 8;

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

  // Provider multipart uploads are created a few at a time with per-call deadlines, never under a lock (this runs
  // outside the Idempotency-Key lock too). Single-PUT files need no provider call at all.
  const plans = files.map(file => {
    const isMultipart = file.unknownSize || (!file.singlePart && file.sizeBytes >= MULTIPART_THRESHOLD_BYTES);
    return { file, sourceKey: rawSourceKey(input.userId, file.filename, input.extract), isMultipart, partSize: isMultipart ? MULTIPART_PART_SIZE_BYTES : null };
  });
  const opened = await settleBounded(plans, SESSION_UPLOAD_CREATE_CONCURRENCY,
    plan => plan.isMultipart ? withStorageRetry(() => createMultipartUpload(plan.sourceKey, plan.file.mimeType)) : Promise.resolve(null));
  const failed = opened.find(result => result.status === "rejected");
  if (failed) {
    // Nothing of this session is usable: close the uploads that were opened, then fail as before.
    const openedIds = opened.flatMap((result, i) => result.status === "fulfilled" && result.value ? [{ key: plans[i]!.sourceKey, uploadId: result.value }] : []);
    await settleBounded(openedIds, MULTIPART_ABORT_CONCURRENCY, upload => abortMultipartUpload(upload).catch(() => undefined));
    throw (failed as PromiseRejectedResult).reason;
  }
  for (const [i, plan] of plans.entries()) {
    const { file, sourceKey, isMultipart, partSize } = plan;
    const uploadId = (opened[i] as PromiseFulfilledResult<string | null>).value;
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
  };
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
  const owned = await loadDirectUploadSessionRow(sessionId, userId);
  if (!owned) return null;
  return withDirectUploadLock(sessionId, async () => {
    let loaded = await loadDirectUploadSession(sessionId, userId);
    if (!loaded) return null;
    if (loaded.session.status === "confirmed") return describeDirectUploadSession(loaded, true);
    assertUploadSessionActive(loaded.session);
    const { assertSessionProjectStillContributable } = await import("./direct-session-idempotency.js");
    await assertSessionProjectStillContributable(loaded.session, userId);
    // Inspect all final objects before authorizing any retry. An outage is not absence.
    try {
      const open = loaded.files.filter(file => file.status === "pending" && !file.unknown_size);
      const budget = lockHoldBudget(signal);
      const inspected = await settleBounded(open, env.directUploadFinalizeConcurrency, async file => {
        let exists = false;
        try { await withStorageRetry(() => getUploadedObjectMetadata(file.source_key, budget.signal), undefined, budget.signal); exists = true; }
        catch (error) { if (!isStorageNotFound(error)) throw error; }
        if (exists) await finalizeDirectUploadFile(file, undefined, { signal: budget.signal });
      }, { shouldStart: budget.shouldStart });
      // Every file is inspected before any failure is reported; the first failure (in file order) decides the answer.
      // A file this hold did not reach was not inspected: no URL is signed for it, so the answer is "retry later" (the
      // files that were reached keep their progress).
      const failure = inspected.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      loaded = (await loadDirectUploadSession(sessionId, userId))!;
      return await describeDirectUploadSession(loaded);
    } catch (error) {
      if (error instanceof ProjectIntakeError && error.code === "intake_reconciliation_required") throw error;
      throw new ProjectIntakeError("Upload storage evidence is unavailable; retry status later", 503, undefined, "upload_storage_unavailable");
    }
  }, undefined, undefined, { lockClass: "batch", tenant: lockTenant(owned.org_id, userId) });
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
  /** The tenant the holder counts against (`lockTenant`); required for every class but `reconcile`. */
  tenant?: string;
}

/** The lock-accounting tenant of a stored session or principal: its organization, else its user. Never a request field. */
export function lockTenant(orgId: string | null | undefined, userId: string): string {
  return orgId ? `org:${orgId}` : `user:${userId}`;
}

/**
 * The lock-accounting tenant of a request's principal, from stored rows: the API key's organization, else the user's
 * organization membership (one per user), else the user. A request's own `orgId` field is never trusted for it.
 */
export async function principalLockTenant(userId: string, apiKeyId?: string | null): Promise<string> {
  const [row] = apiKeyId
    ? await sql<Array<{ org_id: string | null }>>`select org_id from api_keys where id = ${apiKeyId} and user_id = ${userId} limit 1`
    : await sql<Array<{ org_id: string | null }>>`select org_id from org_memberships where user_id = ${userId} order by created_at, org_id limit 1`;
  return lockTenant(row?.org_id ?? null, userId);
}

/**
 * Cross-process serialization: the dedicated connection owns the lock until release. A held lock answers 409
 * `upload_session_busy` at once, or after `waitMs` of retries; so does a saturated lock pool, on the caller's deadline.
 * A waiting caller releases its lock connection between tries: the pool must stay free for the holder and other sessions.
 */
export async function withDirectUploadLock<T>(sessionId: string, run: () => Promise<T>, busyMessage: string | undefined, busyCode: ProjectIntakeErrorCode | undefined, options: DirectUploadLockOptions): Promise<T> {
  busyMessage ??= "Upload session is being finalized; retry shortly";
  busyCode ??= "upload_session_busy";
  const waitMs = Math.max(0, options.waitMs ?? 0);
  // A caller that states its wait gets exactly that deadline, for the slot, the connection and every retry; one that
  // does not waits the lock library's short default for a slot and a connection, then answers busy.
  const deadline = Date.now() + waitMs;
  for (;;) {
    let reserved: Awaited<ReturnType<typeof reserveDirectUploadLockConnection>>;
    try {
      reserved = await reserveDirectUploadLockConnection({ lockClass: options.lockClass, tenant: options.tenant, ...(waitMs > 0 ? { deadline } : {}) });
    } catch (error) {
      if (error instanceof DirectUploadLockUnavailable) throw new ProjectIntakeError(busyMessage, 409, undefined, busyCode);
      throw error;
    }
    const { connection, release } = reserved;
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
  console.error(`[direct-upload] status=storage-unavailable ${context}`, error instanceof Error ? error.name : "unknown", isTransientStorageError(error) ? "transient" : "other");
  return new ProjectIntakeError("Upload storage is temporarily unavailable; retry shortly", 503, undefined, "upload_storage_unavailable");
}

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
  if (file.status === "completed") return true;
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
    const published = await sql<{ id: string }[]>`update upload_session_files set status = 'completed', updated_at = now()
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
    ) update upload_session_files set status = 'completed', source_key = ${sourceKey}, updated_at = now()
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
  return current?.status === "completed";
}

/**
 * After a fenced publish matched nothing: true when this same version was already published (an identical attempt won),
 * else 409. A losing sealed copy of another version is queued for cleanup once a winner is known, never before (an
 * identical attempt may still be about to publish it).
 */
async function alreadyPublishedAs(file: UploadSessionFileRow, attemptedKey: string): Promise<boolean> {
  const [current] = await sql<Array<{ status: string; source_key: string; org_id: string | null }>>`
    select f.status, f.source_key, s.org_id from upload_session_files f join upload_sessions s on s.id = f.session_id where f.id = ${file.id}`;
  if (current?.status === "completed" && current.source_key === attemptedKey) return true;
  if (current?.status === "completed" && attemptedKey !== file.source_key && current.source_key !== attemptedKey) {
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
 * - `blocksSession`: left as is, this file makes the reconciler fail the whole session once the client stops
 *   finalizing (its stored bytes are refused); repair it or abort the session.
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
  // Mirrors the reconciler's terminal rule (a 4xx other than 409) for what it meets on its own: an absent object is
  // only "not yet", and an unknown file or a changed declared size never reaches it.
  const blocksSession = error.statusCode < 500 && error.statusCode !== 409 && error.statusCode !== 404
    && !error.message.startsWith("No object found") && error.message !== DECLARED_SIZE_CHANGE_MESSAGE;
  return { statusCode: error.statusCode, code, message: error.message, retryable, action: retryable ? "retry" : reupload ? "reupload" : "none", blocksSession };
}

type FinalizeOutcome = { fileId: string; completed: true } | { fileId: string; completed: false; error: unknown };

/**
 * Finalizes the named files of one session under ONE hold of its lock, at most `directUploadFinalizeConcurrency` at a
 * time. Session-level problems (not found, closed, expired, a revoked share, a held lock) throw before any file is
 * touched. Each file is looked up in this caller's session only (an id from another session or user is "not found"),
 * and a file is completed only through `finalizeDirectUploadFile`: verified size, sealed by an If-Match copy or a
 * storage-validated multipart assembly, re-admitted by intake policy. A file's failure never affects the others.
 */
async function finalizeSessionFiles(sessionId: string, userId: string, entries: readonly CompleteDirectUploadFileEntry[], options: { signal?: AbortSignal } = {}): Promise<{ outcomes: FinalizeOutcome[]; sessionComplete: boolean }> {
  if (entries.length < 1 || entries.length > MAX_DIRECT_UPLOAD_COMPLETE_BATCH) {
    throw new ProjectIntakeError(`Complete between 1 and ${MAX_DIRECT_UPLOAD_COMPLETE_BATCH} files per request`, 400);
  }
  // Two finalizers on one file would race the sealing copy and the completion write.
  if (new Set(entries.map(entry => entry.fileId)).size !== entries.length) throw new ProjectIntakeError("Each fileId may appear once per request", 400);
  // Only the session row and the named files: per-call work must not grow with the session (a 1,000-file session is
  // completed in 10+ calls, and loading every row on each made the whole upload quadratic).
  const owned = await loadDirectUploadSessionRow(sessionId, userId);
  if (!owned) throw new ProjectIntakeError("Upload session not found", 404);
  assertUploadSessionActive(owned);
  if (["aborted", "failed"].includes(owned.status)) throw new ProjectIntakeError("Upload session is closed", 409);
  // This client is finalizing: hold the reconciler off before taking the lock, so a sweep does not take it between this
  // client's calls. Only the first call opens a hold; later ones extend it only on new progress (below), up to a cap.
  if (["pending", "uploading"].includes(owned.status)) {
    await sql`update upload_sessions set client_finalizing_since = now(),
      client_finalizing_until = now() + ${CLIENT_FINALIZING_HOLD_SECONDS}::int * interval '1 second'
      where id = ${sessionId} and user_id = ${userId} and status in ('pending', 'uploading') and client_finalizing_since is null`;
  }
  return withDirectUploadLock(sessionId, async () => {
    // Re-check under the lock: the session may have closed meanwhile.
    const session = await loadDirectUploadSessionRow(sessionId, userId);
    if (!session) throw new ProjectIntakeError("Upload session not found", 404);
    assertUploadSessionActive(session);
    if (["aborted", "failed"].includes(session.status)) throw new ProjectIntakeError("Upload session is closed", 409);
    const targeted = await loadDirectUploadSessionFiles(sessionId, entries.map(entry => entry.fileId));
    const { assertSessionProjectStillContributable } = await import("./direct-session-idempotency.js");
    await assertSessionProjectStillContributable(session, userId);
    const byId = new Map(targeted.map(file => [file.id, file]));
    const budget = lockHoldBudget(options.signal);
    const settled = await settleBounded(entries, env.directUploadFinalizeConcurrency, async entry => {
      const file = byId.get(entry.fileId);
      if (!file) throw new ProjectIntakeError("Upload file not found", 404);
      if (!await finalizeDirectUploadFile(file, entry.sizeBytes, { signal: budget.signal })) throw new ProjectIntakeError(PARTS_INCOMPLETE_MESSAGE, 409);
    }, { shouldStart: budget.shouldStart });
    const outcomes = settled.map((result, i): FinalizeOutcome => result.status === "fulfilled"
      ? { fileId: entries[i]!.fileId, completed: true }
      : { fileId: entries[i]!.fileId, completed: false, error: result.reason === NOT_STARTED ? notStartedError() : result.reason });
    const progressed = outcomes.some(outcome => outcome.completed && byId.get(outcome.fileId)?.status !== "completed");
    // Stops at the first open file, so it is cheap while the session is still filling; the lock keeps it current.
    const [open] = await sql<Array<{ open: boolean }>>`select exists (select 1 from upload_session_files where session_id = ${sessionId} and status <> 'completed') as open`;
    const sessionComplete = open?.open === false;
    if (sessionComplete) {
      // Every file ready: release the hold; ingestion starts at once (the route's kick, else the next sweep).
      await sql`update upload_sessions set next_reconcile_at = now(), client_finalizing_until = null, client_finalizing_since = null where id = ${sessionId}`;
    } else if (progressed && ["pending", "uploading"].includes(session.status)) {
      // New progress persisted: extend the hold, never beyond the cap from when the hold began.
      await sql`update upload_sessions set client_finalizing_until = least(
          now() + ${CLIENT_FINALIZING_HOLD_SECONDS}::int * interval '1 second',
          coalesce(client_finalizing_since, now()) + ${CLIENT_FINALIZING_MAX_HOLD_SECONDS}::int * interval '1 second')
        where id = ${sessionId} and status in ('pending', 'uploading')`;
    }
    return { outcomes, sessionComplete };
  }, undefined, undefined, { lockClass: "batch", tenant: lockTenant(owned.org_id, userId) });
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

/** How long part signing may spend on provider reads while it holds a short lock connection. */
export const SIGN_PROVIDER_BUDGET_MS = 2_000;

export async function signDirectUploadParts(sessionId: string, userId: string, fileId: string, partNumbers: number[]) {
  const owned = await loadDirectUploadSessionRow(sessionId, userId);
  if (!owned) throw new ProjectIntakeError("Upload session not found", 404);
  return withDirectUploadLock(sessionId, async () => {
  const session = await loadDirectUploadSessionRow(sessionId, userId);
  if (!session) throw new ProjectIntakeError("Upload session not found", 404);
  assertUploadSessionActive(session);
  const { assertSessionProjectStillContributable } = await import("./direct-session-idempotency.js");
  await assertSessionProjectStillContributable(session, userId);
  if (!["pending", "uploading"].includes(session.status)) throw new ProjectIntakeError("Upload session is closed", 409);
  const [file] = await loadDirectUploadSessionFiles(sessionId, [fileId]);
  if (!file || file.status !== "pending" || !file.upload_id) throw new ProjectIntakeError("Open multipart file not found", 404);
  // Short work: the provider reads below share one tight budget, so a stalled provider cannot hold this connection.
  const signal = AbortSignal.timeout(SIGN_PROVIDER_BUDGET_MS);
  try {
    await getUploadedObjectMetadata(file.source_key, signal);
    // A completed object closes the transfer; completion will seal it without another PUT.
    throw new ProjectIntakeError("Upload object already exists; refresh session", 409);
  } catch (error) {
    if (!isStorageNotFound(error)) {
      if (error instanceof ProjectIntakeError) throw error;
      throw new ProjectIntakeError("Upload storage evidence is unavailable", 503, undefined, "upload_storage_unavailable");
    }
  }
  try { await listMultipartUploadParts({ key: file.source_key, uploadId: file.upload_id, signal }); }
  catch { throw new ProjectIntakeError("Upload storage evidence is unavailable", 503, undefined, "upload_storage_unavailable"); }
  return { parts: await Promise.all(partNumbers.map(async partNumber => {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || partNumber > Math.max(1, Math.ceil(env.maxUploadBytes / (file.part_size ?? MULTIPART_PART_SIZE_BYTES))) || (!file.unknown_size && partNumber > toDirectUploadPartCount(file.size_bytes, file.part_size ?? MULTIPART_PART_SIZE_BYTES))) throw new ProjectIntakeError("Invalid part number", 400);
    return { partNumber, url: await signMultipartUploadPart({ key: file.source_key, uploadId: file.upload_id!, partNumber, expiresInSeconds: assertUploadSessionActive(session) }) };
  })) };
  }, undefined, undefined, { tenant: lockTenant(owned.org_id, userId) });
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

/** `lockWaitMs`: how long to wait out a reconciler pass or another request holding the session (0: answer busy at once). */
/**
 * Aborts a session. Under the lock it only marks the session and its files aborted and records the cleanup (fast,
 * database only); the provider's multipart aborts run afterwards outside any lock (abortAbandonedMultipartUploads),
 * and the reconciler's sweep finishes any it could not.
 */
export async function abortDirectUploadSession(sessionId: string, userId: string, lockWaitMs = 0): Promise<boolean> {
  const owned = await loadDirectUploadSessionRow(sessionId, userId);
  if (!owned) return false;
  const aborted = await withDirectUploadLock(sessionId, () => abortDirectUploadSessionUnlocked(sessionId, userId), undefined, undefined,
    { waitMs: lockWaitMs, tenant: lockTenant(owned.org_id, userId) });
  if (aborted) {
    void abortAbandonedMultipartUploads({ sessionId }).catch(error =>
      console.error(`[upload-cleanup] multipart aborts deferred to the sweep session=${sessionId}`, error instanceof Error ? error.name : "unknown"));
  }
  return aborted;
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

/**
 * Records an aborted or failed session's cleanup; database only, so it may run under the session lock. Its open
 * multipart uploads are left for abortAbandonedMultipartUploads (they are the files with an upload id and no
 * multipart_aborted_at). Raw objects are deleted by the storage cleanup queue after outstanding signed PUTs expire.
 */
export async function queueAbandonedDirectUploadCleanup(sessionId: string): Promise<void> {
  await sql`insert into storage_cleanup_queue (kind, org_id, target, payload, artifact_uris, reason, not_before)
    select 'storage_prefix', coalesce(s.org_id, ''), s.user_id || '/' || s.id || '/',
      jsonb_build_object('projectId', s.project_id), array_agg(f.source_key), 'abandoned_upload', now() + interval '16 minutes'
    from upload_sessions s join upload_session_files f on f.session_id = s.id
    where s.id = ${sessionId} and s.status in ('aborted', 'failed')
    group by s.id
    on conflict (kind, target) do update set artifact_uris = excluded.artifact_uris,
      not_before = greatest(storage_cleanup_queue.not_before, excluded.not_before)`;
}

/** At most this many provider multipart aborts run at once. */
const MULTIPART_ABORT_CONCURRENCY = 4;

/**
 * Aborts the open multipart uploads of aborted and failed sessions (one session, or a bounded batch of any), never
 * under a session lock: bounded concurrency, a per-call deadline, and a durable mark per file. An abort that fails is
 * left unmarked for the reconciler's next sweep; NoSuchUpload (assembled or already aborted) counts as done.
 */
export async function abortAbandonedMultipartUploads(options: { sessionId?: string; limit?: number } = {}): Promise<number> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const files = options.sessionId
    ? await sql<Array<{ id: string; source_key: string; upload_id: string }>>`
      select f.id, f.source_key, f.upload_id from upload_session_files f join upload_sessions s on s.id = f.session_id
      where s.id = ${options.sessionId} and s.status in ('aborted', 'failed') and f.upload_id is not null and f.multipart_aborted_at is null
      limit ${limit}`
    : await sql<Array<{ id: string; source_key: string; upload_id: string }>>`
      select f.id, f.source_key, f.upload_id from upload_session_files f join upload_sessions s on s.id = f.session_id
      where s.status in ('aborted', 'failed') and f.upload_id is not null and f.multipart_aborted_at is null
      limit ${limit}`;
  let done = 0;
  await settleBounded(files, MULTIPART_ABORT_CONCURRENCY, async file => {
    try {
      await abortMultipartUpload({ key: file.source_key, uploadId: file.upload_id });
    } catch (error) {
      if (storageErrorName(error) !== "NoSuchUpload") {
        console.error(`[upload-cleanup] multipart abort failed file=${file.id}`, error instanceof Error ? error.name : "unknown");
        return;
      }
    }
    await sql`update upload_session_files set multipart_aborted_at = now() where id = ${file.id}`;
    done += 1;
  });
  return done;
}
