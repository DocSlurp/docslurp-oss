import { reportPublicError } from "../lib/public-errors.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  isDefaultWorkspaceAlias,
  pipelineFeatureOverridesSchema,
  workspaceTemplateKeySchema,
} from "@docslurp/shared";

import { requestIp, requestUserAgent } from "../lib/request-context.js";
import {
  canonicalIdsForFiles,
  InvalidCanonicalIdError,
  MAX_CANONICAL_ID_LENGTH,
} from "../lib/canonical-id.js";
import { actorHasAnyApiKeyScope, getRequestActor, loadActorScopedWorkspace, requireActorWorkspace } from "../lib/request-actor.js";
import { validationErrorResponse, type ValidationErrorSource } from "../lib/validation.js";
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

type Uploadable = File | string | Array<File | string> | undefined;

const canonicalIdSchema = z.string().trim().min(1).max(MAX_CANONICAL_ID_LENGTH);

const ingestUrlSchema = z.object({
  orgId: z.string().optional(),
  workspaceId: z.string().optional(),
  newWorkspace: z.boolean().optional(),
  workspaceName: z.string().optional(),
  templateKey: workspaceTemplateKeySchema.optional(),
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
});

const createDirectSessionSchema = z.object({
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

  return c.json(
    {
      error: error.message,
      code: error.code,
    },
    error.statusCode,
  );
}

function workspaceIntakeErrorResponse(
  c: Context,
  error: unknown,
): Response | null {
  if (error instanceof WorkspaceAccessError) {
    return c.json({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof UnreadableSourceError) {
    return c.json({ error: error.message, code: error.code }, error.statusCode);
  }
  if (!(error instanceof WorkspaceIntakeError)) {
    return null;
  }

  return c.json(
    {
      error: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
    },
    error.statusCode,
  );
}

/** `ports` lets tests drive the real routes against fake storage, records, and workflow start. */
export const createUploadsRoutes = (ports: WorkspaceIntakePorts = workspaceIntakePorts) => acceptApiKeys(new Hono()
  .use("*", async (c, next) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest"])) {
      return c.json({ error: "Forbidden" }, 403);
    }

    if (actor.type === "apiKey") {
      if (!actor.apiKey.orgId) return c.json({ error: "Forbidden" }, 403);
      const sessionMatch = c.req.path.match(/\/direct\/sessions\/([^/]+)(?:\/|$)/);
      if (sessionMatch && !await directUploadSessionBelongsToOrganization(sessionMatch[1], actor.userId, actor.apiKey.orgId)) {
        return c.json({ error: "Upload session not found" }, 404);
      }
      if (c.req.method === "POST" && /\/(bulk|url|direct\/sessions)\/?$/.test(c.req.path)) {
        let body: Record<string, unknown>;
        try {
          body = c.req.path.replace(/\/$/, "").endsWith("/bulk")
            ? await c.req.parseBody({ all: true })
            : await c.req.json();
        } catch {
          return c.json({ error: "Invalid upload payload" }, 400);
        }
        if (!body || typeof body !== "object") return c.json({ error: "Invalid upload payload" }, 400);
        if (typeof body.orgId === "string" && body.orgId.trim() && body.orgId.trim() !== actor.apiKey.orgId) {
          return c.json({ error: "Forbidden" }, 403);
        }
        if (typeof body.workspaceId === "string" && body.workspaceId
          && !isDefaultWorkspaceAlias(body.workspaceId)
          && !await loadActorScopedWorkspace(body.workspaceId, actor)) {
          return c.json({ error: "Workspace not found" }, 404);
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
      return c.json({ error: "Upload session not found" }, 404);
    }
    return c.json(session);
  })
  .post(
    "/direct/sessions/:sessionId/files/complete",
    zValidator("json", completeDirectFileSchema),
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
          c.json(
            {
              error:
                reportPublicError(error),
            },
            400,
          )
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
      return c.json({ error: "Upload session not found" }, 404);
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
        c.json(
          {
            error:
              reportPublicError(error),
          },
          500,
        )
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

    let result;
    try {
      const canonicalIds = parseCanonicalIds(files, body);
      const pipeline = parseFormWorkspaceIntakePipeline(body.pipeline);
      result = await createBulkWorkspaceIntake({
        userId,
        orgId,
        workspaceId: requestedWorkspaceId,
        newWorkspace: requestedNewWorkspace,
        workspaceName: requestedWorkspaceName,
        templateKey: requestedTemplateKey,
        pipeline,
        files,
        canonicalIds,
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
        c.json(
          {
            error:
              reportPublicError(error),
          },
          500,
        )
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
      let result;
      try {
        result = await createRemoteUrlWorkspaceIntake({
          userId,
          orgId: c.get("apiKey")?.orgId ?? body.orgId,
          workspaceId: body.workspaceId ?? null,
          newWorkspace: body.newWorkspace,
          workspaceName: body.workspaceName?.trim() || null,
          templateKey: body.templateKey,
          pipeline: body.pipeline,
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
          c.json(
            {
              error:
                reportPublicError(error),
            },
            500,
          )
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
