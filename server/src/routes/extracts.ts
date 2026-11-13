import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  documentTagsSchema,
  extractOptionsSchema,
  indexingModeSchema,
  pipelineFeatureOverridesSchema,
  publicPipelineFeatureOverridesSchema,
  PROJECT_INPUT_MAX_LENGTH,
  projectTemplateKeySchema,
  type ExtractOptions,
  type ProjectRecord,
} from "@docslurp/shared";

import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { reportPublicError } from "../lib/public-errors.js";
import { actorHasAnyApiKeyScope, apiKeyCanUseProject, getRequestActor, type RequestActor } from "../lib/request-actor.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { createDirectUploadSession } from "../services/direct-upload-session.js";
import {
  abandonExtract,
  actorMayDownload,
  createExtract,
  extractHasRun,
  describeExtract,
  describeExtractById,
  ExtractError,
  EXTRACT_EXPIRED_MESSAGE,
  expireExtractNow,
  getExtractForActor,
  listExtractsForActor,
  signExtractDownload,
} from "../services/extracts.js";
import {
  createBulkProjectIntake,
  createRemoteUrlProjectIntake,
  parseFormDocumentTags,
  parseFormProjectIntakePipeline,
  parseProjectIntakePipeline,
  parseProjectIntakeTemplateKey,
} from "../services/project-intake-actions.js";
import {
  inferProjectTitleFromFilenames,
  inferProjectTitleFromUrls,
  ProjectIntakeError,
  projectIntakePorts,
  type ProjectIntakePorts,
} from "../services/project-intake.js";
import { getProject } from "../services/projects.js";
import {
  actorAllowedProjectIds,
  canonicalIdSchema,
  directUploadFileSchema,
  directUploadTarget,
  normalizeFiles,
  parseCanonicalIds,
  parseSourcePaths,
  runCreationErrorResponse,
  uploadValidationHook,
  projectInputSchema,
  projectIntakeErrorResponse,
} from "./uploads.js";

/**
 * Extract mode (`/v1/extracts`): the upload inputs (multipart files, URLs,
 * direct storage sessions) with a retention window, after which the files and
 * every derived asset are deleted. Direct sessions created here continue on
 * the shared `/v1/uploads/direct/sessions/:id/...` routes. See docs/extract.md.
 */

const ingestUrlSchema = z.object({
  tags: documentTagsSchema.optional(),
  orgId: z.string().optional(),
  project: projectInputSchema.optional(),
  newProject: z.boolean().optional(),
  templateKey: projectTemplateKeySchema.optional(),
  indexingMode: indexingModeSchema.optional(),
  urls: z.array(z.union([
    z.string().url(),
    z.object({ url: z.string().url(), canonicalId: canonicalIdSchema.optional() }),
  ])).min(1),
  pipeline: publicPipelineFeatureOverridesSchema.optional(),
}).extend(extractOptionsSchema.shape);

const createDirectSessionSchema = z.object({
  indexingMode: indexingModeSchema.optional(),
  tags: documentTagsSchema.optional(),
  orgId: z.string().optional(),
  project: projectInputSchema.optional(),
  newProject: z.boolean().optional(),
  templateKey: projectTemplateKeySchema.optional(),
  pipeline: publicPipelineFeatureOverridesSchema.optional(),
  files: z.array(directUploadFileSchema).min(1),
}).extend(extractOptionsSchema.shape);

const CREATE_PATH = /\/(bulk|url|direct\/sessions)\/?$/;

/** Multipart carries the extract options as strings. */
function parseFormExtractOptions(body: Record<string, unknown>): ExtractOptions {
  const raw: Record<string, unknown> = {};
  if (typeof body.retentionDays === "string" && body.retentionDays.trim()) raw.retentionDays = Number(body.retentionDays.trim());
  if (typeof body.notifyEmail === "string" && body.notifyEmail.trim()) {
    const value = body.notifyEmail.trim().toLowerCase();
    raw.notifyEmail = value === "true" ? true : value === "false" ? false : value;
  }
  if (typeof body.download === "string" && body.download.trim()) raw.download = body.download.trim();
  const parsed = extractOptionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProjectIntakeError("Invalid extract options", 422, parsed.error.issues.map((issue) => ({
      path: issue.path.join("."), message: issue.message, code: issue.code,
    })));
  }
  return parsed.data;
}

function extractOptionsOf(input: ExtractOptions): ExtractOptions {
  return { retentionDays: input.retentionDays, notifyEmail: input.notifyEmail, download: input.download };
}

/**
 * The project an extract lands in, resolved before the extract (and its
 * storage prefix, which names the organization) exists: an existing one, or
 * one created now when the request asks for a new project. Same rules as
 * upload: a project-restricted key never creates one.
 */
async function extractProject(
  actor: RequestActor,
  input: { project?: string | null; newProject?: boolean; templateKey?: string; pipeline?: unknown; indexingMode?: string },
  orgId: string | null,
  title: string,
  ports: ProjectIntakePorts,
): Promise<{ project: ProjectRecord; created: boolean }> {
  const target = await directUploadTarget(actor, { project: input.project ?? undefined, newProject: input.newProject, templateKey: input.templateKey }, orgId);
  if (target.projectId) {
    const project = await getProject(target.projectId, actor.userId);
    if (!project || (actor.type === "apiKey" && !apiKeyCanUseProject(actor.apiKey, project))) {
      throw new ProjectIntakeError("Project not found", 404);
    }
    return { project, created: false };
  }
  const templateKey = parseProjectIntakeTemplateKey(input.templateKey);
  const overrides = parseProjectIntakePipeline(input.pipeline);
  const indexingMode = indexingModeSchema.safeParse(input.indexingMode).data;
  const project = await ports.records.createProject({
    userId: actor.userId,
    orgId: orgId ?? undefined,
    name: target.projectName ?? title,
    templateKey,
    pipeline: indexingMode ? { ...overrides, indexingMode } : overrides,
    autoNamed: !target.projectName,
  });
  return { project, created: true };
}

/** Removes a project made for an extract whose request then failed. */
async function discardCreated(target: { project: ProjectRecord; created: boolean } | null, ports: ProjectIntakePorts): Promise<void> {
  if (!target?.created) return;
  await ports.records.discardProject(target.project.id).catch((error: unknown) => {
    console.error(`[extract] could not remove project=${target.project.id} after the request failed:`, error instanceof Error ? error.message : String(error));
  });
}

/**
 * A request failed: expire its extract and remove a project made for it,
 * unless a run exists (run creation commits the link in its own transaction):
 * then the extract is live and keeps its schedule.
 */
async function releaseFailedExtract(
  extractId: string | null,
  target: { project: ProjectRecord; created: boolean } | null,
  ports: ProjectIntakePorts,
): Promise<void> {
  if (extractId && await extractHasRun(extractId).catch(() => true)) return;
  if (extractId) await abandonExtract(extractId).catch(() => undefined);
  await discardCreated(target, ports);
}

function extractErrorResponse(c: Context, error: unknown): Response | null {
  if (!(error instanceof ExtractError)) return null;
  return apiErrorResponse(c, error.status, error.code, error.message, error.details);
}

function intakeFailure(c: Context, error: unknown): Response {
  return (
    extractErrorResponse(c, error) ??
    projectIntakeErrorResponse(c, error) ??
    runCreationErrorResponse(c, error) ??
    apiStatusError(c, 500, reportPublicError(error))
  );
}

/** `ports` lets tests drive the real routes against fake storage, records, and workflow start. */
export const createExtractsRoutes = (ports: ProjectIntakePorts = projectIntakePorts) => acceptApiKeys(new Hono()
  .use("*", async (c, next) => {
    const actor = getRequestActor(c);
    if (actor.type !== "apiKey") return next();
    if (!actor.apiKey.orgId) return apiStatusError(c, 403, "Forbidden");
    const creating = c.req.method === "POST" && CREATE_PATH.test(c.req.path);
    const downloading = /\/download\/?$/.test(c.req.path);
    // Creating or deleting an extract is ingest; reading it is ingest or artifacts; the download link is
    // for server keys with artifacts scope, as for exports.
    const allowed = downloading
      ? actor.apiKey.keyType === "server" && actorHasAnyApiKeyScope(actor, ["artifacts"])
      : creating || c.req.method === "DELETE"
        ? actorHasAnyApiKeyScope(actor, ["ingest"])
        : actorHasAnyApiKeyScope(actor, ["ingest", "artifacts"]);
    if (!allowed) return apiStatusError(c, 403, "Forbidden");
    if (creating) {
      let body: Record<string, unknown>;
      try {
        body = c.req.path.replace(/\/$/, "").endsWith("/bulk") ? await c.req.parseBody({ all: true }) : await c.req.json();
      } catch {
        return apiStatusError(c, 400, "Invalid extract payload");
      }
      if (!body || typeof body !== "object") return apiStatusError(c, 400, "Invalid extract payload");
      if (typeof body.orgId === "string" && body.orgId.trim() && body.orgId.trim() !== actor.apiKey.orgId) {
        return apiStatusError(c, 403, "Forbidden");
      }
    }
    await next();
  })
  .post("/bulk", async (c) => {
    const actor = getRequestActor(c);
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
    const body = await c.req.parseBody({ all: true });
    const orgId = c.get("apiKey")?.orgId ?? (typeof body.orgId === "string" && body.orgId.trim() ? body.orgId.trim() : null);
    const files = normalizeFiles(body.files ?? body.file);
    let target: { project: ProjectRecord; created: boolean } | null = null;
    let extractId: string | null = null;
    try {
      if (files.length === 0) throw new ProjectIntakeError("Attach at least one file using the files field.", 400);
      const options = parseFormExtractOptions(body);
      const canonicalIds = parseCanonicalIds(files, body);
      const paths = parseSourcePaths(files, body);
      const pipeline = parseFormProjectIntakePipeline(body.pipeline);
      target = await extractProject(actor, {
        project: typeof body.project === "string" && body.project.trim() ? body.project.slice(0, PROJECT_INPUT_MAX_LENGTH) : null,
        newProject: body.newProject === "true",
        templateKey: typeof body.templateKey === "string" ? body.templateKey : undefined,
        pipeline,
        indexingMode: typeof body.indexingMode === "string" ? body.indexingMode : undefined,
      }, orgId, inferProjectTitleFromFilenames(files.map((file) => file.name)), ports);
      const extract = await createExtract({
        userId: actor.userId,
        orgId: target.project.orgId,
        projectId: target.project.id,
        apiKeyId: c.get("apiKey")?.keyId ?? null,
        options,
        estimatedSourceBytes: files.reduce((sum, file) => sum + file.size, 0),
      });
      extractId = extract.id;
      const result = await createBulkProjectIntake({
        userId: actor.userId,
        orgId: target.project.orgId,
        project: target.project.id,
        allowedProjectIds: actorAllowedProjectIds(actor),
        indexingMode: indexingModeSchema.safeParse(body.indexingMode).data,
        pipeline: target.created ? undefined : pipeline,
        files,
        canonicalIds,
        tags: parseFormDocumentTags(body.tags),
        paths,
        idempotencyKey,
        contentLength: c.req.header("content-length"),
        apiKeyId: c.get("apiKey")?.keyId ?? null,
        extract,
        audit: { ipAddress: requestIp(c), userAgent: requestUserAgent(c) },
      }, ports);
      if (result.idempotencyReplayed) {
        // The replayed response names the original extract; the one made for this retry is never used.
        await abandonExtract(extract.id);
        c.header("Idempotency-Replayed", "true");
      }
      if (result.temporalDeferred) c.header("X-Temporal-Deferred", "true");
      return c.json(result.payload, result.status);
    } catch (error) {
      await releaseFailedExtract(extractId, target, ports);
      return intakeFailure(c, error);
    }
  })
  .post("/url", zValidator("json", ingestUrlSchema, uploadValidationHook), async (c) => {
    const actor = getRequestActor(c);
    const body = c.req.valid("json");
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
    const urls = body.urls.map((entry) => typeof entry === "string" ? entry : entry.url);
    let target: { project: ProjectRecord; created: boolean } | null = null;
    let extractId: string | null = null;
    try {
      target = await extractProject(actor, body, c.get("apiKey")?.orgId ?? body.orgId ?? null, inferProjectTitleFromUrls(urls), ports);
      const extract = await createExtract({
        userId: actor.userId,
        orgId: target.project.orgId,
        projectId: target.project.id,
        apiKeyId: c.get("apiKey")?.keyId ?? null,
        options: extractOptionsOf(body),
      });
      extractId = extract.id;
      const result = await createRemoteUrlProjectIntake({
        userId: actor.userId,
        orgId: target.project.orgId,
        project: target.project.id,
        allowedProjectIds: actorAllowedProjectIds(actor),
        indexingMode: body.indexingMode,
        pipeline: target.created ? undefined : body.pipeline,
        tags: body.tags,
        urls,
        canonicalIds: body.urls.map((entry) => typeof entry === "string" ? null : entry.canonicalId ?? null),
        idempotencyKey,
        apiKeyId: c.get("apiKey")?.keyId ?? null,
        extract,
        audit: { ipAddress: requestIp(c), userAgent: requestUserAgent(c) },
      }, ports);
      if (result.idempotencyReplayed) {
        await abandonExtract(extract.id);
        c.header("Idempotency-Replayed", "true");
      }
      if (result.temporalDeferred) c.header("X-Temporal-Deferred", "true");
      return c.json(result.payload, result.status);
    } catch (error) {
      await releaseFailedExtract(extractId, target, ports);
      return intakeFailure(c, error);
    }
  })
  .post("/direct/sessions", zValidator("json", createDirectSessionSchema, uploadValidationHook), async (c) => {
    const actor = getRequestActor(c);
    const input = c.req.valid("json");
    let target: { project: ProjectRecord; created: boolean } | null = null;
    let extractId: string | null = null;
    try {
      target = await extractProject(actor, input, c.get("apiKey")?.orgId ?? input.orgId ?? null, inferProjectTitleFromFilenames(input.files.map((file) => file.filename)), ports);
      const pipeline = parseProjectIntakePipeline({ ...input.pipeline, ...(input.indexingMode ? { indexingMode: input.indexingMode } : {}) });
      const extract = await createExtract({
        userId: actor.userId,
        orgId: target.project.orgId,
        projectId: target.project.id,
        apiKeyId: c.get("apiKey")?.keyId ?? null,
        options: extractOptionsOf(input),
        estimatedSourceBytes: input.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
      });
      extractId = extract.id;
      const session = await createDirectUploadSession({
        userId: actor.userId,
        orgId: target.project.orgId,
        apiKeyId: c.get("apiKey")?.keyId ?? null,
        allowedProjectIds: actorAllowedProjectIds(actor),
        projectId: target.project.id,
        projectName: null,
        templateKey: null,
        pipeline: target.created ? {} : pipeline,
        files: input.files,
        tags: input.tags,
        extract,
      });
      const described = await describeExtractById(extract.id);
      return c.json({ ...session, ...(described ? { extract: described } : {}) }, 201);
    } catch (error) {
      await releaseFailedExtract(extractId, target, ports);
      return intakeFailure(c, error);
    }
  })
  .get("/", async (c) => {
    const limit = Number(c.req.query("limit") ?? 20);
    return c.json({ extracts: await listExtractsForActor(getRequestActor(c), Number.isFinite(limit) ? limit : 20) });
  })
  .get("/:extractId", async (c) => {
    const row = await getExtractForActor(c.req.param("extractId"), getRequestActor(c));
    if (!row) return apiErrorResponse(c, 404, "extract_not_found", "Extract not found");
    const extract = describeExtract(row);
    if (extract.status === "expired") return apiErrorResponse(c, 410, "extract_expired", EXTRACT_EXPIRED_MESSAGE);
    return c.json({ extract });
  })
  .get("/:extractId/download", async (c) => {
    const actor = getRequestActor(c);
    const row = await getExtractForActor(c.req.param("extractId"), actor);
    if (!row) return apiErrorResponse(c, 404, "extract_not_found", "Extract not found");
    // The results are the requester's (or an org owner's or admin's), as with exports.
    if (!await actorMayDownload(actor, row)) return apiErrorResponse(c, 403, "forbidden", "Only the requester can download this extract");
    try {
      const url = await signExtractDownload(row);
      c.header("cache-control", "private, no-store");
      // The signed link must not leak to the storage host's logs through a Referer.
      c.header("referrer-policy", "no-referrer");
      return c.redirect(url, 302);
    } catch (error) {
      return extractErrorResponse(c, error) ?? apiStatusError(c, 500, reportPublicError(error));
    }
  })
  .delete("/:extractId", async (c) => {
    const actor = getRequestActor(c);
    const row = await getExtractForActor(c.req.param("extractId"), actor);
    if (!row) return apiErrorResponse(c, 404, "extract_not_found", "Extract not found");
    // Readers of the project may see an extract; only its requester may delete it early.
    if (row.user_id !== actor.userId) return apiErrorResponse(c, 403, "forbidden", "Only the requester can delete this extract");
    await expireExtractNow(row);
    return c.json({ extract: describeExtract({ ...row, expired: true }) }, 202);
  }));

export const extractsRoutes = createExtractsRoutes();
