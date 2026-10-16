/**
 * Workspace Intake: the one path that turns new source material into a Run in
 * a workspace. Every source kind (bulk upload bytes, fetched URLs, a completed
 * Direct Upload Session, connector files, automation sources) is a thin adapter
 * that yields `WorkspaceIntakeItem`s; this module owns everything after that:
 *
 * - the validation policy (type, size, remote parser surface)
 * - the raw storage key layout and the raw object-storage write
 * - workspace resolution / auto-create, including self-titling
 * - creating the Run and its Documents
 * - starting or deferring processing
 * - the audit trail
 *
 * Raw objects written by a failed intake are removed before the error surfaces.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Transform, type Readable } from "node:stream";

import {
  applyWorkspacePipelineOverrides,
  defaultPipelineFeatures,
  getWorkspaceTemplate,
  isDefaultWorkspaceAlias,
  normalizePipelineFeatures,
  type PipelineFeatureOverrides,
  type PipelineFeatures,
  type WorkspaceRecord,
  type WorkspaceTemplateKey,
} from "@docslurp/shared";

import { env } from "../config.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { deleteUploadedObject, uploadFile, uploadFileStream } from "../lib/storage.js";
import { isSupportedUploadMimeType, resolveUploadMimeType } from "../lib/upload-policy.js";
import { appendAuditLog } from "./audit-log.js";
import { explainRemoteIngestBlock, isComplexRemoteIngestFormat } from "./remote-parser-surface.js";
import { runLifecycle } from "./run-lifecycle.js";
import { createRunManifest } from "./run-manifest.js";
import { AllSourcesUnreadableError } from "./source-metadata.js";
import { markWorkspaceAutoNamed } from "./workspace-naming.js";
import { seedPipelineFromProcessingDefaults, seedSearchSettingsFromProcessingDefaults } from "./processing-defaults.js";
import { updateWorkspaceSearchSettingsForUser } from "./search-controls.js";
import { getUserSettings } from "./user-settings.js";
import { deleteWorkspaceData } from "./data-deletion.js";
import { createWorkspace, ensureDefaultWorkspace, getWorkspace, resolveWorkspaceRef } from "./workspaces.js";

/** The run kind doubles as the source kind; it picks the validation policy. */
export type WorkspaceIntakeKind =
  | "bulk-upload"
  | "direct-upload"
  | "url-ingest"
  | "ai-automation"
  | "connector-sync";

export type WorkspaceIntakeStatusCode = 400 | 404 | 409 | 413 | 415 | 422 | 500;

export class WorkspaceIntakeError extends Error {
  constructor(
    message: string,
    readonly statusCode: WorkspaceIntakeStatusCode,
    readonly issues?: Array<{ path: string; message: string; code: string }>,
  ) {
    super(message);
    this.name = "WorkspaceIntakeError";
  }
}

/** Source bytes an adapter hands over: in memory, streaming, or already stored. */
export type WorkspaceIntakeContent =
  | { bytes: Buffer }
  | { stream: Readable; contentLength?: number }
  | { storedKey: string };

export interface WorkspaceIntakeItem {
  filename: string;
  mimeType?: string | null;
  /** Declared size; in-memory bytes and stream content lengths take precedence. */
  sizeBytes?: number | null;
  metadata?: Record<string, unknown>;
  /** Logical source identity; a newer completed document with the same ID supersedes older ones. */
  canonicalId?: string | null;
  content: WorkspaceIntakeContent;
}

export type WorkspaceIntakeAudit = {
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
};

export interface WorkspaceIntakeRequest {
  userId: string;
  orgId?: string | null;
  /**
   * Append to this workspace. When null, the org's default workspace receives
   * the items unless `newWorkspace`, `workspaceName`, or `templateKey` asks for
   * a fresh self-titled workspace.
   */
  workspaceId: string | null;
  newWorkspace?: boolean;
  workspaceName?: string | null;
  templateKey?: WorkspaceTemplateKey;
  /**
   * Per-request overrides, merged onto the workspace pipeline. Template-locked
   * settings always keep the template's value.
   */
  pipeline?: PipelineFeatureOverrides;
  apiKeyId?: string | null;
  kind: WorkspaceIntakeKind;
  items: Iterable<WorkspaceIntakeItem> | AsyncIterable<WorkspaceIntakeItem>;
  /** Remote URLs behind the items; used for the title and redacted audit origins. */
  urls?: string[];
  /** Sources that skip files themselves (connectors) may legitimately yield nothing. */
  mayBeEmpty?: boolean;
  /**
   * Take the files that pass validation and report the rest in `rejected`, instead of failing the
   * whole request on the first bad file. The request still fails when no file is accepted.
   */
  acceptPartial?: boolean;
  audit?: WorkspaceIntakeAudit;
}

export interface StoredIntakeFile {
  /** Measured while storing source bytes; absent for already-stored sources. */
  fileSize?: number;
  filename: string;
  mimeType: string;
  sourceKey: string;
  metadata?: Record<string, unknown>;
  canonicalId?: string | null;
}

type RunManifest = Awaited<ReturnType<typeof createRunManifest>>;

export interface WorkspaceIntakeResult {
  workspace: WorkspaceRecord;
  pipeline: PipelineFeatures;
  run: RunManifest["run"];
  documents: RunManifest["documents"];
  /** Set when the run exists but processing could not start yet. */
  deferredReason: string | null;
  /** Files left out of an `acceptPartial` request, with why. Empty otherwise. */
  rejected: RejectedIntakeFile[];
}

export interface RejectedIntakeFile {
  filename: string;
  /** HTTP status the file would have produced on its own. */
  statusCode: number;
  code: "unsupported_type" | "file_too_large" | "unreadable_source" | "rejected";
  message: string;
}

function rejectionCode(error: WorkspaceIntakeError): RejectedIntakeFile["code"] {
  if (error.statusCode === 415) return "unsupported_type";
  if (error.statusCode === 413) return "file_too_large";
  return "rejected";
}

// ---------------------------------------------------------------------------
// Ports. Production adapters are below; tests pass in-memory fakes.

export interface RawSourceStorage {
  put(
    key: string,
    content: { bytes: Buffer } | { stream: Readable; contentLength?: number },
    contentType: string,
  ): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface WorkspaceIntakeRecords {
  findWorkspace(workspaceId: string, userId: string): Promise<WorkspaceRecord | null>;
  defaultWorkspace(args: { userId: string; orgId?: string | null }): Promise<WorkspaceRecord>;
  createWorkspace(args: {
    userId: string;
    orgId?: string;
    name: string;
    templateKey?: WorkspaceTemplateKey;
    /** Upload overrides for the new workspace's pipeline (merged onto its template). */
    pipeline?: PipelineFeatureOverrides;
    autoNamed: boolean;
  }): Promise<WorkspaceRecord>;
  createRun(args: {
    userId: string;
    workspaceId: string;
    kind: WorkspaceIntakeKind;
    pipeline: PipelineFeatures;
    apiKeyId?: string | null;
    files: StoredIntakeFile[];
    skipUnreadable?: boolean;
  }): Promise<RunManifest>;
  /** Remove a workspace this request created when intake failed before any run existed. */
  discardWorkspace(workspaceId: string): Promise<void>;
  appendAudit(entry: Parameters<typeof appendAuditLog>[0]): Promise<void>;
}

/** Starts processing, or returns the reason it was deferred. */
export type StartOrDeferRun = (runId: string, pipeline: PipelineFeatures) => Promise<string | null>;

export interface WorkspaceIntakePorts {
  storage: RawSourceStorage;
  records: WorkspaceIntakeRecords;
  startRun: StartOrDeferRun;
}

export const objectStorage: RawSourceStorage = {
  async put(key, content, contentType) {
    if ("bytes" in content) {
      await uploadFile(key, content.bytes, contentType);
      return;
    }
    await uploadFileStream({
      key,
      body: content.stream,
      contentType,
      contentLength: content.contentLength,
    });
  },
  remove: deleteUploadedObject,
};

export const postgresIntakeRecords: WorkspaceIntakeRecords = {
  async findWorkspace(workspaceRef, userId) {
    const ref = await resolveWorkspaceRef(workspaceRef);
    return await getWorkspace(ref?.id ?? workspaceRef, userId);
  },
  defaultWorkspace: ensureDefaultWorkspace,
  async createWorkspace({ autoNamed, pipeline: overrides, ...args }) {
    // The uploader's Processing defaults seed the new workspace; the template
    // and upload overrides go on top, and template locks win.
    const defaults = await getUserSettings(args.userId).then((settings) => settings.general, () => null);
    const template = getWorkspaceTemplate(args.templateKey ?? null);
    const base = seedPipelineFromProcessingDefaults(
      normalizePipelineFeatures(template?.pipeline ?? defaultPipelineFeatures),
      defaults,
    );
    const pipeline = applyWorkspacePipelineOverrides(base, overrides, template);
    const workspace = await createWorkspace({ ...args, pipeline });
    const searchSeed = seedSearchSettingsFromProcessingDefaults(defaults);
    if (searchSeed) {
      await updateWorkspaceSearchSettingsForUser({ workspaceId: workspace.id, userId: args.userId, input: searchSeed })
        .catch((error: unknown) => {
          console.error(`[intake] could not seed search settings for workspace=${workspace.id}:`, error instanceof Error ? error.message : String(error));
        });
    }
    if (autoNamed) await markWorkspaceAutoNamed(workspace.id, args.userId, workspace.name);
    return workspace;
  },
  createRun: createRunManifest,
  async discardWorkspace(workspaceId) {
    await deleteWorkspaceData(workspaceId);
  },
  async appendAudit(entry) {
    await appendAuditLog(entry);
  },
};

/** Start-or-defer is owned by Run Lifecycle. */
export const startOrDeferPipelineRun: StartOrDeferRun = async (runId, pipeline) => {
  const start = await runLifecycle.start({ id: runId, pipeline });
  return start.status === "deferred" ? start.reason : null;
};

export const workspaceIntakePorts: WorkspaceIntakePorts = {
  storage: objectStorage,
  records: postgresIntakeRecords,
  startRun: startOrDeferPipelineRun,
};

// ---------------------------------------------------------------------------
// Validation policy and storage layout.

export type IntakeFileVerdict =
  | { ok: true; filename: string; mimeType: string }
  | {
      ok: false;
      filename: string;
      reason: "parser-surface" | "type" | "size";
      statusCode: 413 | 415;
      message: string;
    };

const remoteSourceLabels = {
  "url-ingest": "url",
  "ai-automation": "automation",
  "connector-sync": "connector",
} as const;

function isRemoteKind(kind: WorkspaceIntakeKind): kind is keyof typeof remoteSourceLabels {
  return kind in remoteSourceLabels;
}

/** The one validation policy for every intake source. */
export function screenIntakeFile(
  file: { filename: string; mimeType?: string | null; sizeBytes?: number | null },
  kind: WorkspaceIntakeKind,
): IntakeFileVerdict {
  const filename = sanitizeUploadFilename(file.filename);
  const declared = file.mimeType ?? null;

  if (
    isRemoteKind(kind) &&
    !env.remoteIngestComplexFormatsEnabled &&
    isComplexRemoteIngestFormat(declared, filename)
  ) {
    return {
      ok: false,
      filename,
      reason: "parser-surface",
      statusCode: 415,
      message: explainRemoteIngestBlock({ kind: remoteSourceLabels[kind], filename, mimeType: declared }),
    };
  }
  if (!isSupportedUploadMimeType(declared, filename)) {
    return { ok: false, filename, reason: "type", statusCode: 415, message: `Unsupported file type for ${filename}` };
  }
  if (typeof file.sizeBytes === "number" && file.sizeBytes > env.maxUploadBytes) {
    return {
      ok: false,
      filename,
      reason: "size",
      statusCode: 413,
      message: `${filename} exceeds MAX_UPLOAD_BYTES (${env.maxUploadBytes} bytes)`,
    };
  }
  return { ok: true, filename, mimeType: resolveUploadMimeType(declared, filename) };
}

export function admitIntakeFile(
  file: { filename: string; mimeType?: string | null; sizeBytes?: number | null },
  kind: WorkspaceIntakeKind,
): { filename: string; mimeType: string } {
  const verdict = screenIntakeFile(file, kind);
  if (!verdict.ok) throw new WorkspaceIntakeError(verdict.message, verdict.statusCode);
  return verdict;
}

/** The one raw-object key layout. `filename` must already be sanitized. */
export function rawSourceKey(userId: string, filename: string): string {
  return `${userId}/${randomUUID()}/raw/${randomUUID()}-${filename}`;
}

// ---------------------------------------------------------------------------
// Self-titling and audit redaction.

function normalizeWorkspaceSeed(value: string): string | null {
  const normalized = value
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return (normalized.charAt(0).toUpperCase() + normalized.slice(1)).slice(0, 120);
}

function formatAutoWorkspaceTitle(primary: string | null, additionalCount: number): string {
  if (!primary) return `New workspace ${new Date().toISOString().slice(0, 10)}`;
  const suffix = additionalCount > 0 ? ` + ${additionalCount} more` : "";
  return `${primary}${suffix}`.slice(0, 120);
}

export function inferWorkspaceTitleFromFilenames(filenames: string[]): string {
  return formatAutoWorkspaceTitle(
    normalizeWorkspaceSeed(path.basename(filenames[0] ?? "")),
    Math.max(0, filenames.length - 1),
  );
}

export function inferWorkspaceTitleFromUrls(urls: string[]): string {
  try {
    const firstUrl = new URL(urls[0] ?? "");
    return formatAutoWorkspaceTitle(
      normalizeWorkspaceSeed(path.basename(firstUrl.pathname)) ??
        normalizeWorkspaceSeed(firstUrl.hostname.replace(/^www\./, "")),
      Math.max(0, urls.length - 1),
    );
  } catch {
    return formatAutoWorkspaceTitle(null, 0);
  }
}

function auditUrlOrigins(urls: string[]): string[] {
  return Array.from(
    new Set(
      urls.flatMap((value) => {
        try {
          return [new URL(value).origin];
        } catch {
          return [];
        }
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Intake.

function declaredSize(item: WorkspaceIntakeItem): number | null {
  if ("bytes" in item.content) return item.content.bytes.byteLength;
  if ("stream" in item.content && typeof item.content.contentLength === "number") {
    return item.content.contentLength;
  }
  return item.sizeBytes ?? null;
}

/** Pipes a stream through a byte counter that fails once it passes the upload cap. */
function boundedStream(stream: Readable, onOverflow: () => void, onBytes: (total: number) => void): Readable {
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      total += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      onBytes(total);
      if (total > env.maxUploadBytes) {
        onOverflow();
        callback(new Error(`Upload exceeds MAX_UPLOAD_BYTES (${env.maxUploadBytes} bytes)`));
        return;
      }
      callback(null, chunk);
    },
  });
  stream.once("error", (error) => limiter.destroy(error));
  limiter.once("close", () => stream.destroy());
  return stream.pipe(limiter);
}

async function storeItem(
  item: WorkspaceIntakeItem,
  request: WorkspaceIntakeRequest,
  storage: RawSourceStorage,
  written: string[],
): Promise<StoredIntakeFile> {
  const admitted = admitIntakeFile(
    { filename: item.filename, mimeType: item.mimeType, sizeBytes: declaredSize(item) },
    request.kind,
  );
  const stored = (sourceKey: string, fileSize?: number): StoredIntakeFile => ({
    ...admitted,
    sourceKey,
    ...(fileSize === undefined ? {} : { fileSize }),
    ...(item.metadata ? { metadata: item.metadata } : {}),
    ...(item.canonicalId ? { canonicalId: item.canonicalId } : {}),
  });
  const { content } = item;
  if ("storedKey" in content) return stored(content.storedKey);

  const key = rawSourceKey(request.userId, admitted.filename);
  written.push(key);
  if ("bytes" in content) {
    await storage.put(key, content, admitted.mimeType);
    return stored(key, content.bytes.byteLength);
  }

  let overflowed = false;
  let measuredBytes = 0;
  const body = boundedStream(content.stream, () => {
    overflowed = true;
  }, (total) => { measuredBytes = total; });
  try {
    await storage.put(key, { stream: body, contentLength: content.contentLength }, admitted.mimeType);
  } catch (error) {
    if (overflowed) {
      throw new WorkspaceIntakeError(
        `${admitted.filename} exceeds MAX_UPLOAD_BYTES (${env.maxUploadBytes} bytes)`,
        413,
      );
    }
    throw new WorkspaceIntakeError(error instanceof Error ? error.message : String(error), 400);
  } finally {
    body.destroy();
  }
  return stored(key, measuredBytes);
}

async function findTargetWorkspace(
  request: WorkspaceIntakeRequest & { workspaceId: string },
  records: WorkspaceIntakeRecords,
): Promise<WorkspaceRecord> {
  const workspace = await records.findWorkspace(request.workspaceId, request.userId);
  if (!workspace) throw new WorkspaceIntakeError("Workspace not found.", 404);
  if (request.orgId && workspace.orgId !== request.orgId) {
    throw new WorkspaceIntakeError("Workspace does not belong to the requested organization", 404);
  }
  return workspace;
}

/** Every file of an `acceptPartial` request was rejected: fail it, naming each file. */
function allRejectedError(rejected: RejectedIntakeFile[]): WorkspaceIntakeError {
  const statuses = new Set(rejected.map((file) => file.statusCode));
  const statusCode = (statuses.size === 1 ? rejected[0]!.statusCode : 422) as WorkspaceIntakeStatusCode;
  const message = rejected.length === 1
    ? rejected[0]!.message
    : `None of the ${rejected.length} files could be accepted: ${rejected.map((file) => `${file.filename} (${file.message})`).join("; ")}`;
  return new WorkspaceIntakeError(message, statusCode, rejected.map((file) => ({ path: file.filename, message: file.message, code: file.code })));
}

export function wantsNewWorkspace(
  request: Pick<WorkspaceIntakeRequest, "newWorkspace" | "workspaceName" | "templateKey">,
): boolean {
  return Boolean(request.newWorkspace || request.workspaceName || request.templateKey);
}

/**
 * Takes source items into a workspace: validates and stores each one, resolves
 * or creates the workspace, creates the Run and Documents, starts or defers
 * processing, and records the audit trail. Returns null only when a
 * `mayBeEmpty` source yields no items.
 */
export async function intakeIntoWorkspace(
  request: WorkspaceIntakeRequest,
  ports: WorkspaceIntakePorts = workspaceIntakePorts,
): Promise<WorkspaceIntakeResult | null> {
  const { storage, records } = ports;
  const written: string[] = [];
  const rejected: RejectedIntakeFile[] = [];
  // Set only when this request created the workspace, so a failed intake can remove it again.
  let createdWorkspaceId: string | null = null;
  let workspace: WorkspaceRecord;
  let pipeline: PipelineFeatures;
  let manifest: RunManifest;

  try {
    // An explicit target is checked before any bytes are read or stored. The
    // reserved "default" ID always means the org's default workspace.
    const explicitWorkspaceId = isDefaultWorkspaceAlias(request.workspaceId) ? null : request.workspaceId;
    const existing = explicitWorkspaceId
      ? await findTargetWorkspace({ ...request, workspaceId: explicitWorkspaceId }, records)
      : isDefaultWorkspaceAlias(request.workspaceId)
        ? await records.defaultWorkspace({ userId: request.userId, orgId: request.orgId })
      : wantsNewWorkspace(request)
        ? null
        : await records.defaultWorkspace({ userId: request.userId, orgId: request.orgId });

    const files: StoredIntakeFile[] = [];
    for await (const item of request.items) {
      try {
        files.push(await storeItem(item, request, storage, written));
      } catch (error) {
        if (!request.acceptPartial || !(error instanceof WorkspaceIntakeError)) throw error;
        rejected.push({ filename: sanitizeUploadFilename(item.filename), statusCode: error.statusCode, code: rejectionCode(error), message: error.message });
      }
    }
    if (files.length === 0) {
      if (request.mayBeEmpty) return null;
      if (rejected.length > 0) throw allRejectedError(rejected);
      throw new WorkspaceIntakeError("Attach at least one file.", 400);
    }

    workspace =
      existing ??
      (await records.createWorkspace({
        userId: request.userId,
        orgId: request.orgId ?? undefined,
        name:
          request.workspaceName ??
          (request.urls?.length
            ? inferWorkspaceTitleFromUrls(request.urls)
            : inferWorkspaceTitleFromFilenames(files.map((file) => file.filename))),
        templateKey: request.templateKey,
        pipeline: request.pipeline,
        autoNamed: !request.workspaceName,
      }));
    if (!existing) createdWorkspaceId = workspace.id;
    // A new workspace already carries the overrides; an existing one merges them.
    pipeline = applyWorkspacePipelineOverrides(
      workspace.pipeline ?? defaultPipelineFeatures,
      existing ? request.pipeline : undefined,
      workspace.templateKey,
    );
    try {
      manifest = await records.createRun({
        userId: request.userId,
        workspaceId: workspace.id,
        kind: request.kind,
        pipeline,
        apiKeyId: request.apiKeyId,
        files,
        ...(request.acceptPartial ? { skipUnreadable: true } : {}),
      });
    } catch (error) {
      if (!(error instanceof AllSourcesUnreadableError)) throw error;
      // Every remaining file was unreadable: report them together with the files screened out earlier.
      for (const unreadable of error.errors) {
        rejected.push({ filename: unreadable.filename, statusCode: 422, code: "unreadable_source", message: unreadable.message });
      }
      throw allRejectedError(rejected);
    }
    for (const file of manifest.unreadable) {
      rejected.push({ filename: file.filename, statusCode: 422, code: "unreadable_source", message: file.error.message });
      // The source object was stored but never became a document.
      await storage.remove(file.sourceKey).catch(() => undefined);
    }
  } catch (error) {
    await Promise.all(written.map((key) => storage.remove(key).catch(() => undefined)));
    // No run was created, so a workspace made for this request would be left empty and titled after rejected files.
    if (createdWorkspaceId) {
      await records.discardWorkspace(createdWorkspaceId).catch((cleanupError: unknown) => {
        console.error(`[intake] could not remove workspace=${createdWorkspaceId} after intake failed:`, cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      });
    }
    throw error;
  }

  // The Run and its Documents are committed from here on. Failing the request
  // now would leave a Run the client never learns about (and a retry would
  // process the same files twice), so later steps degrade instead of throwing.
  const { run, documents } = manifest;
  let deferredReason: string | null;
  try {
    deferredReason = await ports.startRun(run.id, pipeline);
  } catch (error) {
    // The Run stays queued with an unconfirmed start; run-start recovery (or
    // the stale-queued sweep) starts it, exactly as for a Temporal outage.
    console.error(`[intake] workflow start failed for run=${run.id}; deferring:`, error instanceof Error ? error.message : String(error));
    deferredReason = RUN_START_FAILED_DEFERRED_MESSAGE;
  }

  const audit = request.audit;
  await appendIntakeAudit(records, {
    orgId: workspace.orgId ?? run.orgId,
    userId: request.userId,
    workspaceId: workspace.id,
    runId: run.id,
    apiKeyId: request.apiKeyId ?? null,
    action: "documents.uploaded",
    resourceType: "run",
    resourceId: run.id,
    ipAddress: audit?.ipAddress,
    metadata: {
      count: documents.length,
      mode: request.kind,
      ...(request.urls
        ? { urlCount: request.urls.length, urlOrigins: auditUrlOrigins(request.urls) }
        : {}),
      ...(audit?.userAgent ? { userAgent: audit.userAgent } : {}),
      ...(audit?.metadata ?? {}),
    },
  });

  return { workspace, pipeline, run, documents, deferredReason, rejected };
}

export const RUN_START_FAILED_DEFERRED_MESSAGE =
  "Run created, but processing could not start yet. It will start automatically; no need to upload again.";

/**
 * The upload audit entry is written after the Run is committed and started.
 * One retry covers a transient database error; a second failure is logged
 * loudly rather than turning a committed upload into an HTTP 500.
 */
async function appendIntakeAudit(
  records: WorkspaceIntakeRecords,
  entry: Parameters<WorkspaceIntakeRecords["appendAudit"]>[0],
): Promise<void> {
  try {
    await records.appendAudit(entry);
  } catch (first) {
    try {
      await records.appendAudit(entry);
    } catch (error) {
      console.error(
        `[intake] audit entry ${entry.action} for run=${entry.runId} could not be written:`,
        error instanceof Error ? error.message : String(error),
        first instanceof Error ? `(first attempt: ${first.message})` : "",
      );
    }
  }
}
