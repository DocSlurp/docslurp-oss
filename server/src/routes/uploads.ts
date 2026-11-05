import { reportPublicError } from "../lib/public-errors.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  documentTagsSchema,
  isBillingExemptOrg,
  pipelineFeatureOverridesSchema,
  PROJECT_INPUT_MAX_LENGTH,
  projectTemplateKeySchema,
  indexingModeSchema,
  estimateCardRevision,
  quoteFileSchema,
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
  createDirectUploadSession,
  describeDirectUploadSession,
  getDirectUploadSessionDescription,
  loadDirectUploadSession,
  directUploadSessionBelongsToOrganization,
  signDirectUploadParts,
} from "../services/direct-upload-session.js";
import { assertSessionReplayable, createSessionIdempotently } from "../services/direct-session-idempotency.js";
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
  parseProjectIntakeTemplateKey,
} from "../services/project-intake-actions.js";
import {
  ProjectIntakeError,
  projectIntakePorts,
  type ProjectIntakePorts,
} from "../services/project-intake.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
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
  pipeline: pipelineFeatureOverridesSchema.optional(),
});

export const directUploadFileSchema = z.object({
  /** The client's own id for this file, echoed on the session's file and on a rejection. */
  clientId: z.string().min(1).max(128).optional(),
  singlePart: z.boolean().optional(),
  filename: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(256),
  sizeBytes: z.number().int().nonnegative().optional(),
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
  pipeline: pipelineFeatureOverridesSchema.optional(),
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
    .optional(),
});

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

  return apiStatusError(c, error.statusCode, error.message, { ...(error.code ? { code: error.code } : {}), ...(error.issues ? { details: { issues: error.issues } } : {}) });
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
      if (sessionMatch && !await directUploadSessionBelongsToOrganization(sessionMatch[1], actor.userId, actor.apiKey.orgId, actorAllowedProjectIds(actor))) {
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
            projectId: target.projectId,
            projectName: target.projectName,
            templateKey: input.templateKey ?? null,
            pipeline,
            files: input.files,
            tags: input.tags,
          }),
          describe: async (sessionId) => {
            // A replay is authorized like any session route: same organization, same key, inside the key's project allowlist.
            const loaded = await loadDirectUploadSession(sessionId, userId);
            if (!loaded) return null;
            assertSessionReplayable(loaded.session, { orgId, apiKeyId: actor.type === "apiKey" ? actor.apiKey.keyId : null, allowedProjectIds: actorAllowedProjectIds(actor) });
            return await describeDirectUploadSession(loaded);
          },
        });
        if (replayed) c.header("Idempotency-Replayed", "true");
        return c.json(session, status);
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
    const session = await getDirectUploadSessionDescription(sessionId, userId, c.req.query("statusOnly") === "true");
    if (!session) {
      return apiStatusError(c, 404, "Upload session not found");
    }
    return c.json(session);
  })
  .post("/direct/sessions/:sessionId/files/:fileId/parts/sign",
    zValidator("json", z.object({ partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(100) }), validationHook),
    async c => {
      try { return c.json(await signDirectUploadParts(c.req.param("sessionId"), c.get("sessionUser").id, c.req.param("fileId"), c.req.valid("json").partNumbers)); }
      catch (error) { return projectIntakeErrorResponse(c, error) ?? apiStatusError(c, 500, reportPublicError(error)); }
    })
  .post(
    "/direct/sessions/:sessionId/files/complete",
    zValidator("json", completeDirectFileSchema, validationHook),
    async (c) => {
      const userId = c.get("sessionUser").id;
      const sessionId = c.req.param("sessionId");
      const body = c.req.valid("json");
      try {
        await completeDirectUploadFile({
          sessionId,
          userId,
          fileId: body.fileId,
          etag: body.etag,
          sizeBytes: body.sizeBytes,
          parts: body.parts,
        });
      } catch (error) {
        return (
          projectIntakeErrorResponse(c, error) ??
          apiStatusError(c, 400, reportPublicError(error))
        );
      }

      return c.json({ ok: true });
    },
  )
  .post("/direct/sessions/:sessionId/abort", async (c) => {
    const userId = c.get("sessionUser").id;
    const sessionId = c.req.param("sessionId");
    const aborted = await abortDirectUploadSession(sessionId, userId);
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
        apiStatusError(c, 500, reportPublicError(error))
      );
    }

    if (result.temporalDeferred) {
      c.header("X-Temporal-Deferred", "true");
    }

    return c.json(result.payload, result.status);
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

    return c.json(result.payload, result.status);
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
        result = await createRemoteUrlProjectIntake({
          userId,
          orgId: c.get("apiKey")?.orgId ?? body.orgId,
          project: body.project?.trim() || null,
          newProject: body.newProject,
          templateKey: body.templateKey,
          allowedProjectIds: actorAllowedProjectIds(getRequestActor(c)),
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

      return c.json(result.payload, result.status);
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

const uploadEstimateSchema = z.object({
  speedBoost: z.boolean().optional(),
  files: z.array(quoteFileSchema).min(1).max(1000),
  project: projectInputSchema.optional(),
  orgId: z.string().optional(),
});

/** `POST /v1/uploads/estimate`: what ingesting these files would cost and take, before anything is stored. */
export const uploadEstimateRoutes = new Hono().post(
  "/estimate",
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
    const { estimate, media, profile } = await estimateUpload({ files: body.files, project, speedBoost: body.speedBoost === true });
    // `orgId` is the organization whose credits the upload would spend, for reading its balance. `profile` and
    // `cardRevision` let offline estimators quote later batches for this project and notice a newer card.
    return c.json({
      estimate,
      media,
      profile,
      cardRevision: estimateCardRevision(),
      billing: billingState(),
      orgId: project.orgId,
      billingExempt: isBillingExemptOrg(project.orgId),
    });
  },
);
acceptApiKeys(uploadEstimateRoutes);
