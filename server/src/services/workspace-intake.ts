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
  normalizePipelineFeatures,
  parseWorkspaceInput,
  type WorkspaceInputRef,
  type PipelineFeatureOverrides,
  type PipelineFeatures,
  type WorkspaceRecord,
  type WorkspaceTemplateKey,
  type IndexingMode,
} from "@docslurp/shared";

import { env } from "../config.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { deleteUploadedObject, uploadFile, uploadFileStream } from "../lib/storage.js";
import { isSupportedUploadMimeType, resolveUploadMimeType } from "../lib/upload-policy.js";
import { appendAuditLog } from "./audit-log.js";
import { explainRemoteIngestBlock, isComplexRemoteIngestFormat } from "./remote-parser-surface.js";
import { runCreation, type CreatedRun } from "./run-creation.js";
import { AllSourcesUnreadableError } from "./source-metadata.js";
import { effectiveIndexingMode } from "./workspace-indexing-mode.js";
import { markWorkspaceAutoNamed } from "./workspace-naming.js";
import { seedPipelineFromProcessingDefaults, seedSearchSettingsFromProcessingDefaults } from "./processing-defaults.js";
import { updateWorkspaceSearchSettingsForUser } from "./search-controls.js";
import { getUserSettings } from "./user-settings.js";
import { deleteWorkspaceData } from "./data-deletion.js";
import { workspaceInputNotFoundError } from "./default-workspace.js";
import { createWorkspace, ensureDefaultWorkspace, findWorkspaceForInput, getWorkspace, type WorkspaceInputScope } from "./workspaces.js";

/** The run kind doubles as the source kind; it picks the validation policy. */
export type WorkspaceIntakeKind =
  | "bulk-upload"
  | "direct-upload"
  | "url-ingest"
  | "connector-sync";

export type WorkspaceIntakeStatusCode = 400 | 403 | 404 | 409 | 413 | 415 | 422 | 500;

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

/**
 * Source bytes an adapter hands over: in memory, streaming, or already stored.
 * An adapter that could not produce one source (a URL that failed to fetch, an
 * upload that never completed) yields it as `rejected`, so intake reports that
 * file and carries on with the rest.
 */
export type WorkspaceIntakeContent =
  | { bytes: Buffer }
  | { stream: Readable; contentLength?: number }
  | { storedKey: string }
  | { rejected: WorkspaceIntakeError };

export interface WorkspaceIntakeItem {
  filename: string;
  mimeType?: string | null;
  /** Declared size; in-memory bytes and stream content lengths take precedence. */
  sizeBytes?: number | null;
  metadata?: Record<string, unknown>;
  /** Logical source identity; a newer completed document with the same ID supersedes older ones. */
  canonicalId?: string | null;
  /** Folder path inside the upload (no filename). With the filename it is the version key unless `canonicalId` is set. */
  path?: string | null;
  content: WorkspaceIntakeContent;
}

export type WorkspaceIntakeAudit = {
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
};

export interface WorkspaceIntakeRequest {
  tags?: string[];
  userId: string;
  orgId?: string | null;
  /**
   * The public `workspace` value: a workspace UUID, slug, former slug or name
   * (see parseWorkspaceInput). A UUID must exist; a slug or name that matches
   * none of the caller's workspaces creates one with that display name and
   * slug. Omitted: the org's default workspace, unless `newWorkspace` or
   * `templateKey` asks for a fresh self-titled workspace. "default" always
   * means the default workspace.
   */
  workspace?: string | null;
  /** Without `workspace`: a fresh self-titled workspace instead of the default. Ignored when `workspace` is given. */
  newWorkspace?: boolean;
  templateKey?: WorkspaceTemplateKey;
  /**
   * An API key's workspace allowlist. A restricted key only ever resolves
   * workspaces inside it and can never create one.
   */
  allowedWorkspaceIds?: readonly string[] | null;
  /**
   * Per-request overrides, merged onto the workspace pipeline. Template-locked
   * settings always keep the template's value.
   */
  pipeline?: PipelineFeatureOverrides;
  /**
   * Indexing mode for these documents; defaults to the workspace's. Stamps
   * `documents.indexing_mode` even when it differs from the workspace. Ignored
   * (treated as `full`) while DOCSLURP_DEFERRED_PROFILES is off.
   */
  indexingMode?: IndexingMode;
  apiKeyId?: string | null;
  kind: WorkspaceIntakeKind;
  items: Iterable<WorkspaceIntakeItem> | AsyncIterable<WorkspaceIntakeItem>;
  /** Remote URLs behind the items; used for the title and redacted audit origins. */
  urls?: string[];
  /** Sources that skip files themselves (connectors) may legitimately yield nothing. */
  mayBeEmpty?: boolean;
  audit?: WorkspaceIntakeAudit;
}

export interface StoredIntakeFile {
  tags?: string[];
  /** Measured while storing source bytes; absent for already-stored sources. */
  fileSize?: number;
  filename: string;
  mimeType: string;
  sourceKey: string;
  metadata?: Record<string, unknown>;
  canonicalId?: string | null;
  path?: string | null;
}

export interface WorkspaceIntakeResult {
  workspace: WorkspaceRecord;
  pipeline: PipelineFeatures;
  run: CreatedRun["run"];
  documents: CreatedRun["documents"];
  /** Set when the run exists but processing could not start yet. */
  deferredReason: string | null;
  /** Files that were not accepted, with why. Empty when every file was taken. */
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
  /** A workspace the scope may use that a UUID, slug or name names (see findWorkspaceForInput). */
  findWorkspace(
    ref: Extract<WorkspaceInputRef, { kind: "id" } | { kind: "slug" }>,
    scope: WorkspaceInputScope,
  ): Promise<WorkspaceRecord | null>;
  defaultWorkspace(args: { userId: string; orgId?: string | null }): Promise<WorkspaceRecord>;
  createWorkspace(args: {
    userId: string;
    orgId?: string;
    name: string;
    /** Preferred slug (a `workspace` value's slug); suffixed when another workspace holds it. */
    slug?: string;
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
  }): Promise<CreatedRun>;
  /** Remove a workspace this request created when intake failed before any run existed. */
  discardWorkspace(workspaceId: string): Promise<void>;
  appendAudit(entry: Parameters<typeof appendAuditLog>[0]): Promise<void>;
}

export interface WorkspaceIntakePorts {
  storage: RawSourceStorage;
  records: WorkspaceIntakeRecords;
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
  async findWorkspace(ref, scope) {
    const found = await findWorkspaceForInput(ref, scope);
    return found ? await getWorkspace(found.id, scope.userId) : null;
  },
  defaultWorkspace: ensureDefaultWorkspace,
  async createWorkspace({ autoNamed, pipeline: overrides, ...args }) {
    // The uploader's Processing defaults seed the new workspace; the template
    // and upload overrides go on top, and template locks win.
    const defaults = await getUserSettings(args.userId).then((settings) => settings.general, () => null);
    const template = getWorkspaceTemplate(args.templateKey ?? null);
    const base = seedPipelineFromProcessingDefaults(
      normalizePipelineFeatures(template?.pipeline ?? { ...defaultPipelineFeatures, summarize: true }),
      defaults,
    );
    const pipeline = applyWorkspacePipelineOverrides(base, overrides, template);
    // Leave the mode unset unless the upload chose one, so createWorkspace applies the plan default.
    const { indexingMode, ...pipelineWithoutMode } = pipeline;
    const workspace = await createWorkspace({
      ...args,
      summaries: pipeline.summarize,
      pipeline: overrides?.indexingMode !== undefined ? pipeline : (pipelineWithoutMode as typeof pipeline),
    });
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
  async createRun({ files, ...args }) {
    return await runCreation.create({ ...args, sources: { kind: "files", files } });
  },
  async discardWorkspace(workspaceId) {
    await deleteWorkspaceData(workspaceId);
  },
  async appendAudit(entry) {
    await appendAuditLog(entry);
  },
};

export const workspaceIntakePorts: WorkspaceIntakePorts = {
  storage: objectStorage,
  records: postgresIntakeRecords,
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
  if ("rejected" in item.content) throw item.content.rejected;
  const admitted = admitIntakeFile(
    { filename: item.filename, mimeType: item.mimeType, sizeBytes: declaredSize(item) },
    request.kind,
  );
  const stored = (sourceKey: string, fileSize?: number): StoredIntakeFile => ({
    ...admitted,
    sourceKey,
    ...(fileSize === undefined ? {} : { fileSize }),
    ...(item.metadata ? { metadata: item.metadata } : {}),
    ...(request.tags ? { tags: request.tags } : {}),
    ...(item.canonicalId ? { canonicalId: item.canonicalId } : {}),
    ...(item.path ? { path: item.path } : {}),
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

/**
 * The workspace an intake lands in, resolved before any bytes are read: an
 * existing workspace, or what to create (name and preferred slug) when the
 * request asks for a new one or names one that does not exist yet.
 */
async function resolveIntakeTarget(
  request: WorkspaceIntakeRequest,
  records: WorkspaceIntakeRecords,
): Promise<{ existing: WorkspaceRecord } | { create: { name?: string; slug?: string } }> {
  const ref = parseWorkspaceInput(request.workspace);
  if (ref.kind === "invalid") {
    throw new WorkspaceIntakeError(ref.message, 400, [{ path: "workspace", message: "workspace must contain a letter or digit", code: "invalid_value" }]);
  }
  const scope: WorkspaceInputScope = { userId: request.userId, orgId: request.orgId ?? null, allowedWorkspaceIds: request.allowedWorkspaceIds ?? null };
  const restricted = (request.allowedWorkspaceIds?.length ?? 0) > 0;
  const create = (target: { name?: string; slug?: string }) => {
    if (restricted) {
      throw new WorkspaceIntakeError("This API key is limited to specific workspaces and cannot create new ones.", 403);
    }
    return { create: target };
  };

  if (ref.kind === "default") {
    // An explicit "default" always means the default workspace; an omitted one unless a new workspace is asked for.
    const explicit = Boolean(request.workspace?.trim());
    if (!explicit && (request.newWorkspace || request.templateKey)) return create({});
    return { existing: await records.defaultWorkspace({ userId: request.userId, orgId: request.orgId }) };
  }
  if (ref.kind === "id") {
    const existing = await records.findWorkspace(ref, scope);
    if (!existing) throw workspaceInputNotFoundError({ id: ref.id });
    return { existing };
  }
  const existing = await records.findWorkspace(ref, scope);
  return existing ? { existing } : create({ name: ref.name, slug: ref.slug });
}

/** Every file was rejected: fail the request, naming each file. */
function allRejectedError(rejected: RejectedIntakeFile[]): WorkspaceIntakeError {
  const statuses = new Set(rejected.map((file) => file.statusCode));
  const statusCode = (statuses.size === 1 ? rejected[0]!.statusCode : 422) as WorkspaceIntakeStatusCode;
  const message = rejected.length === 1
    ? rejected[0]!.message
    : `None of the ${rejected.length} files could be accepted: ${rejected.map((file) => `${file.filename} (${file.message})`).join("; ")}`;
  return new WorkspaceIntakeError(message, statusCode, rejected.map((file) => ({ path: file.filename, message: file.message, code: file.code })));
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
  let created: CreatedRun;

  try {
    // The target is resolved before any bytes are read or stored.
    const target = await resolveIntakeTarget(request, records);
    const existing = "existing" in target ? target.existing : null;
    const toCreate = "create" in target ? target.create : {};

    const files: StoredIntakeFile[] = [];
    for await (const item of request.items) {
      try {
        files.push(await storeItem(item, request, storage, written));
      } catch (error) {
        // One bad file never fails the request: take the rest and report this one.
        if (!(error instanceof WorkspaceIntakeError)) throw error;
        const filename = "rejected" in item.content ? item.filename : sanitizeUploadFilename(item.filename);
        rejected.push({ filename, statusCode: error.statusCode, code: rejectionCode(error), message: error.message });
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
          toCreate.name ??
          (request.urls?.length
            ? inferWorkspaceTitleFromUrls(request.urls)
            : inferWorkspaceTitleFromFilenames(files.map((file) => file.filename))),
        ...(toCreate.slug ? { slug: toCreate.slug } : {}),
        templateKey: request.templateKey,
        pipeline: request.indexingMode ? { ...request.pipeline, indexingMode: request.indexingMode } : request.pipeline,
        autoNamed: !toCreate.name,
      }));
    if (!existing) createdWorkspaceId = workspace.id;
    // A new workspace already carries the overrides; an existing one merges them.
    pipeline = applyWorkspacePipelineOverrides(
      workspace.pipeline ?? defaultPipelineFeatures,
      existing ? request.pipeline : undefined,
      workspace.templateKey,
    );
    // Per-request mode wins over the workspace's; both are pinned to full while the flag is off.
    pipeline = {
      ...pipeline,
      indexingMode: effectiveIndexingMode(request.indexingMode ?? pipeline.indexingMode),
    };
    try {
      created = await records.createRun({
        userId: request.userId,
        workspaceId: workspace.id,
        kind: request.kind,
        pipeline,
        apiKeyId: request.apiKeyId,
        files,
      });
    } catch (error) {
      if (!(error instanceof AllSourcesUnreadableError)) throw error;
      // Every remaining file was unreadable: report them together with the files screened out earlier.
      for (const unreadable of error.errors) {
        rejected.push({ filename: unreadable.filename, statusCode: 422, code: "unreadable_source", message: unreadable.message });
      }
      throw allRejectedError(rejected);
    }
    for (const file of created.unreadable) {
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

  // The Run and its Documents are committed (and started or deferred) from
  // here on, so later steps degrade instead of throwing.
  const { run, documents, deferredReason } = created;

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
