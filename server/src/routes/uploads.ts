import { reportPublicError } from "../lib/public-errors.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  documentTagsSchema,
  pipelineFeatureOverridesSchema,
  WORKSPACE_INPUT_MAX_LENGTH,
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
import { actorHasAnyApiKeyScope, apiKeyCanUseWorkspace, getRequestActor, lookupActorWorkspace, requireActorWorkspace, type RequestActor } from "../lib/request-actor.js";
import { validationErrorResponse, type ValidationErrorSource, validationHook } from "../lib/validation.js";
import {
  abortDirectUploadSession,
  completeDirectUploadFile,
  createDirectUploadSession,
  getDirectUploadSessionDescription,
  directUploadSessionBelongsToOrganization,
  signDirectUploadParts,
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
  workspaceIntakePorts,
  type WorkspaceIntakePorts,
} from "../services/workspace-intake.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { findDefaultWorkspace, getWorkspace } from "../services/workspaces.js";
import { workspaceInputNotFoundError } from "../services/default-workspace.js";
import { estimateUpload } from "../services/work-estimates.js";
import { billingState } from "../services/config-change.js";

type Uploadable = File | string | Array<File | string> | undefined;

const canonicalIdSchema = z.string().trim().min(1).max(MAX_CANONICAL_ID_LENGTH);

/** The public `workspace` field: a workspace UUID, slug, former slug or name; created when no workspace matches. */
const workspaceInputSchema = z.string().max(WORKSPACE_INPUT_MAX_LENGTH);

/** A restricted API key's workspace allowlist (null for sessions and unrestricted keys). */
function actorAllowedWorkspaceIds(actor: RequestActor): readonly string[] | null {
  return actor.type === "apiKey" && actor.apiKey.workspaceIds?.length ? actor.apiKey.workspaceIds : null;
}

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
  workspace: workspaceInputSchema.optional(),
  newWorkspace: z.boolean().optional(),
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
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().min(16).max(128).optional(),
  canonicalId: canonicalIdSchema.optional(),
  /** Folder path inside the upload; with the filename it is the version key. */
  path: sourcePathSchema.optional(),
});

const createDirectSessionSchema = z.object({
  indexingMode: indexingModeSchema.optional(),
  tags: documentTagsSchema.optional(),
  orgId: z.string().optional(),
  workspace: workspaceInputSchema.optional(),
  newWorkspace: z.boolean().optional(),
  templateKey: workspaceTemplateKeySchema.optional(),
  pipeline: pipelineFeatureOverridesSchema.optional(),
  files: z.array(directUploadFileSchema).min(1),
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

export function runCreationErrorResponse(c: Context, error: unknown): Response | null {
  if (!isRunCreationBlockedError(error)) {
    return null;
  }

  return apiStatusError(c, error.statusCode, error.message, { code: error.code });
}

export function workspaceIntakeErrorResponse(
  c: Context,
  error: unknown,
): Response | null {
  if (error instanceof WorkspaceAccessError) {
    return apiStatusError(c, error.status, error.message, { code: error.code, details: error.details });
  }
  if (error instanceof UnreadableSourceError) {
    return apiStatusError(c, error.statusCode, error.message, { code: error.code });
  }
  if (!(error instanceof WorkspaceIntakeError)) {
    return null;
  }

  return apiStatusError(c, error.statusCode, error.message, { ...(error.code ? { code: error.code } : {}), ...(error.issues ? { details: { issues: error.issues } } : {}) });
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
      if (sessionMatch && !await directUploadSessionBelongsToOrganization(sessionMatch[1], actor.userId, actor.apiKey.orgId, actorAllowedWorkspaceIds(actor))) {
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
        // The `workspace` value itself is resolved inside the key's org and allowlist by intake.
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
        // Resolve the target now: an existing workspace's ID, or the name of
        // the workspace confirm creates (none: a self-titled one).
        const target = await directUploadTarget(getRequestActor(c), input, orgId);
        // Overrides only; confirm merges them onto the workspace pipeline and its template locks.
        const pipeline = parseWorkspaceIntakePipeline({ ...input.pipeline, ...(input.indexingMode ? { indexingMode: input.indexingMode } : {}) });
        const session = await createDirectUploadSession({
          userId,
          orgId,
          apiKeyId: c.get("apiKey")?.keyId ?? null,
          allowedWorkspaceIds: actorAllowedWorkspaceIds(getRequestActor(c)),
          workspaceId: target.workspaceId,
          workspaceName: target.workspaceName,
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
      catch (error) { return workspaceIntakeErrorResponse(c, error) ?? apiStatusError(c, 500, reportPublicError(error)); }
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
    const requestedWorkspace =
      typeof body.workspace === "string" && body.workspace.trim().length > 0
        ? body.workspace.slice(0, WORKSPACE_INPUT_MAX_LENGTH)
        : null;
    const requestedNewWorkspace = body.newWorkspace === "true";
    const requestedTemplateKey =
      parseWorkspaceIntakeTemplateKey(body.templateKey);

    if (!requestedWorkspace && (requestedNewWorkspace || requestedTemplateKey) && !apiKeyMayCreateWorkspace(c)) {
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
        workspace: requestedWorkspace,
        newWorkspace: requestedNewWorkspace,
        templateKey: requestedTemplateKey,
        allowedWorkspaceIds: actorAllowedWorkspaceIds(getRequestActor(c)),
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
      if (!body.workspace?.trim() && (body.newWorkspace || body.templateKey) && !apiKeyMayCreateWorkspace(c)) {
        return apiStatusError(c, 403, "Workspace-scoped API keys cannot create new workspaces", { code: "workspace_scope_forbidden" });
      }
      let result;
      try {
        result = await createRemoteUrlWorkspaceIntake({
          userId,
          orgId: c.get("apiKey")?.orgId ?? body.orgId,
          workspace: body.workspace?.trim() || null,
          newWorkspace: body.newWorkspace,
          templateKey: body.templateKey,
          allowedWorkspaceIds: actorAllowedWorkspaceIds(getRequestActor(c)),
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

/**
 * Where a direct upload session lands, decided at session creation: an
 * existing workspace's ID, or the name of the workspace to create at confirm
 * (neither: a self-titled one). Same rules as intakeIntoWorkspace.
 */
async function directUploadTarget(
  actor: RequestActor,
  input: { workspace?: string; newWorkspace?: boolean; templateKey?: string },
  orgId: string | null,
): Promise<{ workspaceId: string | null; workspaceName: string | null }> {
  const lookup = await lookupActorWorkspace(actor, input.workspace, orgId);
  const restricted = actorAllowedWorkspaceIds(actor) !== null;
  const create = (workspaceName: string | null) => {
    if (restricted) throw new WorkspaceIntakeError("This API key is limited to specific workspaces and cannot create new ones.", 403);
    return { workspaceId: null, workspaceName };
  };
  if (lookup.ref.kind === "default") {
    const explicit = Boolean(input.workspace?.trim());
    if (!explicit && (input.newWorkspace || input.templateKey)) return create(null);
    return { workspaceId: (await requireActorWorkspace(actor, null, orgId)).id, workspaceName: null };
  }
  const found = "workspace" in lookup ? lookup.workspace : null;
  if (lookup.ref.kind === "id") {
    if (!found) throw workspaceInputNotFoundError({ id: lookup.ref.id });
    return { workspaceId: found.id, workspaceName: null };
  }
  return found ? { workspaceId: found.id, workspaceName: null } : create(lookup.ref.name);
}

const uploadEstimateSchema = z.object({
  files: z.array(z.object({
    name: z.string().min(1).max(1024),
    size: z.number().int().nonnegative(),
    pages: z.number().int().positive().optional(),
  })).min(1).max(1000),
  workspace: workspaceInputSchema.optional(),
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
    // Read-only: an estimate never creates a workspace, the default one included.
    const lookup = await lookupActorWorkspace(actor, body.workspace, body.orgId);
    if (lookup.ref.kind !== "default" && "workspace" in lookup && !lookup.workspace) {
      throw workspaceInputNotFoundError(lookup.ref.kind === "slug" ? { slug: lookup.ref.slug } : { id: lookup.ref.id });
    }
    const workspace = "workspace" in lookup && lookup.workspace
      ? await getWorkspace(lookup.workspace.id, userId)
      : await findDefaultWorkspace({ userId, orgId: actor.type === "apiKey" ? actor.apiKey.orgId : body.orgId });
    if (!workspace || (actor.type === "apiKey" && !apiKeyCanUseWorkspace(actor.apiKey, workspace))) {
      return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
    }
    const estimate = await estimateUpload({ files: body.files, workspace });
    return c.json({ estimate, billing: billingState() });
  },
);
acceptApiKeys(uploadEstimateRoutes);
