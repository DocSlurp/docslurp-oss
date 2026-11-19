import { createHash, randomUUID } from "node:crypto";

import type { RunOrigin, UploadSessionProgress } from "@docslurp/shared";
import { estimateRunEta, observedPagesPerMinute } from "@docslurp/shared";
import type { PipelineFeatureOverrides, ProjectTemplateKey } from "@docslurp/shared";

import { sql } from "../db.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { notePrediction } from "./run-activity-summary.js";
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
import { MAX_SINGLE_PUT_BYTES, MAX_URL_TTL_SECONDS, partSizeAt, planDirectUpload } from "../lib/upload-transfer-policy.js";
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

/** Lifetime of one signed PUT or part URL, never longer than its session (UPLOAD_URL_TTL_SECONDS, default 3 h). */
export const SIGNED_UPLOAD_TTL_SECONDS = env.uploadTransfer.urlTtlSeconds;
/** Part size recorded before part sizes were stored per file. Every current row stores its own. */
const LEGACY_PART_SIZE_BYTES = 8 * 1024 * 1024;

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
    && part.sizeBytes === partSizeAt(part.partNumber, file.size_bytes, partSize));
}

/** The most multipart part URLs one session description signs; the bounded parts/sign endpoint signs the rest. */
export const MAX_PART_URLS_PER_READ = 1_000;
type PartUrlBudget = { remaining: number; signal?: AbortSignal };

export async function buildDirectUploadFileDescriptor(file: UploadSessionFileRow, ttl = SIGNED_UPLOAD_TTL_SECONDS, expiresAt?: Date | string, options: { uninspected?: boolean; partUrls?: PartUrlBudget } = {}) {
  // Not inspected by this read: no provider call (every part is offered again), and the client is told so.
  const inspection = options.uninspected ? { inspected: false as const } : {};
  const remainingTtl = () => expiresAt ? assertUploadSessionActive({ status: "pending", expires_at: expiresAt } as UploadSessionRow) : ttl;
  if (file.status === "completed" || file.status === "aborted") return { transferState: file.status === "completed" ? "complete" as const : "unavailable" as const, verifiedBytes: file.status === "completed" ? file.size_bytes : null, ...fileRef(file), id: file.id, filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes, mode: file.upload_mode as "single" | "multipart", status: file.status };
  if (file.upload_mode === "single") {
    return {
      ...fileRef(file),
      ...inspection,
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
        contentLength: file.size_bytes,
        expiresInSeconds: remainingTtl(),
      }),
    };
  }

  const partSize = file.part_size ?? LEGACY_PART_SIZE_BYTES;
  const partCount = file.unknown_size ? 0 : toDirectUploadPartCount(file.size_bytes, partSize);
  if (!file.upload_id) {
    throw new Error(`Multipart session missing upload id for ${file.id}`);
  }
  // Storage is authoritative for which parts arrived: a client that lost a connection resumes from these pendingParts
  // instead of re-sending the whole file. A part counts only at its exact expected size.
  if (options.uninspected) {
    // Not inspected: no part list and no part URLs. The client completes the file first (its object may already be
    // assembled) and reads it with ?fileId= for its parts only if the object is reported missing.
    return {
      ...fileRef(file), ...inspection, id: file.id, filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes,
      mode: "multipart" as const, status: file.status, uploadId: file.upload_id, partSize, partCount, unknownSize: Boolean(file.unknown_size),
      transferState: "unknown" as const, verifiedBytes: null,
    };
  }
  const stored = file.unknown_size ? [] : await storedPartsAtExpectedSize(file, partSize, partCount);
  const completed = new Set(stored.map((part) => part.partNumber));
  const pendingParts: Array<{
    partNumber: number;
    sizeBytes: number;
    /** Absent once the read's part-URL budget is spent: sign it with parts/sign. */
    url?: string;
  }> = [];
  let partUrlsOmitted = false;

  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    if (completed.has(partNumber)) {
      continue;
    }
    const sizeBytes = partSizeAt(partNumber, file.size_bytes, partSize);
    const budget = options.partUrls;
    if (budget && (budget.remaining <= 0 || budget.signal?.aborted)) {
      partUrlsOmitted = true;
      pendingParts.push({ partNumber, sizeBytes });
      continue;
    }
    if (budget) budget.remaining -= 1;
    pendingParts.push({
      partNumber,
      sizeBytes,
      // Bound to the part's exact size: storage refuses any other body length.
      url: await signMultipartUploadPart({
        key: file.source_key,
        uploadId: file.upload_id,
        partNumber,
        contentLength: sizeBytes,
        expiresInSeconds: remainingTtl(),
      }),
    });
  }

  return {
    ...fileRef(file),
    ...inspection,
    id: file.id,
    filename: file.filename,
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    mode: "multipart" as const,
    status: file.status,
    ...(partUrlsOmitted ? { partUrlsOmitted: true as const } : {}),
    uploadId: file.upload_id,
    partSize,
    partCount,
    unknownSize: Boolean(file.unknown_size),
    pendingParts,
    completedParts: stored,
    transferState: file.unknown_size || stored.length ? "incomplete" as const : "missing" as const,
    verifiedBytes: file.unknown_size ? null : stored.reduce((sum, part) => sum + partSizeAt(part.partNumber, file.size_bytes, partSize), 0),
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
      if (file.singlePart && (file.sizeBytes === undefined || file.sizeBytes > MAX_SINGLE_PUT_BYTES)) {
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
  const plans = files.map(file => ({
    file,
    sourceKey: rawSourceKey(input.userId, file.filename, input.extract),
    ...planDirectUpload({ sizeBytes: file.unknownSize ? undefined : file.sizeBytes, singlePart: file.singlePart }, env.uploadTransfer),
  }));
  // The creating credential is checked immediately before each multipart initialization (retries included), so a key
  // revoked during setup opens no further provider upload.
  const target = { org_id: input.orgId ?? null, project_id: input.projectId ?? null };
  const opened = await settleBounded(plans, SESSION_UPLOAD_CREATE_CONCURRENCY,
    plan => plan.mode === "multipart" ? withStorageRetry(async () => {
      await assertCredentialStillPermits(target, input.apiKeyId);
      return await createMultipartUpload(plan.sourceKey, plan.file.mimeType);
    }) : Promise.resolve(null));
  const openedIds = opened.flatMap((result, i) => result.status === "fulfilled" && result.value ? [{ key: plans[i]!.sourceKey, uploadId: result.value }] : []);
  const closeOpened = () => settleBounded(openedIds, MULTIPART_ABORT_CONCURRENCY, upload => abortMultipartUpload(upload).catch(() => undefined));
  const failed = opened.find(result => result.status === "rejected");
  if (failed) {
    // Nothing of this session is usable: close the uploads that were opened, then fail as before.
    await closeOpened();
    const reason = (failed as PromiseRejectedResult).reason;
    if (reason instanceof ProjectIntakeError && reason.statusCode === 403) {
      await sql`update upload_sessions set status = 'aborted', updated_at = now() where id = ${sessionId}`;
    }
    throw reason;
  }
  // Every file in one insert. If it fails, no row would lead cleanup to the uploads just opened: close them.
  const rows = plans.map((plan, i) => ({
    id: randomUUID(),
    session_id: sessionId,
    filename: plan.file.filename,
    mime_type: plan.file.mimeType,
    size_bytes: plan.file.sizeBytes,
    source_key: plan.sourceKey,
    upload_mode: plan.mode,
    upload_id: (opened[i] as PromiseFulfilledResult<string | null>).value,
    part_size: plan.partSize,
    status: "pending",
    sha256: plan.file.sha256 ?? null,
    canonical_id: plan.file.canonicalId ?? null,
    source_path: normalizeUploadPath(plan.file.path),
    unknown_size: plan.file.unknownSize,
    request_index: plan.file.index,
    client_id: plan.file.clientId ?? null,
    content_identity: plan.file.identity ? sql.json(plan.file.identity) : null,
  }));
  try {
    await sql`insert into upload_session_files ${sql(rows)}`;
  } catch (error) {
    await closeOpened();
    throw error;
  }

  await sql`update upload_sessions set status = 'pending', next_reconcile_at = now() where id = ${sessionId}`;
  const loaded = await loadDirectUploadSession(sessionId, input.userId);
  if (!loaded) {
    throw new ProjectIntakeError("Upload session not found", 404);
  }
  // As on a replay: after provider setup, immediately before the first targets are signed, the credential that opened
  // the session must still permit it. A refused session gets no targets; its opened uploads are aborted by the sweep.
  await assertMayMintTargets(loaded.session, input.userId, input.apiKeyId).catch(async (error: unknown) => {
    await sql`update upload_sessions set status = 'aborted', updated_at = now() where id = ${sessionId}`;
    await sql`update upload_session_files set status = 'aborted', updated_at = now() where session_id = ${sessionId}`;
    await queueAbandonedDirectUploadCleanup(sessionId);
    throw error;
  });
  return { ...(await describeDirectUploadSession(loaded)), ...(rejected.length > 0 ? { rejected } : {}) };
}

export async function describeDirectUploadSession(
  loaded: LoadedDirectUploadSession,
  statusOnly = false,
  /** Files this read did not inspect: described without provider calls, marked `inspected: false`. */
  options: { uninspected?: ReadonlySet<string>; signal?: AbortSignal } = {},
) {
  // At most MAX_PART_URLS_PER_READ part URLs are signed per read (and none once the read's deadline passes or its
  // client disconnects); later parts are described without a URL, for the client to sign through parts/sign.
  const partUrls: PartUrlBudget = { remaining: MAX_PART_URLS_PER_READ, signal: options.signal };
  const ttl = statusOnly || ["confirmed", "failed", "aborted", "expired"].includes(loaded.session.status) ? SIGNED_UPLOAD_TTL_SECONDS : assertUploadSessionActive(loaded.session);
  const files = await Promise.all(
    loaded.files.map(async (file) => statusOnly || ["confirmed", "failed", "aborted"].includes(loaded.session.status) ? { ...fileRef(file), id: file.id, filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes, mode: file.upload_mode as "single" | "multipart", status: file.status } : await buildDirectUploadFileDescriptor(file, ttl, loaded.session.expires_at, { uninspected: options.uninspected?.has(file.id) === true, partUrls })),
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
  const session = await loadDirectUploadSessionRow(sessionId, userId);
  return Boolean(apiKeyId) && session?.org_id === orgId && session.api_key_id === apiKeyId && (!allowedProjectIds?.length || Boolean(session.project_id && allowedProjectIds.includes(session.project_id)));
}

/**
 * Right before minting upload targets (the session read, part signing), under the session lock: the caller may still
 * contribute to the session's project, and the request's own key, if any, is still authorized in one snapshot
 * (getLiveIntakeKey), with `ingest`, for the session's organization and inside its project allowlist. Whatever the
 * route checked before the lock wait may have gone stale.
 */
async function assertMayMintTargets(session: UploadSessionRow, userId: string, credentialKeyId: string | null | undefined): Promise<void> {
  const { assertSessionProjectStillContributable } = await import("./direct-session-idempotency.js");
  await assertSessionProjectStillContributable(session, userId);
  await assertCredentialStillPermits(session, credentialKeyId);
}

/**
 * The request's own API key (or OAuth grant's key), in one snapshot (getLiveIntakeKey): live, owner a member, grant
 * unrevoked, `ingest`, of the target's organization, with a project allowlist that still covers the target project.
 * A caller without a key (a browser session) is the user acting on their own access, checked separately.
 */
async function assertCredentialStillPermits(target: { org_id: string | null; project_id: string | null }, credentialKeyId: string | null | undefined): Promise<void> {
  if (!credentialKeyId) return;
  const { getLiveIntakeKey } = await import("./api-keys.js");
  const key = await getLiveIntakeKey(credentialKeyId);
  if (!key || !key.scopes.includes("ingest") || key.orgId !== target.org_id
    || (key.projectIds.length > 0 && !(target.project_id && key.projectIds.includes(target.project_id)))) {
    throw new ProjectIntakeError("API key no longer permits this upload", 403);
  }
}

/**
 * The last check before upload targets are signed, after the authorization check: the caller's client is still there
 * and the hold's deadline has not passed. A late caller signs nothing and may retry (409 `upload_session_busy`).
 */
function assertMaySignNow(signal: AbortSignal, requestSignal?: AbortSignal): void {
  requestSignal?.throwIfAborted();
  if (signal.aborted) {
    if (signal.reason instanceof Error && signal.reason.name !== "TimeoutError") throw signal.reason;
    throw new ProjectIntakeError("Upload targets were not signed within this request's time budget; retry", 409, undefined, "upload_session_busy");
  }
}

/** Files one wave of the session read inspects and seals after one authorization check. */
const READ_SEAL_WAVE = 8;

/** The most files one full session read may name with `fileId`. */
export const MAX_DESCRIBE_FILE_IDS = 1_000;

export async function getDirectUploadSessionDescription(
  sessionId: string,
  userId: string,
  statusOnly = false,
  signal?: AbortSignal,
  /** Describe (and inspect) only these files of the session; omitted: all of them. */
  fileIds?: readonly string[],
  /** The request's API key (rechecked under the lock before any target is minted). */
  credentialKeyId?: string | null,
) {
  if (statusOnly) {
    const loaded = await loadDirectUploadSession(sessionId, userId);
    return loaded ? describeDirectUploadSession(loaded, true) : null;
  }
  const owned = await loadDirectUploadSessionRow(sessionId, userId);
  if (!owned) return null;
  const load = async () => {
    const session = await loadDirectUploadSessionRow(sessionId, userId);
    return session ? { session, files: await loadDirectUploadSessionFiles(sessionId, fileIds) } : null;
  };
  return withDirectUploadLock(sessionId, async () => {
    let loaded = await load();
    if (!loaded) return null;
    if (loaded.session.status === "confirmed") return describeDirectUploadSession(loaded, true);
    assertUploadSessionActive(loaded.session);
    const { assertSessionProjectStillContributable } = await import("./direct-session-idempotency.js");
    await assertSessionProjectStillContributable(loaded.session, userId);
    // Inspect final objects before signing new upload targets: an outage is not absence. A file this read's budget
    // did not reach is described as still pending (fresh targets, `inspected: false`): files/complete verifies the
    // stored object anyway, so a large session's read always answers and a retry or a `fileId` filter goes further.
    const uninspected = new Set<string>();
    try {
      const open = loaded.files.filter(file => file.status === "pending" && !file.unknown_size);
      const budget = lockHoldBudget(signal);
      const sessionRow = loaded.session;
      // Files are inspected (and, when stored, sealed) in waves of at most READ_SEAL_WAVE: the caller's authorization
      // is checked before each wave is dispatched, and the next wave starts only after this one has settled. A denial
      // refuses the read (403): no later wave's storage call starts. One check per wave, not per file, so the checks
      // do not spend the hold budget (which would leave more files uninspected).
      const lanes = Math.max(1, Math.min(READ_SEAL_WAVE, env.directUploadFinalizeConcurrency));
      const inspected: PromiseSettledResult<void>[] = [];
      for (let start = 0; start < open.length; start += lanes) {
        const wave = open.slice(start, start + lanes);
        if (!budget.shouldStart()) {
          inspected.push(...wave.map((): PromiseSettledResult<void> => ({ status: "rejected", reason: NOT_STARTED })));
          continue;
        }
        await assertMayMintTargets(sessionRow, userId, credentialKeyId);
        inspected.push(...await settleBounded(wave, lanes, async file => {
          let exists = false;
          try { await withStorageRetry(() => getUploadedObjectMetadata(file.source_key, budget.signal), undefined, budget.signal); exists = true; }
          catch (error) { if (!isStorageNotFound(error)) throw error; }
          if (exists) await finalizeDirectUploadFile(file, undefined, { signal: budget.signal });
        }, { shouldStart: budget.shouldStart }));
      }
      for (const [i, result] of inspected.entries()) {
        if (result.status === "rejected" && result.reason === NOT_STARTED) uninspected.add(open[i]!.id);
      }
      // A storage failure on a file that was inspected decides the answer: no target is signed on missing evidence.
      const failure = inspected.find(result => result.status === "rejected" && result.reason !== NOT_STARTED);
      if (failure) throw (failure as PromiseRejectedResult).reason;
      loaded = (await load())!;
      await assertMayMintTargets(loaded.session, userId, credentialKeyId);
      assertMaySignNow(budget.signal);
      return await describeDirectUploadSession(loaded, false, { uninspected, signal: budget.signal });
    } catch (error) {
      if (error instanceof ProjectIntakeError && (error.code === "intake_reconciliation_required" || error.code === "upload_session_busy" || error.statusCode === 403)) throw error;
      if (signal?.aborted) throw error;
      throw new ProjectIntakeError("Upload storage evidence is unavailable; retry status later", 503, undefined, "upload_storage_unavailable");
    }
  }, undefined, undefined, { lockClass: "batch", tenant: await principalLockTenant(userId, owned.api_key_id), signal });
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
  /** The request's abort signal: a waiter whose client disconnected stops waiting. */
  signal?: AbortSignal;
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
 * For bulk intake, a saturated pool is reported separately from a held idempotency lock.
 * A waiting caller releases its lock connection between tries: the pool must stay free for the holder and other sessions.
 */
export async function withDirectUploadLock<T>(sessionId: string, run: () => Promise<T>, busyMessage: string | undefined, busyCode: ProjectIntakeErrorCode | undefined, options: DirectUploadLockOptions): Promise<T> {
  busyMessage ??= "Upload session is being finalized; retry shortly";
  busyCode ??= "upload_session_busy";
  // Batch and short holders wait like confirm does: a held slot (a 100-file complete holds the one batch slot for a
  // few seconds) is waited out, not refused after 2 s. Waiting costs only memory; throughput is unchanged.
  const waitMs = Math.max(0, options.waitMs ?? (options.lockClass === "batch" || (options.lockClass ?? "short") === "short" ? env.directUploadLockWaitMs : 0));
  // A caller that states its wait gets exactly that deadline, for the slot, the connection and every retry; one that
  // does not waits the lock library's short default for a slot and a connection, then answers busy.
  const deadline = Date.now() + waitMs;
  for (;;) {
    let reserved: Awaited<ReturnType<typeof reserveDirectUploadLockConnection>>;
    try {
      reserved = await reserveDirectUploadLockConnection({ lockClass: options.lockClass, tenant: options.tenant, signal: options.signal, ...(waitMs > 0 ? { deadline } : {}) });
    } catch (error) {
      // No slot or connection in time is a capacity refusal, whatever the caller's own busy code means: it never
      // claims another request holds this caller's key or session.
      if (error instanceof DirectUploadLockUnavailable) {
        throw options.lockClass === "intake"
          ? new ProjectIntakeError("Uploads are busy; retry shortly", 409, undefined, "upload_session_busy")
          : new ProjectIntakeError(busyMessage, 409, undefined, busyCode);
      }
      throw error;
    }
    const { connection, release } = reserved;
    try {
      const [lock] = await connection`select pg_try_advisory_lock(hashtextextended(${`upload:${sessionId}`}, 0)) as acquired`;
      if (lock?.acquired) {
        try {
          // Right after the lock is acquired: a caller whose client went away, or whose stated wait has already run
          // out, starts nothing under it.
          options.signal?.throwIfAborted();
          if (waitMs > 0 && Date.now() > deadline) throw new ProjectIntakeError(busyMessage, 409, undefined, busyCode);
          return await run();
        }
        finally { await connection`select pg_advisory_unlock(hashtextextended(${`upload:${sessionId}`}, 0))`; }
      }
    } finally { release(); }
    if (Date.now() >= deadline) throw new ProjectIntakeError(busyMessage, 409, undefined, busyCode);
    options.signal?.throwIfAborted();
    await new Promise(resolve => setTimeout(resolve, Math.min(LOCK_RETRY_INTERVAL_MS, Math.max(1, deadline - Date.now()))));
    options.signal?.throwIfAborted();
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
export async function finalizeDirectUploadFile(file: UploadSessionFileRow, finalSize?: number, options: {
  signal?: AbortSignal;
  /**
   * The caller's authorization, run immediately before each storage write this finalize sends (the sealing copy, the
   * multipart completion), retries included. A throw sends nothing further. The reconciler passes none: it seals bytes
   * uploaded through targets signed while their caller was authorized, and no run starts without admission's check.
   */
  authorize?: () => Promise<void>;
} = {}): Promise<boolean> {
  try {
    return await finalizeDirectUploadFileUnclassified(file, finalSize, options.signal, options.authorize);
  } catch (error) {
    if (error instanceof ProjectIntakeError) throw error;
    throw uploadStorageUnavailable(error, `file=${file.id}`);
  }
}

async function finalizeDirectUploadFileUnclassified(file: UploadSessionFileRow, finalSize: number | undefined, signal: AbortSignal | undefined, authorize: (() => Promise<void>) | undefined): Promise<boolean> {
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
    if (!isStorageNotFound(error) && !(error instanceof ProjectIntakeError && error.code === "upload_object_missing")) throw error;
    // A finalizer holding a stale row may find the original already gone because another one published it.
    if (file.upload_mode !== "multipart" || !file.upload_id) return await completedMeanwhile(file);
    const assembled = await assembleMultipartUpload(file, file.upload_id, signal, authorize);
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
  const sourceKey = await sealSingleUpload(file, verified.etag, signal, authorize);
  // Publish the sealed key and durable cleanup of the original together, fenced on the row still being pending at
  // the original key: of two finalizers (a lost lock connection lets an old one run on), only one publishes.
  // Wait a day beyond completion: longer than any PUT URL can stay valid (MAX_URL_TTL_SECONDS) and in-flight writes.
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
async function assembleMultipartUpload(file: UploadSessionFileRow, uploadId: string, signal: AbortSignal | undefined, authorize?: () => Promise<void>): Promise<{ etag: string | null } | null> {
  let parts: Awaited<ReturnType<typeof listMultipartUploadParts>>;
  try { parts = await withStorageRetry(() => listMultipartUploadParts({ key: file.source_key, uploadId, signal }), undefined, signal); }
  catch (error) {
    if (storageErrorName(error) === "NoSuchUpload") return await recoverClosedMultipart(file, error, signal);
    throw error;
  }
  if (!validMultipartLayout(parts, file.size_bytes, file.part_size ?? LEGACY_PART_SIZE_BYTES)) return null;
  try {
    await withStorageRetry(async () => {
      await authorize?.();
      return await completeMultipartUpload({ key: file.source_key, uploadId, parts, signal });
    }, undefined, signal);
  }
  catch (error) {
    if (error instanceof ProjectIntakeError) throw error;
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
    if (error instanceof ProjectIntakeError && error.code === "upload_object_missing") throw multipartCompletionError(closed, file.filename);
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

async function sealSingleUpload(file: UploadSessionFileRow, etag: string | null, signal: AbortSignal | undefined, authorize?: () => Promise<void>): Promise<string> {
  if (!etag) throw new ProjectIntakeError(`Unable to verify the uploaded version of ${file.filename}`, 400);
  const sealed = sealedSourceKey(file, etag);
  try {
    // Idempotent: the same If-Match copy to the same version's key writes the same bytes again.
    await withStorageRetry(async () => {
      await authorize?.();
      return await copyUploadedObject({ fromKey: file.source_key, toKey: sealed, ifMatch: etag, signal });
    }, undefined, signal);
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
 * Why a file could not be finalized yet. Only missing bytes carry the codes a client acts on by sending bytes again
 * (`upload_object_missing`: PUT the file; `upload_parts_incomplete`: upload the missing parts); a closed file or a
 * missing size is not answered that way.
 */
function notFinalizedError(file: UploadSessionFileRow, entry: CompleteDirectUploadFileEntry): ProjectIntakeError {
  if (file.status !== "pending") return new ProjectIntakeError(`${file.filename} is ${file.status}`, 409);
  // Not a session-blocking failure: the client completes it again with its final size.
  if (file.unknown_size && entry.sizeBytes === undefined) return new ProjectIntakeError(`Complete ${file.filename} with its final sizeBytes`, 409);
  if (file.upload_mode === "single") {
    return new ProjectIntakeError(`No object found in storage for ${file.filename}: PUT its bytes to the file's putUrl, then complete it again`, 409, undefined, "upload_object_missing");
  }
  return new ProjectIntakeError(PARTS_INCOMPLETE_MESSAGE, 409, undefined, "upload_parts_incomplete");
}

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
  // A part below the provider's minimum size comes from the server's own layout: no client resend can fix it.
  const reupload = !retryable && !error.message.includes("(EntityTooSmall)") && (code === "upload_object_missing" || code === "upload_parts_incomplete"
    || error.message.includes("changed while its upload was being completed")
    || REUPLOAD_MESSAGES.some(prefix => error.message.startsWith(prefix)));
  // Mirrors the reconciler's terminal rule (a 4xx other than 409) for what it meets on its own: an absent object is
  // only "not yet", and an unknown file or a changed declared size never reaches it.
  const blocksSession = error.statusCode < 500 && error.statusCode !== 409 && error.statusCode !== 404
    && code !== "upload_object_missing" && error.message !== DECLARED_SIZE_CHANGE_MESSAGE;
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
async function finalizeSessionFiles(sessionId: string, userId: string, entries: readonly CompleteDirectUploadFileEntry[], options: { signal?: AbortSignal; credentialKeyId?: string | null } = {}): Promise<{ outcomes: FinalizeOutcome[]; sessionComplete: boolean }> {
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
      // An API-key or OAuth caller's key, grant and allowlist are checked immediately before each sealing copy or
      // multipart completion, like any other dispatch; a browser caller's own access was checked above.
      const authorize = options.credentialKeyId ? () => assertCredentialStillPermits(session, options.credentialKeyId) : undefined;
      if (!await finalizeDirectUploadFile(file, entry.sizeBytes, { signal: budget.signal, authorize })) throw notFinalizedError(file, entry);
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
  }, undefined, undefined, { lockClass: "batch", tenant: await principalLockTenant(userId, owned.api_key_id), signal: options.signal });
}

/** The single-file `files/complete` body: throws the file's own error, exactly as before batching existed. */
export async function completeDirectUploadFile(input: CompleteDirectUploadFileInput & { signal?: AbortSignal; credentialKeyId?: string | null }): Promise<{ sessionComplete: boolean }> {
  const { signal, sessionId, userId, credentialKeyId, ...entry } = input;
  const { outcomes: [outcome], sessionComplete } = await finalizeSessionFiles(sessionId, userId, [entry], { signal, credentialKeyId });
  if (outcome && !outcome.completed) throw outcome.error;
  return { sessionComplete };
}

/**
 * The batched `files/complete` body. Good files complete and bad ones are reported per file (with the status code and
 * message the single-file call would have answered); only a session-level problem fails the request.
 */
export async function completeDirectUploadFiles(input: { sessionId: string; userId: string; files: readonly CompleteDirectUploadFileEntry[]; signal?: AbortSignal; credentialKeyId?: string | null }): Promise<{ files: DirectUploadFileCompletion[]; completedCount: number; failedCount: number; sessionComplete: boolean }> {
  const { outcomes, sessionComplete } = await finalizeSessionFiles(input.sessionId, input.userId, input.files, { signal: input.signal, credentialKeyId: input.credentialKeyId });
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

export async function signDirectUploadParts(sessionId: string, userId: string, fileId: string, partNumbers: number[], credentialKeyId?: string | null, requestSignal?: AbortSignal) {
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
  const budget = AbortSignal.timeout(SIGN_PROVIDER_BUDGET_MS);
  const signal = requestSignal ? AbortSignal.any([requestSignal, budget]) : budget;
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
  catch {
    requestSignal?.throwIfAborted();
    throw new ProjectIntakeError("Upload storage evidence is unavailable", 503, undefined, "upload_storage_unavailable");
  }
  const partSize = file.part_size ?? LEGACY_PART_SIZE_BYTES;
  const maxPart = Math.max(1, Math.ceil(env.maxUploadBytes / partSize));
  for (const partNumber of partNumbers) {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || partNumber > maxPart || (!file.unknown_size && partNumber > toDirectUploadPartCount(file.size_bytes, partSize))) throw new ProjectIntakeError("Invalid part number", 400);
  }
  const expiresInSeconds = assertUploadSessionActive(session);
  // Immediately before signing, after every provider read: the credential still permits it, the client is still
  // there and the budget has not run out. Nothing but the signing itself follows the check.
  await assertMayMintTargets(session, userId, credentialKeyId);
  assertMaySignNow(signal, requestSignal);
  // A known-size file's part is bound to its exact size. A stream's parts are not known until it ends; its layout is
  // checked against the final size at completion.
  return { parts: await Promise.all(partNumbers.map(async partNumber =>
    ({ partNumber, url: await signMultipartUploadPart({ key: file.source_key, uploadId: file.upload_id!, partNumber, contentLength: file.unknown_size ? undefined : partSizeAt(partNumber, file.size_bytes, partSize), expiresInSeconds }) }))) };
  }, undefined, undefined, { tenant: await principalLockTenant(userId, owned.api_key_id), signal: requestSignal });
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
    { waitMs: lockWaitMs, tenant: await principalLockTenant(userId, owned.api_key_id) });
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
        undefined,
        "upload_object_missing",
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
      return new ProjectIntakeError(`Multipart completion for ${filename} failed: a part is missing or its etag does not match the uploaded part (InvalidPart)`, 400, undefined, "upload_parts_incomplete");
    case "InvalidPartOrder":
      return new ProjectIntakeError(`Multipart completion for ${filename} failed: parts must be in ascending partNumber order (InvalidPartOrder)`, 400);
    case "EntityTooSmall":
      // Resending the same layout cannot fix it: not a "send the bytes again" code.
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
 * multipart_aborted_at). Raw objects are deleted by the storage cleanup queue after outstanding signed PUTs expire:
 * the longest any URL can live (MAX_URL_TTL_SECONDS), not the current setting, since URLs signed under a longer
 * UPLOAD_URL_TTL_SECONDS (or by another host) are still valid.
 */
export async function queueAbandonedDirectUploadCleanup(sessionId: string): Promise<void> {
  await sql`insert into storage_cleanup_queue (kind, org_id, target, payload, artifact_uris, reason, not_before)
    select 'storage_prefix', coalesce(s.org_id, ''), s.user_id || '/' || s.id || '/',
      jsonb_build_object('projectId', s.project_id), array_agg(f.source_key), 'abandoned_upload', now() + make_interval(secs => ${MAX_URL_TTL_SECONDS + 60})
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
