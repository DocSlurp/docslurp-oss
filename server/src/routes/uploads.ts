import { uploadContentIdentitySchema } from "@docslurp/shared";
import { reportPublicError } from "../lib/public-errors.js";
import { CHART_EXPORT_TIER_UNAVAILABLE_CODE, chartExportOverrideSchema } from "@docslurp/shared";
import { chartExportOverrideError } from "../services/chart-export-availability.js";
import { chartTierForVisuals, QuoteSettingsError, normalizeQuoteSettingsInput, VISUALS_UNAVAILABLE_CODE, visualsLevelSchema } from "@docslurp/shared";
import { deprecatedPipelineFields, deprecatedReprocessFields, markDeprecatedFields } from "../lib/deprecation.js";
import { runOriginOf } from "../lib/run-origin.js";
import { withPayloadCanEdit } from "../lib/reprocess-access.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  documentTagsSchema,
  isBillingExemptOrg,
  pipelineFeatureOverridesSchema,
  publicPipelineFeatureOverridesSchema,
  PROJECT_INPUT_MAX_LENGTH,
  projectTemplateKeySchema,
  indexingModeSchema,
  quoteFileSchema,
  quoteSettingsSchema,
  pricingVersion,
} from "@docslurp/shared";

import { requestIp, requestUserAgent } from "../lib/request-context.js";
import {
  canonicalIdsForFiles,
  normalizeUploadPath,
  sourcePathsForFiles,
  InvalidCanonicalIdError,
  isReservedCanonicalId,
  MAX_CANONICAL_ID_LENGTH,
} from "../lib/canonical-id.js";
import { actorHasAnyApiKeyScope, apiKeyCanUseProject, getRequestActor, lookupActorProject, requireActorProject, type RequestActor } from "../lib/request-actor.js";
import { validationErrorResponse, type ValidationErrorSource, validationHook } from "../lib/validation.js";
import {
  abortDirectUploadSession,
  completeDirectUploadFile,
  completeDirectUploadFiles,
  createDirectUploadSession,
  getDirectUploadSessionDescription,
  MAX_DESCRIBE_FILE_IDS,
  loadDirectUploadSession,
  loadDirectUploadSessionRow,
  directUploadSessionBelongsToOrganization,
  signDirectUploadParts,
} from "../services/direct-upload-session.js";
import { assertSessionReplayable, assertSessionProjectStillReadable, assertSessionProjectStillContributable, createSessionIdempotently } from "../services/direct-session-idempotency.js";
import { parseIdempotencyKey } from "../services/idempotency.js";
import { isRunCreationBlockedError } from "../services/runs.js";
import { UnreadableSourceError } from "../services/source-metadata.js";
import { ProjectAccessError } from "../services/default-project.js";
import {
  confirmDirectUploadProjectIntake,
  createBulkProjectIntake,
  createRemoteUrlProjectIntake,
  parseFormProjectIntakePipeline,
  parseFormDocumentTags,
  parseProjectIntakePipeline,
  assertIntakeChartExportTier,
  parseProjectIntakeTemplateKey,
} from "../services/project-intake-actions.js";
import {
  ProjectIntakeError,
  projectIntakePorts,
  type ProjectIntakePorts,
} from "../services/project-intake.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { MAX_DIRECT_UPLOAD_COMPLETE_BATCH } from "../lib/direct-upload-limits.js";
import { env } from "../config.js";
import { isTransientStorageError } from "../lib/storage-retry.js";
import { kickDirectUploadReconcile } from "../services/direct-upload-reconciler.js";
import { apiErrorResponse, apiStatusError, nativeBodyLimit } from "../lib/api-error.js";
import { findDefaultProject, getProject } from "../services/projects.js";
import { IndexingModeError } from "../services/project-indexing-mode.js";
import { indexingModeErrorResponse } from "../lib/indexing-mode-error.js";
import { projectInputNotFoundError } from "../services/default-project.js";
import { estimateUpload } from "../services/work-estimates.js";
import { ExtractError } from "../services/extracts.js";
import { billingState } from "../services/config-change.js";

type Uploadable = File | string | Array<File | string> | undefined;

export const canonicalIdSchema = z.string().trim().min(1).max(MAX_CANONICAL_ID_LENGTH)
  .refine((value) => !isReservedCanonicalId(value), "canonicalId must not start with docslurp: (reserved)");

/** The public `project` field: a project UUID, slug, former slug or name; created when no project matches. */
export const projectInputSchema = z.string().max(PROJECT_INPUT_MAX_LENGTH);

/** GET /direct/sessions/:id (unless status only), part signing, file completion and confirm: the routes that mint URLs or ingest. */
export function sessionRouteNeedsContribute(method: string, path: string, statusOnly: boolean): boolean {
  if (method === "GET") return /\/direct\/sessions\/[^/]+\/?$/.test(path) && !statusOnly;
  return method === "POST" && /\/direct\/sessions\/[^/]+\/(?:files\/[^/]+\/parts\/sign|files\/complete|confirm)\/?$/.test(path);
}

/** A restricted API key's project allowlist (null for sessions and unrestricted keys). */
export function actorAllowedProjectIds(actor: RequestActor): readonly string[] | null {
  return actor.type === "apiKey" && actor.apiKey.projectIds?.length ? actor.apiKey.projectIds : null;
}

export const sourcePathSchema = z.string().max(1024).superRefine((value, ctx) => {
  try {
    normalizeUploadPath(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid path" });
  }
});

const ingestUrlSchema = z.object({
  speedBoost: z.boolean().optional(),
  tags: documentTagsSchema.optional(),
  orgId: z.string().optional(),
  project: projectInputSchema.optional(),
  newProject: z.boolean().optional(),
  templateKey: projectTemplateKeySchema.optional(),
  indexingMode: indexingModeSchema.optional(),
  /** Plain URLs default their canonical ID to the URL; objects may override it. */
  urls: z.array(z.union([
    z.string().url(),
    z.object({ url: z.string().url(), canonicalId: canonicalIdSchema.optional() }),
  ])).min(1),
  pipeline: publicPipelineFeatureOverridesSchema.optional(),
});

export const directUploadFileSchema = z.object({
  /** The client's own id for this file, echoed on the session's file and on a rejection. */
  clientId: z.string().min(1).max(128).optional(),
  singlePart: z.boolean().optional(),
  filename: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(256),
  sizeBytes: z.number().int().nonnegative().optional(),
  identity: uploadContentIdentitySchema.optional(),
  sha256: z.string().min(16).max(128).optional(),
  canonicalId: canonicalIdSchema.optional(),
  /** Folder path inside the upload; with the filename it is the version key. */
  path: sourcePathSchema.optional(),
});

const createDirectSessionSchema = z.object({
  speedBoost: z.boolean().optional(),
  indexingMode: indexingModeSchema.optional(),
  tags: documentTagsSchema.optional(),
  orgId: z.string().optional(),
  project: projectInputSchema.optional(),
  newProject: z.boolean().optional(),
  templateKey: projectTemplateKeySchema.optional(),
  pipeline: publicPipelineFeatureOverridesSchema.optional(),
  files: z.array(directUploadFileSchema).min(1).max(1000),
});

const completeDirectFileSchema = z.object({
  fileId: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  etag: z.string().optional(),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        etag: z.string().min(1),
      }),
    )
    .max(10_000)
    .optional(),
});

/**
 * One batch entry: only what completion uses. Storage's own part list is authoritative, so a batch carries no part
 * manifest; unknown fields are refused rather than walked.
 */
const completeBatchEntrySchema = z.object({
  fileId: z.string().min(1).max(64),
  etag: z.string().max(128).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
}).strict();

/** `{ files: [...] }`: up to 100 entries, each fileId once. */
export const completeDirectFilesBatchSchema = z.object({
  files: z.array(completeBatchEntrySchema).min(1).max(MAX_DIRECT_UPLOAD_COMPLETE_BATCH),
}).strict().superRefine((body, ctx) => {
  if (new Set(body.files.map(file => file.fileId)).size !== body.files.length) {
    ctx.addIssue({ code: "custom", path: ["files"], message: "Each fileId may appear once per request" });
  }
});

/** The legacy single-file body, a 10,000-part manifest included: about 0.7 MB at most. */
const COMPLETE_SINGLE_BODY_MAX_BYTES = 1024 * 1024;
/** 100 entries of the largest allowed shape (about 250 bytes each) fit in 32 KiB. */
export const COMPLETE_BATCH_BODY_MAX_BYTES = 32 * 1024;

type CompleteBody =
  | { kind: "batch"; files: z.infer<typeof completeBatchEntrySchema>[] }
  | { kind: "single"; body: z.infer<typeof completeDirectFileSchema> };

/**
 * Parses `files/complete` (one file, or `{ files }`) with cheap structural checks first, so an oversized or deeply
 * nested payload is refused before schema validation walks it. A body naming both shapes is refused.
 */
async function parseCompleteBody(c: Context): Promise<CompleteBody | Response> {
  const text = await c.req.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { return apiStatusError(c, 400, "Invalid JSON body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return apiStatusError(c, 400, "Invalid request");
  const record = body as Record<string, unknown>;
  if ("files" in record) {
    if (Buffer.byteLength(text) > COMPLETE_BATCH_BODY_MAX_BYTES) {
      return apiErrorResponse(c, 413, "payload_too_large", `A completion batch body may not exceed ${COMPLETE_BATCH_BODY_MAX_BYTES} bytes`, { maxBytes: COMPLETE_BATCH_BODY_MAX_BYTES });
    }
    if (!Array.isArray(record.files) || record.files.length < 1 || record.files.length > MAX_DIRECT_UPLOAD_COMPLETE_BATCH) {
      return apiStatusError(c, 400, `files must list between 1 and ${MAX_DIRECT_UPLOAD_COMPLETE_BATCH} entries`);
    }
    const parsed = completeDirectFilesBatchSchema.safeParse(record);
    if (!parsed.success) return validationErrorResponse(c, parsed.error, "Invalid request", 400);
    return { kind: "batch", files: parsed.data.files };
  }
  if (Array.isArray(record.parts) && record.parts.length > 10_000) return apiStatusError(c, 400, "parts may list at most 10000 entries");
  const parsed = completeDirectFileSchema.safeParse(record);
  if (!parsed.success) return validationErrorResponse(c, parsed.error, "Invalid request", 400);
  return { kind: "single", body: parsed.data };
}

export const uploadValidationHook = (
  result: { success: boolean; error?: ValidationErrorSource },
  c: Context,
) => {
  if (result.success) {
    return;
  }

  return validationErrorResponse(
    c,
    result.error ?? new z.ZodError([]),
    "Invalid pipeline payload",
  );
};

export function parseCanonicalIds(
  files: File[],
  body: Record<string, unknown>,
): Array<string | null> {
  try {
    return canonicalIdsForFiles(files.map((file) => file.name), {
      canonicalId: body.canonicalId,
      canonicalIds: body.canonicalIds,
    });
  } catch (error) {
    if (error instanceof InvalidCanonicalIdError) throw new ProjectIntakeError(error.message, 400);
    throw error;
  }
}

export function parseSourcePaths(files: File[], body: Record<string, unknown>): string[] {
  try {
    return sourcePathsForFiles(files.length, { path: body.path, paths: body.paths });
  } catch (error) {
    if (error instanceof InvalidCanonicalIdError) throw new ProjectIntakeError(error.message, 400);
    throw error;
  }
}

export function normalizeFiles(entry: Uploadable): File[] {
  if (!entry) {
    return [];
  }
  if (Array.isArray(entry)) {
    return entry.filter((item): item is File => item instanceof File);
  }
  return entry instanceof File ? [entry] : [];
}

export function runCreationErrorResponse(c: Context, error: unknown): Response | null {
  if (!isRunCreationBlockedError(error)) {
    return null;
  }

  return apiStatusError(c, error.statusCode, error.message, { code: error.code });
}

export function projectIntakeErrorResponse(
  c: Context,
  error: unknown,
): Response | null {
  // Fast (or a refused privacy policy) with visual indexing, from the request's overrides (run-creation.ts).
  if (error instanceof IndexingModeError) return indexingModeErrorResponse(c, error);
  if (error instanceof ProjectAccessError) {
    return apiStatusError(c, error.status, error.message, { code: error.code, details: error.details });
  }
  // A direct extract session confirmed after its extract expired (run-creation.ts).
  if (error instanceof ExtractError) return apiErrorResponse(c, error.status, error.code, error.message);
  if (error instanceof UnreadableSourceError) {
    return apiStatusError(c, error.statusCode, error.message, { code: error.code });
  }
  if (!(error instanceof ProjectIntakeError)) {
    return null;
  }

  // Retryable session states tell the client when to repeat the same request.
  if (error.code === "upload_storage_unavailable") c.header("Retry-After", String(UPLOAD_STORAGE_RETRY_AFTER_SECONDS));
  if (error.code === "upload_session_busy") c.header("Retry-After", "1");
  return apiStatusError(c, error.statusCode, error.message, { ...(error.code ? { code: error.code } : {}), ...(error.issues ? { details: { issues: error.issues } } : {}) });
}

const UPLOAD_STORAGE_RETRY_AFTER_SECONDS = 5;
/** How long confirm and abort wait out another holder of the session lock before answering 409 upload_session_busy. */
const CONFIRM_LOCK_WAIT_MS = 10_000;
/** Abort waits like the other short session calls (DOCSLURP_UPLOAD_LOCK_WAIT_MS). */
const abortLockWaitMs = () => env.directUploadLockWaitMs;

/**
 * The answer for an unexpected failure on an upload-session route. A storage provider or network failure is a
 * retryable 503 (`upload_storage_unavailable`, Retry-After), never a client error; anything else is a 500. Either way
 * the raw error goes to the log only.
 */
export function uploadServerErrorResponse(c: Context, error: unknown): Response {
  if (isTransientStorageError(error)) {
    reportPublicError(error);
    c.header("Retry-After", String(UPLOAD_STORAGE_RETRY_AFTER_SECONDS));
    return apiStatusError(c, 503, "Upload storage is temporarily unavailable; retry shortly", { code: "upload_storage_unavailable" });
  }
  return apiStatusError(c, 500, reportPublicError(error));
}

/**
 * A project-scoped API key may target its allowlisted projects but must not
 * create a new one (which would land outside the allowlist). Session users are
 * unrestricted. Security finding SEC-2026-10-07.
 */
export function apiKeyMayCreateProject(c: Context): boolean {
  const apiKey = c.get("apiKey");
  return !apiKey || (apiKey.projectIds ?? []).length === 0;
}

/** `ports` lets tests drive the real routes against fake storage, records, and workflow start. */
export const createUploadsRoutes = (ports: ProjectIntakePorts = projectIntakePorts) => acceptApiKeys(new Hono()
  .use("*", async (c, next) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["ingest"]))) {
      return apiStatusError(c, 403, "Forbidden");
    }

    const sessionMatch = c.req.path.match(/\/direct\/sessions\/([^/]+)(?:\/|$)/);
    if (sessionMatch && !z.string().uuid().safeParse(sessionMatch[1]).success) {
      return apiStatusError(c, 400, "Invalid upload session ID");
    }
    if (actor.type === "apiKey") {
      if (!actor.apiKey.orgId) return apiStatusError(c, 403, "Forbidden");
      if (sessionMatch && !await directUploadSessionBelongsToOrganization(sessionMatch[1], actor.userId, actor.apiKey.orgId, actorAllowedProjectIds(actor), actor.apiKey.keyId)) {
        return apiStatusError(c, 404, "Upload session not found");
      }
      if (c.req.method === "POST" && /\/(bulk|url|direct\/sessions)\/?$/.test(c.req.path)) {
        let body: Record<string, unknown>;
        try {
          body = c.req.path.replace(/\/$/, "").endsWith("/bulk")
            ? await c.req.parseBody({ all: true })
            : await c.req.json();
        } catch {
          return apiStatusError(c, 400, "Invalid upload payload");
        }
        if (!body || typeof body !== "object") return apiStatusError(c, 400, "Invalid upload payload");
        if (typeof body.orgId === "string" && body.orgId.trim() && body.orgId.trim() !== actor.apiKey.orgId) {
          return apiStatusError(c, 403, "Forbidden");
        }
        // The `project` value itself is resolved inside the key's org and allowlist by intake.
      }
    }
    if (sessionMatch && c.req.method === "GET" && c.req.query("statusOnly") === "true") {
      const session = await loadDirectUploadSessionRow(sessionMatch[1], actor.userId);
      if (session) {
        try {
          await assertSessionProjectStillReadable(session, actor.userId);
        } catch (error) {
          return projectIntakeErrorResponse(c, error) ?? apiStatusError(c, 403, "Forbidden");
        }
      }
    }
    // Every route that mints signed upload URLs for an existing session, or ingests it, re-checks that this user may still
    // contribute to its project (a revoked or demoted share gets 403 and no URLs). Status-only reads and abort do not.
    if (sessionMatch && sessionRouteNeedsContribute(c.req.method, c.req.path, c.req.query("statusOnly") === "true")) {
      const session = await loadDirectUploadSessionRow(sessionMatch[1], actor.userId);
      if (session) {
        try {
          await assertSessionProjectStillContributable(session, actor.userId);
        } catch (error) {
          return projectIntakeErrorResponse(c, error) ?? apiStatusError(c, 403, "Forbidden");
        }
      }
    }
    await next();
  })
  .post(
    "/direct/sessions",
    zValidator("json", createDirectSessionSchema, uploadValidationHook),
    async (c) => {
      const userId = c.get("sessionUser").id;
      const input = c.req.valid("json");
      const orgId = c.get("apiKey")?.orgId ?? input.orgId ?? null;

      try {
        // Resolve the target now: an existing project's ID, or the name of
        // the project confirm creates (none: a self-titled one).
        const target = await directUploadTarget(getRequestActor(c), input, orgId);
        // Overrides only; confirm merges them onto the project pipeline and its template locks.
        const pipeline = parseProjectIntakePipeline({ ...input.pipeline, speedBoost: input.speedBoost === true, ...(input.indexingMode ? { indexingMode: input.indexingMode } : {}) });
        const actor = getRequestActor(c);
        const parsedKey = parseIdempotencyKey(c.req.header("Idempotency-Key"));
        if ("error" in parsedKey) return apiStatusError(c, 400, parsedKey.error);
        const { body: session, status, replayed } = await createSessionIdempotently({
          key: parsedKey.key,
          // The key and target are part of the scope: another key of this user, or a request for another project, never replays this session.
          scope: { orgId, userId, apiKeyId: c.get("apiKey")?.keyId ?? null, project: target.projectId ?? (target.projectName ? `name:${target.projectName}` : null) },
          request: input,
          create: () => createDirectUploadSession({
            userId,
            orgId,
            apiKeyId: c.get("apiKey")?.keyId ?? null,
            allowedProjectIds: actorAllowedProjectIds(actor),
            origin: runOriginOf(c),
            projectId: target.projectId,
            projectName: target.projectName,
            templateKey: input.templateKey ?? null,
            pipeline,
            files: input.files,
            tags: input.tags,
          }),
          discard: async (created) => { await abortDirectUploadSession(created.sessionId, userId); },
          describe: async (sessionId) => {
            // A replay is authorized like any session route: same organization, same key, inside the key's project allowlist.
            const loaded = await loadDirectUploadSession(sessionId, userId);
            if (!loaded) return null;
            assertSessionReplayable(loaded.session, { orgId, apiKeyId: actor.type === "apiKey" ? actor.apiKey.keyId : null, allowedProjectIds: actorAllowedProjectIds(actor) });
            // ... and the user may still contribute to that project (a share revoked since gets no URLs).
            await assertSessionProjectStillContributable(loaded.session, userId);
            return await getDirectUploadSessionDescription(sessionId, userId, false, undefined, undefined, c.get("apiKey")?.keyId ?? null);
          },
        });
        if (replayed) c.header("Idempotency-Replayed", "true");
        return c.json(await withPayloadCanEdit(c, session), status);
      } catch (error) {
        const response = projectIntakeErrorResponse(c, error);
        if (response) return response;
        throw error;
      }
    },
  )
  .get("/direct/sessions/:sessionId", async (c) => {
    const userId = c.get("sessionUser").id;
    const sessionId = c.req.param("sessionId");
    try {
    // `fileId` (repeatable) narrows a full read to the files a resuming client wants.
    const fileIds = c.req.queries("fileId");
    if (fileIds && (fileIds.length > MAX_DESCRIBE_FILE_IDS || fileIds.some(id => !id || id.length > 64))) {
      return apiStatusError(c, 400, `fileId may be given at most ${MAX_DESCRIBE_FILE_IDS} times, each a file id`);
    }
    const session = await getDirectUploadSessionDescription(sessionId, userId, c.req.query("statusOnly") === "true", c.req.raw.signal, fileIds?.length ? [...new Set(fileIds)] : undefined, c.get("apiKey")?.keyId ?? null);
    if (!session) {
      return apiStatusError(c, 404, "Upload session not found");
    }
    return c.json(await withPayloadCanEdit(c, session));
    } catch (error) { return projectIntakeErrorResponse(c, error) ?? apiStatusError(c, 500, reportPublicError(error)); }
  })
  .post("/direct/sessions/:sessionId/files/:fileId/parts/sign",
    zValidator("json", z.object({ partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(100) }), validationHook),
    async c => {
      try { return c.json(await signDirectUploadParts(c.req.param("sessionId"), c.get("sessionUser").id, c.req.param("fileId"), c.req.valid("json").partNumbers, c.get("apiKey")?.keyId ?? null)); }
      catch (error) { return projectIntakeErrorResponse(c, error) ?? apiStatusError(c, 500, reportPublicError(error)); }
    })
  .post(
    "/direct/sessions/:sessionId/files/complete",
    nativeBodyLimit(COMPLETE_SINGLE_BODY_MAX_BYTES),
    async (c) => {
      const userId = c.get("sessionUser").id;
      const sessionId = c.req.param("sessionId");
      const parsedBody = await parseCompleteBody(c);
      if (parsedBody instanceof Response) return parsedBody;
      if (parsedBody.kind === "batch") {
        const body = parsedBody;
        // Batch: per-file results; only a session-level problem (not found, closed, revoked, busy) fails the request.
        try {
          // A client that disconnects cancels this hold's storage work (fenced, so nothing half-published).
          const result = await completeDirectUploadFiles({ sessionId, userId, files: body.files, signal: c.req.raw.signal });
          // The last file is in: start ingestion now rather than at the next sweep (after this request's lock is released).
          if (result.sessionComplete) kickDirectUploadReconcile(sessionId);
          return c.json({ ok: result.failedCount === 0, ...result });
        } catch (error) {
          return projectIntakeErrorResponse(c, error) ?? uploadServerErrorResponse(c, error);
        }
      }
      const body = parsedBody.body;
      try {
        const completed = await completeDirectUploadFile({
          sessionId,
          userId,
          fileId: body.fileId,
          etag: body.etag,
          sizeBytes: body.sizeBytes,
          parts: body.parts,
          signal: c.req.raw.signal,
        });
        if (completed?.sessionComplete) kickDirectUploadReconcile(sessionId);
      } catch (error) {
        // Never a 400 for a server-side failure: a client would treat it as permanent and abandon the upload.
        return projectIntakeErrorResponse(c, error) ?? uploadServerErrorResponse(c, error);
      }

      return c.json({ ok: true });
    },
  )
  .post("/direct/sessions/:sessionId/abort", async (c) => {
    const userId = c.get("sessionUser").id;
    const sessionId = c.req.param("sessionId");
    let aborted: boolean;
    try {
      aborted = await abortDirectUploadSession(sessionId, userId, abortLockWaitMs());
    } catch (error) {
      // A held lock (the reconciler or another request) is a retryable 409 upload_session_busy; an ingested session 409.
      return projectIntakeErrorResponse(c, error) ?? uploadServerErrorResponse(c, error);
    }
    if (!aborted) {
      return apiStatusError(c, 404, "Upload session not found");
    }

    return c.json({ ok: true });
  })
  .post("/direct/sessions/:sessionId/confirm", async (c) => {
    const userId = c.get("sessionUser").id;
    const sessionId = c.req.param("sessionId");
    let result;
    try {
      result = await confirmDirectUploadProjectIntake({
        sessionId,
        userId,
        // A reconciler pass (or the kick after the last complete) may hold the session briefly: wait it out.
        lockWaitMs: CONFIRM_LOCK_WAIT_MS,
        audit: {
          ipAddress: requestIp(c),
          userAgent: requestUserAgent(c),
          metadata: { sessionId },
        },
      }, ports);
    } catch (error) {
      return (
        projectIntakeErrorResponse(c, error) ??
        runCreationErrorResponse(c, error) ??
        uploadServerErrorResponse(c, error)
      );
    }

    if (result.temporalDeferred) {
      c.header("X-Temporal-Deferred", "true");
    }

    return c.json(await withPayloadCanEdit(c, result.payload), result.status);
  })
  .post("/bulk", async (c) => {
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
    const body = await c.req.parseBody({ all: true });
    const userId = c.get("sessionUser").id;
    const orgId =
      typeof body.orgId === "string" && body.orgId.trim().length > 0
        ? body.orgId.trim()
        : c.get("apiKey")?.orgId ?? undefined;
    const files = normalizeFiles(body.files ?? body.file);
    const requestedProject =
      typeof body.project === "string" && body.project.trim().length > 0
        ? body.project.slice(0, PROJECT_INPUT_MAX_LENGTH)
        : null;
    const requestedNewProject = body.newProject === "true";
    const requestedTemplateKey =
      parseProjectIntakeTemplateKey(body.templateKey);

    if (!requestedProject && (requestedNewProject || requestedTemplateKey) && !apiKeyMayCreateProject(c)) {
      return apiStatusError(c, 403, "Project-scoped API keys cannot create new projects", { code: "project_scope_forbidden" });
    }

    let result;
    try {
      const canonicalIds = parseCanonicalIds(files, body);
      const paths = parseSourcePaths(files, body);
      const pipeline = parseFormProjectIntakePipeline(body.pipeline);
      const parsedBoost = z.enum(["true", "false"]).optional().safeParse(body.speedBoost);
      if (!parsedBoost.success) throw new ProjectIntakeError("speedBoost must be true or false", 400);
      const speedBoost = parsedBoost.data === "true";
      result = await createBulkProjectIntake({
        userId,
        orgId,
        project: requestedProject,
        newProject: requestedNewProject,
        templateKey: requestedTemplateKey,
        allowedProjectIds: actorAllowedProjectIds(getRequestActor(c)),
        origin: runOriginOf(c),
        apiKeyId: c.get("apiKey")?.keyId ?? null,
        indexingMode: indexingModeSchema.safeParse(body.indexingMode).data,
        pipeline,
        speedBoost,
        files,
        canonicalIds,
        tags: parseFormDocumentTags(body.tags),
        paths,
        idempotencyKey,
        contentLength: c.req.header("content-length"),
        audit: {
          ipAddress: requestIp(c),
          userAgent: requestUserAgent(c),
        },
      }, ports);
    } catch (error) {
      return (
        projectIntakeErrorResponse(c, error) ??
        runCreationErrorResponse(c, error) ??
        apiStatusError(c, 500, reportPublicError(error))
      );
    }
    if (result.idempotencyReplayed) {
      c.header("Idempotency-Replayed", "true");
    }
    if (result.temporalDeferred) {
      c.header("X-Temporal-Deferred", "true");
    }

    return c.json(await withPayloadCanEdit(c, result.payload), result.status);
  })
  .post(
    "/url",
    zValidator("json", ingestUrlSchema, uploadValidationHook),
    async (c) => {
      const userId = c.get("sessionUser").id;
      const body = c.req.valid("json");
      const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
      if (!body.project?.trim() && (body.newProject || body.templateKey) && !apiKeyMayCreateProject(c)) {
        return apiStatusError(c, 403, "Project-scoped API keys cannot create new projects", { code: "project_scope_forbidden" });
      }
      let result;
      try {
        // The same refusal as file uploads (400 chart_export_tier_unavailable), never a silent downgrade.
        assertIntakeChartExportTier(body.pipeline?.chartExport?.tier, "url ingest");
        result = await createRemoteUrlProjectIntake({
          userId,
          orgId: c.get("apiKey")?.orgId ?? body.orgId,
          project: body.project?.trim() || null,
          newProject: body.newProject,
          templateKey: body.templateKey,
          allowedProjectIds: actorAllowedProjectIds(getRequestActor(c)),
          origin: runOriginOf(c),
          apiKeyId: c.get("apiKey")?.keyId ?? null,
          indexingMode: body.indexingMode,
          pipeline: body.pipeline,
          speedBoost: body.speedBoost === true,
          tags: body.tags,
          urls: body.urls.map((entry) => typeof entry === "string" ? entry : entry.url),
          canonicalIds: body.urls.map((entry) => typeof entry === "string" ? null : entry.canonicalId ?? null),
          idempotencyKey,
          audit: {
            ipAddress: requestIp(c),
            userAgent: requestUserAgent(c),
          },
        }, ports);
      } catch (error) {
        return (
          projectIntakeErrorResponse(c, error) ??
          runCreationErrorResponse(c, error) ??
          apiStatusError(c, 500, reportPublicError(error))
        );
      }
      if (result.idempotencyReplayed) {
        c.header("Idempotency-Replayed", "true");
      }
      if (result.temporalDeferred) {
        c.header("X-Temporal-Deferred", "true");
      }

      return c.json(await withPayloadCanEdit(c, result.payload), result.status);
    },
  ));

export const uploadsRoutes = createUploadsRoutes();

/**
 * Where a direct upload session lands, decided at session creation: an
 * existing project's ID, or the name of the project to create at confirm
 * (neither: a self-titled one). Same rules as intakeIntoProject.
 */
export async function directUploadTarget(
  actor: RequestActor,
  input: { project?: string; newProject?: boolean; templateKey?: string },
  orgId: string | null,
): Promise<{ projectId: string | null; projectName: string | null }> {
  const lookup = await lookupActorProject(actor, input.project, orgId);
  const restricted = actorAllowedProjectIds(actor) !== null;
  const create = (projectName: string | null) => {
    if (restricted) throw new ProjectIntakeError("This API key is limited to specific projects and cannot create new ones.", 403);
    return { projectId: null, projectName };
  };
  if (lookup.ref.kind === "default") {
    const explicit = Boolean(input.project?.trim());
    if (!explicit && (input.newProject || input.templateKey)) return create(null);
    return { projectId: (await requireActorProject(actor, null, orgId)).id, projectName: null };
  }
  const found = "project" in lookup ? lookup.project : null;
  if (lookup.ref.kind === "id") {
    if (!found) throw projectInputNotFoundError({ id: lookup.ref.id });
    return { projectId: found.id, projectName: null };
  }
  return found ? { projectId: found.id, projectName: null } : create(lookup.ref.name);
}

/** Largest estimate request body: 1,000 files with a capped profile (FILE_PROFILE_MAX_BYTES) each, plus names. */
const UPLOAD_ESTIMATE_MAX_BODY_BYTES = 6 * 1024 * 1024;

const uploadEstimateSchema = z.object({
  speedBoost: z.boolean().optional(),
  /** Files by name, size and type, each optionally with a client file profile (`@docslurp/estimate`); untrusted, estimate only. */
  files: z.array(quoteFileSchema).min(1).max(1000),
  /** Knobs to quote with instead of the project's own (the same as `POST /v1/estimate`). */
  settings: quoteSettingsSchema.partial().optional(),
  /** Visuals for this estimate (`none` | `figures` | `charts` | `charts-ai`); only `charts-ai` is priced. */
  visuals: visualsLevelSchema.optional(),
  /** @deprecated Use `visuals`. The same per-request chart export override the upload takes; priced only for `models`. */
  chartExport: chartExportOverrideSchema.optional(),
  project: projectInputSchema.optional(),
  orgId: z.string().optional(),
});

/**
 * `POST /v1/uploads/estimate`: what ingesting these files would cost and take, before anything is stored. Files may carry a
 * file profile from the offline profiler; profiles are validated, clamped and used only to estimate. The upload itself is
 * billed by what the worker measures, never by a profile.
 */
export const uploadEstimateRoutes = new Hono().post(
  "/estimate",
  nativeBodyLimit(UPLOAD_ESTIMATE_MAX_BODY_BYTES),
  zValidator("json", uploadEstimateSchema),
  async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    const actor = getRequestActor(c);
    // Same gate as the upload itself: ingest scope, bound to the key's organization and projects.
    if (actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["ingest"]))) {
      return apiErrorResponse(c, 403, "forbidden", "Forbidden");
    }
    // Read-only: an estimate never creates a project, the default one included.
    const lookup = await lookupActorProject(actor, body.project, body.orgId);
    if (lookup.ref.kind !== "default" && "project" in lookup && !lookup.project) {
      throw projectInputNotFoundError(lookup.ref.kind === "slug" ? { slug: lookup.ref.slug } : { id: lookup.ref.id });
    }
    const project = "project" in lookup && lookup.project
      ? await getProject(lookup.project.id, userId)
      : await findDefaultProject({ userId, orgId: actor.type === "apiKey" ? actor.apiKey.orgId : body.orgId });
    if (!project || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project))) {
      return apiErrorResponse(c, 404, "project_not_found", "Project not found");
    }
    // After the scope and project checks: a caller that may not upload here never learns what the deployment offers.
    if (body.visuals && body.chartExport && chartTierForVisuals(body.visuals) !== body.chartExport.tier) {
      return apiStatusError(c, 400, "visuals conflicts with chartExport.tier; send visuals only", { code: "extraction_config_conflict", details: { field: "visuals" } });
    }
    let settings: typeof body.settings;
    try {
      settings = normalizeQuoteSettingsInput(body.settings);
    } catch (error) {
      if (!(error instanceof QuoteSettingsError)) throw error;
      return apiStatusError(c, 400, error.message, { code: "extraction_config_conflict", details: { field: "settings.visuals" } });
    }
    markDeprecatedFields(c, [
      ...deprecatedReprocessFields(body),
      ...(typeof body.settings?.quality === "string" && ["fast", "auto", "good"].includes(body.settings.quality) ? deprecatedPipelineFields({ quality: body.settings.quality }, "settings.") : []),
      ...(body.settings?.chartExport ? [{ code: "deprecated_field" as const, field: "settings.chartExport", replacement: "settings.visuals", message: "'settings.chartExport' is deprecated; use 'settings.visuals'." }] : []),
    ]);
    const requestedTier = body.visuals ? chartTierForVisuals(body.visuals) : body.chartExport?.tier ?? null;
    const refusedTier = chartExportOverrideError(requestedTier, "upload estimate");
    if (refusedTier) {
      return body.visuals
        ? apiStatusError(c, 400, refusedTier, { code: VISUALS_UNAVAILABLE_CODE, details: { field: "visuals" } })
        : apiStatusError(c, 400, refusedTier, { code: CHART_EXPORT_TIER_UNAVAILABLE_CODE, details: { field: "chartExport.tier" } });
    }
    const { estimate, media, profile, quote, chartExport } = await estimateUpload({
      files: body.files, project, speedBoost: body.speedBoost === true, settings,
      chartExportTier: requestedTier, origin: runOriginOf(c),
    });
    // `orgId` is the organization whose credits the upload would spend, for reading its balance. `profile` is the
    // project's settings the estimate priced with; `kind` labels the answer an estimate, never a charge.
    return c.json({
      kind: "estimate" as const,
      estimate,
      media,
      profile,
      pricingVersion: pricingVersion(),
      // The full estimate (ingest, monthly hosting and usage, lines) for the project's settings and any overrides.
      quote,
      // The chart export tier the upload would run with (request, project or the caller's default) and its credits.
      chartExport,
      billing: billingState(),
      orgId: project.orgId,
      billingExempt: isBillingExemptOrg(project.orgId),
    });
  },
);
acceptApiKeys(uploadEstimateRoutes);
