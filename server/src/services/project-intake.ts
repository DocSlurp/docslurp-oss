/**
 * Project Intake: the one path that turns new source material into a Run in
 * a project. Every source kind (bulk upload bytes, fetched URLs, a completed
 * Direct Upload Session, connector files, automation sources) is a thin adapter
 * that yields `ProjectIntakeItem`s; this module owns everything after that:
 *
 * - the validation policy (type, size, remote parser surface)
 * - the raw storage key layout and the raw object-storage write
 * - project resolution / auto-create, including self-titling
 * - creating the Run and its Documents
 * - starting or deferring processing
 * - the audit trail
 *
 * Raw objects written by a failed intake are removed before the error surfaces.
 */
import { randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";

import {
  applyProjectPipelineOverrides,
  DOPPLER_MAX_PDF_BYTES,
  defaultPipelineFeatures,
  getProjectTemplate,
  isUntitledProjectName,
  normalizePipelineFeatures,
  parseProjectInput,
  type ProjectInputRef,
  type PipelineFeatureOverrides,
  type PipelineFeatures,
  type ProjectRecord,
  type ProjectTemplateKey,
  type IndexingMode,
} from "@docslurp/shared";

import { env } from "../config.js";
import { isReservedCanonicalId } from "../lib/canonical-id.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { deleteUploadedObject, uploadFile, uploadFileStream } from "../lib/storage.js";
import { isSupportedUploadMimeType, resolveUploadMimeType } from "../lib/upload-policy.js";
import { appendAuditLog } from "./audit-log.js";
import { explainRemoteIngestBlock, isComplexRemoteIngestFormat } from "./remote-parser-surface.js";
import { runCreation, type CreatedRun } from "./run-creation.js";
import { AllSourcesUnreadableError } from "./source-metadata.js";
import { assertVisualModeAllowed, effectiveIndexingMode } from "./project-indexing-mode.js";
import { inferProjectTitleFromFilenames, inferProjectTitleFromUrls, markProjectAutoNamed, nameProjectFromUpload } from "./project-naming.js";
import { seedPipelineFromProcessingDefaults, seedSearchSettingsFromProcessingDefaults } from "./processing-defaults.js";
import { updateProjectSearchSettingsForUser } from "./search-controls.js";
import { getUserSettings } from "./user-settings.js";
import { deleteProjectData } from "./data-deletion.js";
import { projectInputNotFoundError } from "./default-project.js";
import { createProject, ensureDefaultProject, findProjectForInput, getProject, type ProjectInputScope } from "./projects.js";

/** The run kind doubles as the source kind; it picks the validation policy. */
export type ProjectIntakeKind =
  | "bulk-upload"
  | "direct-upload"
  | "url-ingest"
  | "connector-sync";

export type ProjectIntakeStatusCode = 400 | 403 | 404 | 409 | 413 | 415 | 422 | 500;

export class ProjectIntakeError extends Error {
  constructor(
    message: string,
    readonly statusCode: ProjectIntakeStatusCode,
    readonly issues?: Array<{ path: string; message: string; code: string }>,
    readonly code?: "remote_format_disabled",
  ) {
    super(message);
    this.name = "ProjectIntakeError";
  }
}

/**
 * Source bytes an adapter hands over: in memory, streaming, or already stored.
 * An adapter that could not produce one source (a URL that failed to fetch, an
 * upload that never completed) yields it as `rejected`, so intake reports that
 * file and carries on with the rest.
 */
export type ProjectIntakeContent =
  | { bytes: Buffer }
  | { stream: Readable; contentLength?: number }
  | { storedKey: string; /** Object-store size verified by the server, never a client declaration. */ verifiedSizeBytes?: number }
  | { rejected: ProjectIntakeError };

export interface ProjectIntakeItem {
  filename: string;
  mimeType?: string | null;
  /** Declared size; in-memory bytes and stream content lengths take precedence. */
  sizeBytes?: number | null;
  metadata?: Record<string, unknown>;
  /** Logical source identity; a newer completed document with the same ID supersedes older ones. */
  canonicalId?: string | null;
  /** Folder path inside the upload (no filename). With the filename it is the version key unless `canonicalId` is set. */
  path?: string | null;
  content: ProjectIntakeContent;
}

export type ProjectIntakeAudit = {
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
};

export interface ProjectIntakeRequest {
  speedBoost?: boolean;
  tags?: string[];
  userId: string;
  orgId?: string | null;
  /**
   * The public `project` value: a project UUID, slug, former slug or name
   * (see parseProjectInput). A UUID must exist; a slug or name that matches
   * none of the caller's projects creates one with that display name and
   * slug. Omitted: the org's default project, unless `newProject` or
   * `templateKey` asks for a fresh self-titled project. "default" always
   * means the default project.
   */
  project?: string | null;
  /** Without `project`: a fresh self-titled project instead of the default. Ignored when `project` is given. */
  newProject?: boolean;
  templateKey?: ProjectTemplateKey;
  /**
   * An API key's project allowlist. A restricted key only ever resolves
   * projects inside it and can never create one.
   */
  allowedProjectIds?: readonly string[] | null;
  /**
   * Per-request overrides, merged onto the project pipeline. Template-locked
   * settings always keep the template's value.
   */
  pipeline?: PipelineFeatureOverrides;
  /**
   * Indexing mode for these documents; defaults to the project's. Stamps
   * `documents.indexing_mode` even when it differs from the project. Ignored
   * (treated as `full`) while DOCSLURP_DEFERRED_PROFILES is off.
   */
  indexingMode?: IndexingMode;
  runId?: string;
  apiKeyId?: string | null;
  kind: ProjectIntakeKind;
  items: Iterable<ProjectIntakeItem> | AsyncIterable<ProjectIntakeItem>;
  /** Remote URLs behind the items; used for the title and redacted audit origins. */
  urls?: string[];
  /** Sources that skip files themselves (connectors) may legitimately yield nothing. */
  mayBeEmpty?: boolean;
  audit?: ProjectIntakeAudit;
  /**
   * Extract mode: sources and every derived asset go under the extract's
   * storage prefix and are deleted when its retention ends (services/extracts.ts).
   */
  extract?: IntakeExtract;
}

/** The extract a request belongs to; server-created, never read from HTTP input. */
export interface IntakeExtract {
  id: string;
  /** extracts/<org>/<extract>, without a trailing slash. */
  storagePrefix: string;
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

export interface ProjectIntakeResult {
  project: ProjectRecord;
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
  code: "unsupported_type" | "remote_format_disabled" | "file_too_large" | "unreadable_source" | "rejected";
  message: string;
}

function rejectionCode(error: ProjectIntakeError): RejectedIntakeFile["code"] {
  if (error.code === "remote_format_disabled") return error.code;
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

export interface ProjectIntakeRecords {
  /** A project the scope may use that a UUID, slug or name names (see findProjectForInput). */
  findProject(
    ref: Extract<ProjectInputRef, { kind: "id" } | { kind: "slug" }>,
    scope: ProjectInputScope,
  ): Promise<ProjectRecord | null>;
  defaultProject(args: { userId: string; orgId?: string | null }): Promise<ProjectRecord>;
  createProject(args: {
    userId: string;
    orgId?: string;
    name: string;
    /** Preferred slug (a `project` value's slug); suffixed when another project holds it. */
    slug?: string;
    templateKey?: ProjectTemplateKey;
    /** Upload overrides for the new project's pipeline (merged onto its template). */
    pipeline?: PipelineFeatureOverrides;
    autoNamed: boolean;
  }): Promise<ProjectRecord>;
  createRun(args: {
    speedBoost?: boolean;
    userId: string;
    projectId: string;
    kind: ProjectIntakeKind;
    pipeline: PipelineFeatures;
    runId?: string;
  apiKeyId?: string | null;
    files: StoredIntakeFile[];
    extract?: IntakeExtract;
  }): Promise<CreatedRun>;
  /** Remove a project this request created when intake failed before any run existed. */
  discardProject(projectId: string): Promise<void>;
  /**
   * Re-titles an automatically named existing project from an upload (see
   * nameProjectFromUpload). Returns the new name, or null when unchanged.
   */
  nameFromUpload?(args: { projectId: string; filenames: string[]; urls?: string[] }): Promise<string | null>;
  appendAudit(entry: Parameters<typeof appendAuditLog>[0]): Promise<void>;
}

export interface ProjectIntakePorts {
  storage: RawSourceStorage;
  records: ProjectIntakeRecords;
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

export const postgresIntakeRecords: ProjectIntakeRecords = {
  async findProject(ref, scope) {
    const found = await findProjectForInput(ref, scope);
    return found ? await getProject(found.id, scope.userId) : null;
  },
  defaultProject: ensureDefaultProject,
  async createProject({ autoNamed, pipeline: overrides, ...args }) {
    // The uploader's Processing defaults seed the new project; the template
    // and upload overrides go on top, and template locks win.
    const defaults = await getUserSettings(args.userId).then((settings) => settings.general, () => null);
    const template = getProjectTemplate(args.templateKey ?? null);
    const base = seedPipelineFromProcessingDefaults(
      normalizePipelineFeatures(template?.pipeline ?? { ...defaultPipelineFeatures, summarize: true }),
      defaults,
    );
    const pipeline = applyProjectPipelineOverrides(base, overrides, template);
    // Leave the mode unset unless the upload chose one, so createProject applies the plan default.
    const { indexingMode, ...pipelineWithoutMode } = pipeline;
    const project = await createProject({
      ...args,
      summaries: pipeline.summarize,
      pipeline: overrides?.indexingMode !== undefined ? pipeline : (pipelineWithoutMode as typeof pipeline),
    });
    const searchSeed = seedSearchSettingsFromProcessingDefaults(defaults);
    if (searchSeed) {
      await updateProjectSearchSettingsForUser({ projectId: project.id, userId: args.userId, input: searchSeed })
        .catch((error: unknown) => {
          console.error(`[intake] could not seed search settings for project=${project.id}:`, error instanceof Error ? error.message : String(error));
        });
    }
    if (autoNamed) await markProjectAutoNamed(project.id, args.userId, project.name);
    return project;
  },
  async createRun({ files, ...args }) {
    return await runCreation.create({ ...args, sources: { kind: "files", files } });
  },
  async discardProject(projectId) {
    await deleteProjectData(projectId);
  },
  nameFromUpload: nameProjectFromUpload,
  async appendAudit(entry) {
    await appendAuditLog(entry);
  },
};

export const projectIntakePorts: ProjectIntakePorts = {
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

function isRemoteKind(kind: ProjectIntakeKind): kind is keyof typeof remoteSourceLabels {
  return kind in remoteSourceLabels;
}

function intakeByteLimit(filename: string, mimeType?: string | null): number {
  const dopplerPdf = resolveUploadMimeType(mimeType ?? null, filename) === "application/pdf" &&
    (process.env.DOCSLURP_DOPPLER_INSTALLED === "1" || process.env.DOCSLURP_PDF_EXTRACTOR === "doppler");
  return dopplerPdf ? Math.min(env.maxUploadBytes, DOPPLER_MAX_PDF_BYTES) : env.maxUploadBytes;
}

/** The one validation policy for every intake source. */
export function screenIntakeFile(
  file: { filename: string; mimeType?: string | null; sizeBytes?: number | null },
  kind: ProjectIntakeKind,
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
  const maxBytes = intakeByteLimit(filename, declared);
  if (typeof file.sizeBytes === "number" && file.sizeBytes > maxBytes) {
    return {
      ok: false,
      filename,
      reason: "size",
      statusCode: 413,
      message: `${filename} exceeds MAX_UPLOAD_BYTES for this route (${maxBytes} bytes)`,
    };
  }
  return { ok: true, filename, mimeType: resolveUploadMimeType(declared, filename) };
}

export function admitIntakeFile(
  file: { filename: string; mimeType?: string | null; sizeBytes?: number | null },
  kind: ProjectIntakeKind,
): { filename: string; mimeType: string } {
  const verdict = screenIntakeFile(file, kind);
  if (!verdict.ok) throw new ProjectIntakeError(verdict.message, verdict.statusCode, undefined, verdict.reason === "parser-surface" ? "remote_format_disabled" : undefined);
  return verdict;
}

/**
 * The one raw-object key layout. The filename is sanitized here so a caller
 * that forgets cannot inject `..` segments. Extract sources live under the
 * extract's prefix so its sweep removes them with everything else.
 */
export function rawSourceKey(userId: string, filename: string, extract?: IntakeExtract | null): string {
  const safe = sanitizeUploadFilename(filename, "upload.bin");
  if (extract) return `${extract.storagePrefix}/raw/${randomUUID()}-${safe}`;
  return `${userId}/${randomUUID()}/raw/${randomUUID()}-${safe}`;
}

// ---------------------------------------------------------------------------
// Self-titling and audit redaction.

export { inferProjectTitleFromFilenames, inferProjectTitleFromUrls };

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

function declaredSize(item: ProjectIntakeItem): number | null {
  if ("bytes" in item.content) return item.content.bytes.byteLength;
  if ("stream" in item.content && typeof item.content.contentLength === "number") {
    return item.content.contentLength;
  }
  return item.sizeBytes ?? null;
}

/** Pipes a stream through a byte counter that fails once it passes the upload cap. */
function boundedStream(stream: Readable, maxBytes: number, onOverflow: () => void, onBytes: (total: number) => void): Readable {
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      total += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      onBytes(total);
      if (total > maxBytes) {
        onOverflow();
        callback(new Error(`Upload exceeds MAX_UPLOAD_BYTES (${maxBytes} bytes)`));
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
  item: ProjectIntakeItem,
  request: ProjectIntakeRequest,
  storage: RawSourceStorage,
  written: string[],
): Promise<StoredIntakeFile> {
  if ("rejected" in item.content) throw item.content.rejected;
  // Server-minted identities only (lib/canonical-id.ts); a source adapter that passes one through is refused per file.
  if (item.canonicalId && isReservedCanonicalId(item.canonicalId)) {
    throw new ProjectIntakeError(`${sanitizeUploadFilename(item.filename)}: canonicalId must not start with docslurp: (reserved)`, 400);
  }
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
  if ("storedKey" in content) {
    // An extract only takes sources already inside its own prefix; anything else would outlive it.
    if (request.extract && !content.storedKey.startsWith(`${request.extract.storagePrefix}/`)) {
      throw new ProjectIntakeError(`${admitted.filename} was not uploaded for this extract`, 400);
    }
    return stored(content.storedKey, content.verifiedSizeBytes);
  }

  const key = rawSourceKey(request.userId, admitted.filename, request.extract);
  written.push(key);
  if ("bytes" in content) {
    await storage.put(key, content, admitted.mimeType);
    return stored(key, content.bytes.byteLength);
  }

  let overflowed = false;
  let measuredBytes = 0;
  const maxBytes = intakeByteLimit(admitted.filename, admitted.mimeType);
  const body = boundedStream(content.stream, maxBytes, () => {
    overflowed = true;
  }, (total) => { measuredBytes = total; });
  try {
    await storage.put(key, { stream: body, contentLength: content.contentLength }, admitted.mimeType);
  } catch (error) {
    if (overflowed) {
      throw new ProjectIntakeError(
        `${admitted.filename} exceeds MAX_UPLOAD_BYTES (${maxBytes} bytes)`,
        413,
      );
    }
    throw new ProjectIntakeError(error instanceof Error ? error.message : String(error), 400);
  } finally {
    body.destroy();
  }
  return stored(key, measuredBytes);
}

/**
 * The project an intake lands in, resolved before any bytes are read: an
 * existing project, or what to create (name and preferred slug) when the
 * request asks for a new one or names one that does not exist yet.
 */
async function resolveIntakeTarget(
  request: ProjectIntakeRequest,
  records: ProjectIntakeRecords,
): Promise<{ existing: ProjectRecord } | { create: { name?: string; slug?: string } }> {
  const ref = parseProjectInput(request.project);
  if (ref.kind === "invalid") {
    throw new ProjectIntakeError(ref.message, 400, [{ path: "project", message: "project must contain a letter or digit", code: "invalid_value" }]);
  }
  const scope: ProjectInputScope = { userId: request.userId, orgId: request.orgId ?? null, allowedProjectIds: request.allowedProjectIds ?? null };
  const restricted = (request.allowedProjectIds?.length ?? 0) > 0;
  const create = (target: { name?: string; slug?: string }) => {
    if (restricted) {
      throw new ProjectIntakeError("This API key is limited to specific projects and cannot create new ones.", 403);
    }
    return { create: target };
  };

  if (ref.kind === "default") {
    // An explicit "default" always means the default project; an omitted one unless a new project is asked for.
    const explicit = Boolean(request.project?.trim());
    if (!explicit && (request.newProject || request.templateKey)) return create({});
    return { existing: await records.defaultProject({ userId: request.userId, orgId: request.orgId }) };
  }
  if (ref.kind === "id") {
    const existing = await records.findProject(ref, scope);
    if (!existing) throw projectInputNotFoundError({ id: ref.id });
    return { existing };
  }
  const existing = await records.findProject(ref, scope);
  return existing ? { existing } : create({ name: ref.name, slug: ref.slug });
}

/** Every file was rejected: fail the request, naming each file. */
function allRejectedError(rejected: RejectedIntakeFile[]): ProjectIntakeError {
  const statuses = new Set(rejected.map((file) => file.statusCode));
  const statusCode = (statuses.size === 1 ? rejected[0]!.statusCode : 422) as ProjectIntakeStatusCode;
  const message = rejected.length === 1
    ? rejected[0]!.message
    : `None of the ${rejected.length} files could be accepted: ${rejected.map((file) => `${file.filename} (${file.message})`).join("; ")}`;
  return new ProjectIntakeError(message, statusCode, rejected.map((file) => ({ path: file.filename, message: file.message, code: file.code })), rejected.every(file => file.code === "remote_format_disabled") ? "remote_format_disabled" : undefined);
}

/**
 * Takes source items into a project: validates and stores each one, resolves
 * or creates the project, creates the Run and Documents, starts or defers
 * processing, and records the audit trail. Returns null only when a
 * `mayBeEmpty` source yields no items.
 */
export async function intakeIntoProject(
  request: ProjectIntakeRequest,
  ports: ProjectIntakePorts = projectIntakePorts,
): Promise<ProjectIntakeResult | null> {
  const { storage, records } = ports;
  const written: string[] = [];
  const rejected: RejectedIntakeFile[] = [];
  // Set only when this request created the project, so a failed intake can remove it again.
  let createdProjectId: string | null = null;
  let project: ProjectRecord;
  let pipeline: PipelineFeatures;
  let created: CreatedRun;

  try {
    // The target is resolved before any bytes are read or stored.
    const target = await resolveIntakeTarget(request, records);
    const existing = "existing" in target ? target.existing : null;
    const toCreate = "create" in target ? target.create : {};
    // "Untitled project" is the placeholder for "name it for me", not a chosen name.
    const chosenName = toCreate.name && !isUntitledProjectName(toCreate.name) ? toCreate.name : undefined;

    const files: StoredIntakeFile[] = [];
    for await (const item of request.items) {
      try {
        files.push(await storeItem(item, request, storage, written));
      } catch (error) {
        // One bad file never fails the request: take the rest and report this one.
        if (!(error instanceof ProjectIntakeError)) throw error;
        const filename = "rejected" in item.content ? item.filename : sanitizeUploadFilename(item.filename);
        rejected.push({ filename, statusCode: error.statusCode, code: rejectionCode(error), message: error.message });
      }
    }
    if (files.length === 0) {
      if (request.mayBeEmpty) return null;
      if (rejected.length > 0) throw allRejectedError(rejected);
      throw new ProjectIntakeError("Attach at least one file.", 400);
    }

    project =
      existing ??
      (await records.createProject({
        userId: request.userId,
        orgId: request.orgId ?? undefined,
        name:
          chosenName ??
          (request.urls?.length
            ? inferProjectTitleFromUrls(request.urls)
            : inferProjectTitleFromFilenames(files.map((file) => file.filename))),
        ...(toCreate.slug ? { slug: toCreate.slug } : {}),
        templateKey: request.templateKey,
        pipeline: request.indexingMode ? { ...request.pipeline, indexingMode: request.indexingMode } : request.pipeline,
        autoNamed: !chosenName,
      }));
    if (!existing) createdProjectId = project.id;
    // A new project already carries the overrides; an existing one merges them.
    pipeline = applyProjectPipelineOverrides(
      project.pipeline ?? defaultPipelineFeatures,
      existing ? request.pipeline : undefined,
      project.templateKey,
    );
    // Per-request mode wins over the project's; both are pinned to full while the flag is off.
    pipeline = {
      ...pipeline,
      speedBoost: request.speedBoost === true,
      indexingMode: effectiveIndexingMode(request.indexingMode ?? pipeline.indexingMode),
    };
    // Per-request overrides (quality, indexingMode) are merged unvalidated above: refuse Fast with visual mode
    // before any run exists. The overrides apply to the whole request, so the whole request is refused (400).
    if (pipeline.indexingMode === "visual") assertVisualModeAllowed(pipeline);
    try {
      created = await records.createRun({
        userId: request.userId,
        projectId: project.id,
        kind: request.kind,
        speedBoost: request.speedBoost === true,
        pipeline,
        apiKeyId: request.apiKeyId,
        runId: request.runId,
        files,
        ...(request.extract ? { extract: request.extract } : {}),
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
    // No run was created, so a project made for this request would be left empty and titled after rejected files.
    if (createdProjectId) {
      await records.discardProject(createdProjectId).catch((cleanupError: unknown) => {
        console.error(`[intake] could not remove project=${createdProjectId} after intake failed:`, cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      });
    }
    throw error;
  }

  // The Run and its Documents are committed (and started or deferred) from
  // here on, so later steps degrade instead of throwing.
  const { run, documents, deferredReason } = created;

  // A new project was already titled from this batch; an existing untitled or
  // filename-titled one is re-titled from its files.
  if (!createdProjectId && records.nameFromUpload && documents.length > 0) {
    const renamed = await records.nameFromUpload({
      projectId: project.id,
      filenames: documents.map((document) => document.filename),
      ...(request.urls?.length ? { urls: request.urls } : {}),
    }).catch((error: unknown) => {
      console.error(`[intake] could not re-title project=${project.id}:`, error instanceof Error ? error.message : String(error));
      return null;
    });
    if (renamed) project = { ...project, name: renamed };
  }

  const audit = request.audit;
  await appendIntakeAudit(records, {
    orgId: project.orgId ?? run.orgId,
    userId: request.userId,
    projectId: project.id,
    runId: run.id,
    apiKeyId: request.apiKeyId ?? null,
    action: "documents.uploaded",
    resourceType: "run",
    resourceId: run.id,
    ipAddress: audit?.ipAddress,
    metadata: {
      count: documents.length,
      mode: request.kind,
      ...(request.extract ? { extractId: request.extract.id } : {}),
      ...(request.urls
        ? { urlCount: request.urls.length, urlOrigins: auditUrlOrigins(request.urls) }
        : {}),
      ...(audit?.userAgent ? { userAgent: audit.userAgent } : {}),
      ...(audit?.metadata ?? {}),
    },
  });

  return { project, pipeline, run, documents, deferredReason, rejected };
}

/**
 * The upload audit entry is written after the Run is committed and started.
 * One retry covers a transient database error; a second failure is logged
 * loudly rather than turning a committed upload into an HTTP 500.
 */
async function appendIntakeAudit(
  records: ProjectIntakeRecords,
  entry: Parameters<ProjectIntakeRecords["appendAudit"]>[0],
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
