import { reportPublicError } from "../lib/public-errors.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  documentTagsSchema,
  isDefaultWorkspaceAlias,
  pipelineFeatureOverridesSchema,
  workspaceTemplateKeySchema,
  indexingModeSchema,
} from "@docslurp/shared";

import { requestIp, requestUserAgent } from "../lib/request-context.js";
import {
  canonicalIdsForFiles,
  normalizeUploadPath,
  sourcePathsForFiles,
  InvalidCanonicalIdError,
  MAX_CANONICAL_ID_LENGTH,
} from "../lib/canonical-id.js";
import { actorHasAnyApiKeyScope, apiKeyCanUseWorkspace, getRequestActor, loadActorScopedWorkspace, requireActorWorkspace } from "../lib/request-actor.js";
import { validationErrorResponse, type ValidationErrorSource, validationHook } from "../lib/validation.js";
import {
  abortDirectUploadSession,
  completeDirectUploadFile,
  createDirectUploadSession,
  getDirectUploadSessionDescription,
  directUploadSessionBelongsToOrganization,
} from "../services/direct-upload-session.js";
import { isRunCreationBlockedError } from "../services/runs.js";
import { UnreadableSourceError } from "../services/source-metadata.js";
import { WorkspaceAccessError } from "../services/default-workspace.js";
import {
  confirmDirectUploadWorkspaceIntake,
  createBulkWorkspaceIntake,
  createRemoteUrlWorkspaceIntake,
  parseFormWorkspaceIntakePipeline,
  parseFormDocumentTags,
  parseWorkspaceIntakePipeline,
  parseWorkspaceIntakeTemplateKey,
} from "../services/workspace-intake-actions.js";
import {
  WorkspaceIntakeError,
  wantsNewWorkspace,
  workspaceIntakePorts,
  type WorkspaceIntakePorts,
} from "../services/workspace-intake.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { findDefaultWorkspace, getWorkspace } from "../services/workspaces.js";
import { estimateUpload } from "../services/work-estimates.js";
import { billingState } from "../services/config-change.js";

type Uploadable = File | string | Array<File | string> | undefined;

const canonicalIdSchema = z.string().trim().min(1).max(MAX_CANONICAL_ID_LENGTH);

const sourcePathSchema = z.string().max(1024).superRefine((value, ctx) => {
  try {
    normalizeUploadPath(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid path" });
  }
});

const ingestUrlSchema = z.object({
  tags: documentTagsSchema.optional(),
  orgId: z.string().optional(),
  workspaceId: z.string().optional(),
  newWorkspace: z.boolean().optional(),
  workspaceName: z.string().optional(),
  templateKey: workspaceTemplateKeySchema.optional(),
  indexingMode: indexingModeSchema.optional(),
  /** Plain URLs default their canonical ID to the URL; objects may override it. */
  urls: z.array(z.union([
    z.string().url(),
    z.object({ url: z.string().url(), canonicalId: canonicalIdSchema.optional() }),
  ])).min(1),
  pipeline: pipelineFeatureOverridesSchema.optional(),
});

const directUploadFileSchema = z.object({
  singlePart: z.boolean().optional(),
  filename: z.string().min(1).max(512),
  mimeType: z.string().min(1).max(256),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(16).max(128).optional(),
  canonicalId: canonicalIdSchema.optional(),
  /** Folder path inside the upload; with the filename it is the version key. */
  path: sourcePathSchema.optional(),
});

const createDirectSessionSchema = z.object({
  tags: documentTagsSchema.optional(),
  orgId: z.string().optional(),
  workspaceId: z.string().optional(),
  newWorkspace: z.boolean().optional(),
  workspaceName: z.string().optional(),
  templateKey: workspaceTemplateKeySchema.optional(),
  pipeline: pipelineFeatureOverridesSchema.optional(),
  files: z.array(directUploadFileSchema).min(1),
});

const completeDirectFileSchema = z.object({
  fileId: z.string().min(1),
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

const uploadValidationHook = (
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

function parseCanonicalIds(
  files: File[],
  body: Record<string, unknown>,
): Array<string | null> {
  try {
    return canonicalIdsForFiles(files.map((file) => file.name), {
      canonicalId: body.canonicalId,
      canonicalIds: body.canonicalIds,
    });
  } catch (error) {
    if (error instanceof InvalidCanonicalIdError) throw new WorkspaceIntakeError(error.message, 400);
    throw error;
  }
}

function parseSourcePaths(files: File[], body: Record<string, unknown>): string[] {
  try {
    return sourcePathsForFiles(files.length, { path: body.path, paths: body.paths });
  } catch (error) {
    if (error instanceof InvalidCanonicalIdError) throw new WorkspaceIntakeError(error.message, 400);
    throw error;
  }
}

function normalizeFiles(entry: Uploadable): File[] {
  if (!entry) {
    return [];
  }
  if (Array.isArray(entry)) {
    return entry.filter((item): item is File => item instanceof File);
  }
  return entry instanceof File ? [entry] : [];
}

function runCreationErrorResponse(c: Context, error: unknown): Response | null {
  if (!isRunCreationBlockedError(error)) {
    return null;
  }

  return apiStatusError(c, error.statusCode, error.message, { code: error.code });
}

function workspaceIntakeErrorResponse(
  c: Context,
  error: unknown,
): Response | null {
  if (error instanceof WorkspaceAccessError) {
    return apiStatusError(c, error.status, error.message, { code: error.code });
  }
  if (error instanceof UnreadableSourceError) {
    return apiStatusError(c, error.statusCode, error.message, { code: error.code });
  }
  if (!(error instanceof WorkspaceIntakeError)) {
    return null;
  }

  return apiStatusError(c, error.statusCode, error.message, error.issues ? { details: { issues: error.issues } } : {});
}

/**
 * A workspace-scoped API key may target its allowlisted workspaces but must not
 * create a new one (which would land outside the allowlist). Session users are
 * unrestricted. Security finding SEC-2026-10-07.
 */
function apiKeyMayCreateWorkspace(c: Context): boolean {
  const apiKey = c.get("apiKey");
  return !apiKey || (apiKey.workspaceIds ?? []).length === 0;
}

/** `ports` lets tests drive the real routes against fake storage, records, and workflow start. */
export const createUploadsRoutes = (ports: WorkspaceIntakePorts = workspaceIntakePorts) => acceptApiKeys(new Hono()
  .use("*", async (c, next) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest"])) {
      return apiStatusError(c, 403, "Forbidden");
    }

    if (actor.type === "apiKey") {
      if (!actor.apiKey.orgId) return apiStatusError(c, 403, "Forbidden");
      const sessionMatch = c.req.path.match(/\/direct\/sessions\/([^/]+)(?:\/|$)/);
      if (sessionMatch && !await directUploadSessionBelongsToOrganization(sessionMatch[1], actor.userId, actor.apiKey.orgId)) {
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
        if (typeof body.workspaceId === "string" && body.workspaceId
          && !isDefaultWorkspaceAlias(body.workspaceId)
          && !await loadActorScopedWorkspace(body.workspaceId, actor)) {
          return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
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
        if (wantsNewWorkspace(input) && !input.workspaceId && !apiKeyMayCreateWorkspace(c)) {
          return apiStatusError(c, 403, "Workspace-scoped API keys cannot create new workspaces", { code: "workspace_scope_forbidden" });
        }
        // Resolve the target now (UUID, slug, former slug, `default` or the
        // default for an omitted ID): confirm treats a null target as "create one".
        const workspace = wantsNewWorkspace(input) && !input.workspaceId
          ? null
          : await requireActorWorkspace(getRequestActor(c), input.workspaceId, orgId);
        const workspaceId = workspace?.id ?? null;
        // Overrides only; confirm merges them onto the workspace pipeline and its template locks.
        const pipeline = parseWorkspaceIntakePipeline(input.pipeline);
        const session = await createDirectUploadSession({
          userId,
          orgId,
          workspaceId,
          workspaceName: input.workspaceName ?? null,
          templateKey: input.templateKey ?? null,
          pipeline,
          files: input.files,
          tags: input.tags,
        });
        return c.json(session, 201);
      } catch (error) {
        const response = workspaceIntakeErrorResponse(c, error);
        if (response) return response;
        throw error;
      }
    },
  )
  .get("/direct/sessions/:sessionId", async (c) => {
    const userId = c.get("sessionUser").id;
    const sessionId = c.req.param("sessionId");
    const session = await getDirectUploadSessionDescription(sessionId, userId);
    if (!session) {
      return apiStatusError(c, 404, "Upload session not found");
    }
    return c.json(session);
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
          parts: body.parts,
        });
      } catch (error) {
        return (
          workspaceIntakeErrorResponse(c, error) ??
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
      result = await confirmDirectUploadWorkspaceIntake({
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
        workspaceIntakeErrorResponse(c, error) ??
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
    const requestedWorkspaceId =
      typeof body.workspaceId === "string" && body.workspaceId.length > 0
        ? body.workspaceId
        : null;
    const requestedNewWorkspace = body.newWorkspace === "true";
    const requestedWorkspaceName =
      typeof body.workspaceName === "string" &&
      body.workspaceName.trim().length > 0
        ? body.workspaceName.trim()
        : null;
    const requestedTemplateKey =
      parseWorkspaceIntakeTemplateKey(body.templateKey);

    if (requestedNewWorkspace && !requestedWorkspaceId && !apiKeyMayCreateWorkspace(c)) {
      return apiStatusError(c, 403, "Workspace-scoped API keys cannot create new workspaces", { code: "workspace_scope_forbidden" });
    }

    let result;
    try {
      const canonicalIds = parseCanonicalIds(files, body);
      const paths = parseSourcePaths(files, body);
      const pipeline = parseFormWorkspaceIntakePipeline(body.pipeline);
      result = await createBulkWorkspaceIntake({
        userId,
        orgId,
        workspaceId: requestedWorkspaceId,
        newWorkspace: requestedNewWorkspace,
        workspaceName: requestedWorkspaceName,
        templateKey: requestedTemplateKey,
        indexingMode: indexingModeSchema.safeParse(body.indexingMode).data,
        pipeline,
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
        workspaceIntakeErrorResponse(c, error) ??
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
      if (body.newWorkspace && !body.workspaceId && !apiKeyMayCreateWorkspace(c)) {
        return apiStatusError(c, 403, "Workspace-scoped API keys cannot create new workspaces", { code: "workspace_scope_forbidden" });
      }
      let result;
      try {
        result = await createRemoteUrlWorkspaceIntake({
          userId,
          orgId: c.get("apiKey")?.orgId ?? body.orgId,
          workspaceId: body.workspaceId ?? null,
          newWorkspace: body.newWorkspace,
          workspaceName: body.workspaceName?.trim() || null,
          templateKey: body.templateKey,
          indexingMode: body.indexingMode,
          pipeline: body.pipeline,
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
          workspaceIntakeErrorResponse(c, error) ??
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

const uploadEstimateSchema = z.object({
  files: z.array(z.object({
    name: z.string().min(1).max(1024),
    size: z.number().int().nonnegative(),
    pages: z.number().int().positive().optional(),
  })).min(1).max(1000),
  workspaceId: z.string().optional(),
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
    // Same gate as the upload itself: ingest scope, bound to the key's organization and workspaces.
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest"])) {
      return apiErrorResponse(c, 403, "forbidden", "Forbidden");
    }
    // Read-only: an estimate never creates the default workspace.
    const workspace = body.workspaceId
      ? await getWorkspace(body.workspaceId, userId)
      : await findDefaultWorkspace({ userId, orgId: actor.type === "apiKey" ? actor.apiKey.orgId : body.orgId });
    if (!workspace || (actor.type === "apiKey" && !apiKeyCanUseWorkspace(actor.apiKey, workspace))) {
      return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    }
    const estimate = await estimateUpload({ files: body.files, workspace });
    return c.json({ estimate, billing: billingState() });
  },
);
acceptApiKeys(uploadEstimateRoutes);
