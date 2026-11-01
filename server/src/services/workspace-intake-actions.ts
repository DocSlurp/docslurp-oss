/**
 * HTTP-facing Workspace Intake actions: request parsing, idempotency, and the
 * response payload. Each action is a thin source adapter over
 * `intakeIntoWorkspace`, which owns validation, storage, workspace resolution,
 * run creation, processing start, and audit.
 */
import { createHash } from "node:crypto";

import {
  documentTagsSchema,
  pipelineFeatureOverridesSchema,
  sanitizeStoredPipeline,
  workspaceTemplateKeySchema,
  type ExtractRecord,
  type PipelineFeatureOverrides,
  type PipelineFeatures,
  type WorkspaceTemplateKey,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { discardUnstartedRun } from "./run-creation.js";
import { mapDocument, mapWorkspaceRun, type DocumentRow, type WorkspaceRunRow } from "./run-records.js";
import { getWorkspace } from "./workspaces.js";

import { enforceRequestContentLength } from "../lib/upload-policy.js";
import {
  getCachedIdempotentResponse,
  hashIdempotencyPayload,
  storeIdempotentResponse,
} from "./idempotency.js";
import {
  prepareDirectUploadWorkspaceIntake,
  loadDirectUploadSession,
  withDirectUploadLock,
} from "./direct-upload-session.js";
import { canonicalIdForUrl } from "../lib/canonical-id.js";
import { attachExtractRun, chargeExtractRetention, describeExtractById, loadIntakeExtract } from "./extracts.js";
import { remoteUrlIntakeItems } from "./remote-ingest.js";
import {
  intakeIntoWorkspace,
  WorkspaceIntakeError,
  workspaceIntakePorts,
  type WorkspaceIntakeAudit,
  type WorkspaceIntakePorts,
  type WorkspaceIntakeRequest,
  type WorkspaceIntakeResult,
} from "./workspace-intake.js";

export type WorkspaceIntakePayload = {
  workspace: WorkspaceIntakeResult["workspace"];
  run: WorkspaceIntakeResult["run"];
  documents: WorkspaceIntakeResult["documents"];
  warnings: string[];
  /** Files that were not accepted, with why. Absent when every file was taken. */
  rejected?: WorkspaceIntakeResult["rejected"];
  pipeline?: PipelineFeatures;
  ingested?: Array<{ filename: string; mimeType: string }>;
  /** Website ingestion: pages read by the crawl and the credits it was charged (ingest is billed separately). */
  crawl?: { startUrl: string; pages: number; credits: number };
  /** Extract mode: the extract this intake belongs to, with its retention and download state. */
  extract?: ExtractRecord;
};

export type WorkspaceIntakeActionResult = {
  payload: WorkspaceIntakePayload;
  status: 201;
  temporalDeferred: boolean;
  idempotencyReplayed?: boolean;
};

export type BulkWorkspaceIntakeFile = Pick<File, "arrayBuffer" | "name" | "size" | "type">;

type IntakeTargetArgs = Pick<
  WorkspaceIntakeRequest,
  "speedBoost" | "userId" | "orgId" | "workspace" | "newWorkspace" | "templateKey" | "allowedWorkspaceIds" | "pipeline" | "tags" | "indexingMode" | "extract" | "apiKeyId"
>;

/**
 * Intake, plus extract bookkeeping: the run is linked to its extract on
 * success. (A failed extract request is expired by its route, routes/extracts.ts;
 * a direct upload session may retry its confirm, so its extract keeps its schedule.)
 */
async function requiredIntake(
  request: WorkspaceIntakeRequest,
  ports: WorkspaceIntakePorts,
): Promise<WorkspaceIntakeResult & { extract?: ExtractRecord }> {
  const intake = await intakeIntoWorkspace(request, ports);
  if (!intake) throw new WorkspaceIntakeError("Attach at least one file.", 400);
  if (!request.extract) return intake;
  // The run is committed (and linked to its extract in its own transaction): nothing below may fail the request.
  const extractId = request.extract.id;
  await chargeExtractRetention(extractId, "admission").catch((error: unknown) => {
    console.error(`[extract] admission charge failed extract=${extractId}; the sweep charges at settle: ${error instanceof Error ? error.message : String(error)}`);
  });
  const extract = await describeExtractById(extractId).catch(() => null);
  return extract ? { ...intake, extract } : intake;
}

function actionResult(
  intake: WorkspaceIntakeResult & { extract?: ExtractRecord },
  extra: Partial<WorkspaceIntakePayload> = {},
): WorkspaceIntakeActionResult {
  return {
    payload: {
      workspace: intake.workspace,
      run: intake.run,
      documents: intake.documents,
      warnings: [
        ...(intake.deferredReason ? [intake.deferredReason] : []),
        ...(intake.rejected.length > 0
          ? [`${intake.rejected.length} of ${intake.rejected.length + intake.documents.length} files were not accepted: ${intake.rejected.map((file) => file.filename).join(", ")}.`]
          : []),
      ],
      ...(intake.rejected.length > 0 ? { rejected: intake.rejected } : {}),
      ...(intake.extract ? { extract: intake.extract } : {}),
      ...extra,
    },
    status: 201,
    temporalDeferred: Boolean(intake.deferredReason),
  };
}

/** Replays a cached response for a repeated Idempotency-Key, or runs and caches the action. */
async function idempotently(
  args: { idempotencyKey?: string; routeKey: string; requestHash: string; userId: string },
  run: () => Promise<WorkspaceIntakeActionResult>,
): Promise<WorkspaceIntakeActionResult> {
  if (!args.idempotencyKey) return await run();

  let cached;
  try {
    cached = await getCachedIdempotentResponse({
      idempotencyKey: args.idempotencyKey,
      routeKey: args.routeKey,
      requestHash: args.requestHash,
    });
  } catch (error) {
    throw new WorkspaceIntakeError(error instanceof Error ? error.message : "Idempotency conflict", 409);
  }
  if (cached) {
    return {
      payload: cached.body as WorkspaceIntakePayload,
      status: cached.status as 201,
      temporalDeferred: false,
      idempotencyReplayed: true,
    };
  }

  const result = await run();
  await storeIdempotentResponse({
    idempotencyKey: args.idempotencyKey,
    routeKey: args.routeKey,
    requestHash: args.requestHash,
    userId: args.userId,
    status: result.status,
    body: result.payload as unknown as Record<string, unknown>,
  });
  return result;
}

/**
 * Upload pipelines are partial overrides: they merge onto the workspace
 * pipeline (and its template locks) instead of replacing it.
 */
export function parseWorkspaceIntakePipeline(raw: unknown): PipelineFeatureOverrides {
  const parsed = pipelineFeatureOverridesSchema.safeParse(raw === undefined || raw === null ? {} : raw);
  if (!parsed.success) {
    throw new WorkspaceIntakeError("Invalid pipeline payload", 422, parsed.error.issues.map((issue) => ({
      path: ["pipeline", ...issue.path].join("."),
      message: issue.message,
      code: issue.code,
    })));
  }
  return parsed.data;
}

export function parseWorkspaceIntakeTemplateKey(raw: unknown): WorkspaceTemplateKey | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  return workspaceTemplateKeySchema.safeParse(raw.trim()).data;
}

export function parseFormWorkspaceIntakePipeline(raw: unknown): PipelineFeatureOverrides | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;

  try {
    return parseWorkspaceIntakePipeline(JSON.parse(raw));
  } catch (error) {
    if (error instanceof WorkspaceIntakeError) throw error;
    throw new WorkspaceIntakeError("Invalid pipeline payload", 422, [
      { path: "pipeline", message: "pipeline must be valid JSON", code: "custom" },
    ]);
  }
}

export async function confirmDirectUploadWorkspaceIntake(
  args: { sessionId: string; userId: string; audit?: WorkspaceIntakeAudit },
  ports: WorkspaceIntakePorts = workspaceIntakePorts,
): Promise<WorkspaceIntakeActionResult> {
  return withDirectUploadLock(args.sessionId, async () => {
    const loaded = await loadDirectUploadSession(args.sessionId, args.userId);
    if (!loaded) throw new WorkspaceIntakeError("Upload session not found", 404);
    if (["aborted", "failed"].includes(loaded.session.status)) throw new WorkspaceIntakeError("Upload session is closed", 409);
    if (loaded.session.result) return loaded.session.result as WorkspaceIntakeActionResult;
    if (!loaded.files.every(file => file.status === "completed")) throw new WorkspaceIntakeError("Upload session still has incomplete files", 409);

    // Run identity is chosen before intake. A process crash after publication can
    // recover the same manifest rather than creating a second billable run.
    const [existing] = await sql<Array<WorkspaceRunRow & { creation_ready_at?: string | null }>>`select * from workspace_runs where id = ${args.sessionId} and user_id = ${args.userId}`;
    if (existing && existing.creation_ready_at) {
      const workspace = await getWorkspace(existing.workspace_id, args.userId);
      if (!workspace) throw new WorkspaceIntakeError("Upload workspace is no longer accessible", 403);
      const documents = await sql<DocumentRow[]>`select * from documents where run_id = ${args.sessionId} order by created_at, id`;
      if (loaded.session.extract_id) await attachExtractRun(loaded.session.extract_id, args.sessionId);
      const extract = loaded.session.extract_id ? await describeExtractById(loaded.session.extract_id) : null;
      const result = actionResult({ workspace, run: mapWorkspaceRun(existing), documents: documents.map(mapDocument), pipeline: existing.pipeline, deferredReason: null, rejected: [], ...(extract ? { extract } : {}) });
      await persistDirectUploadResult(args.sessionId, result);
      return result;
    }
    if (existing) await discardUnstartedRun(args.sessionId);
    const { session, items } = await prepareDirectUploadWorkspaceIntake(args.sessionId, args.userId);
    // An extract session lands only while its extract is live; its sources are already under the extract prefix.
    const extract = session.extract_id ? await loadIntakeExtract(session.extract_id, args.userId) : null;
    if (session.extract_id && !extract) throw new WorkspaceIntakeError("This extract expired before its files were confirmed.", 409);
    await sql`update upload_sessions set status = 'ingesting' where id = ${args.sessionId}`;
    const intakePorts: WorkspaceIntakePorts = { ...ports, records: {
      ...ports.records,
      async discardWorkspace(workspaceId) {
        await ports.records.discardWorkspace(workspaceId);
        await sql`update upload_sessions set workspace_id = null where id = ${args.sessionId} and workspace_id = ${workspaceId}`;
      },
      async createWorkspace(input) {
        const workspace = await ports.records.createWorkspace(input);
        await sql`update upload_sessions set workspace_id = ${workspace.id}, org_id = ${workspace.orgId} where id = ${args.sessionId}`;
        return workspace;
      },
    } };
    const intake = await requiredIntake({
      userId: args.userId,
      orgId: session.org_id,
      workspace: session.workspace_id ?? session.workspace_name,
      newWorkspace: !session.workspace_id && !session.workspace_name,
      templateKey: session.template_key ? workspaceTemplateKeySchema.parse(session.template_key) : undefined,
      // Stored with the session; a session created before an extractor schema tightened is read leniently.
      speedBoost: session.pipeline?.speedBoost === true,
      pipeline: session.pipeline ? sanitizeStoredPipeline(session.pipeline, `upload session ${args.sessionId}`) : undefined,
      tags: session.tags ?? [],
      apiKeyId: session.api_key_id,
      allowedWorkspaceIds: session.allowed_workspace_ids,
      runId: args.sessionId,
      kind: "direct-upload",
      items,
      audit: args.audit,
      ...(extract ? { extract } : {}),
    }, intakePorts);
    const result = actionResult(intake);
    await persistDirectUploadResult(args.sessionId, result);
    return result;
  });
}

async function persistDirectUploadResult(sessionId: string, result: WorkspaceIntakeActionResult) {
  await sql`update upload_sessions set status = 'confirmed', result = ${sql.json(JSON.parse(JSON.stringify(result)))},
    workspace_id = ${result.payload.workspace.id}, org_id = ${result.payload.workspace.orgId}, last_error = null, updated_at = now()
    where id = ${sessionId}`;
}

export async function createBulkWorkspaceIntake(
  args: IntakeTargetArgs & {
    files: BulkWorkspaceIntakeFile[];
    /** Aligned with `files`. */
    canonicalIds?: Array<string | null>;
    /** Folder paths aligned with `files`. */
    paths?: string[];
    idempotencyKey?: string;
    contentLength?: string | null;
    audit?: WorkspaceIntakeAudit;
  },
  ports: WorkspaceIntakePorts = workspaceIntakePorts,
): Promise<WorkspaceIntakeActionResult> {
  try {
    enforceRequestContentLength(args.contentLength ?? null);
  } catch (error) {
    throw new WorkspaceIntakeError(error instanceof Error ? error.message : "Upload too large", 413);
  }
  if (args.files.length === 0) {
    throw new WorkspaceIntakeError("Attach at least one file using the files field.", 400);
  }

  const files = await Promise.all(
    args.files.map(async (file, index) => ({
      filename: file.name,
      mimeType: file.type,
      canonicalId: args.canonicalIds?.[index] ?? null,
      path: args.paths?.[index] ?? "",
      bytes: Buffer.from(await file.arrayBuffer()),
    })),
  );
  const { files: _files, canonicalIds: _canonicalIds, paths: _paths, idempotencyKey, contentLength: _length, audit, ...target } = args;
  // The extract is created per request, so it is not part of the request's identity.
  const { extract: _extract, ...hashedTarget } = target;
  const requestHash = hashIdempotencyPayload({
    ...hashedTarget,
    templateKey: target.templateKey ?? null,
    files: files.map((file) => ({
      filename: file.filename,
      mimeType: file.mimeType,
      canonicalId: file.canonicalId,
      path: file.path,
      size: file.bytes.byteLength,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    })),
  });

  return await idempotently(
    { idempotencyKey, routeKey: target.extract ? "extracts.bulk" : "uploads.bulk", requestHash, userId: args.userId },
    async () =>
      actionResult(
        await requiredIntake(
          {
            ...target,
            kind: "bulk-upload",
            items: files.map(({ bytes, ...file }) => ({ ...file, content: { bytes } })),
            audit,
          },
          ports,
        ),
      ),
  );
}

export async function createRemoteUrlWorkspaceIntake(
  args: IntakeTargetArgs & {
    urls: string[];
    /** Aligned with `urls`; missing entries default to the URL itself. */
    canonicalIds?: Array<string | null>;
    idempotencyKey?: string;
    audit?: WorkspaceIntakeAudit;
  },
  ports: WorkspaceIntakePorts = workspaceIntakePorts,
): Promise<WorkspaceIntakeActionResult> {
  const { idempotencyKey, audit, canonicalIds, ...target } = args;
  const { extract: _extract, ...hashedTarget } = target;
  return await idempotently(
    {
      idempotencyKey,
      routeKey: target.extract ? "extracts.url" : "uploads.url",
      requestHash: hashIdempotencyPayload({ ...hashedTarget, canonicalIds: canonicalIds ?? null, idempotencyKey }),
      userId: args.userId,
    },
    async () => {
      const intake = await requiredIntake(
        {
          ...target,
          kind: "url-ingest",
          items: remoteUrlIntakeItems(args.urls, { canonicalIds }),
          urls: args.urls,
          audit,
        },
        ports,
      );
      return actionResult(intake, {
        ingested: intake.documents.map((document) => ({
          filename: document.filename,
          mimeType: document.mimeType,
        })),
        pipeline: intake.pipeline,
      });
    },
  );
}

/** A crawled page becomes a Markdown document named after its URL path. */
function webPageFilename(rawUrl: string): string {
  const url = new URL(rawUrl);
  const slug = `${url.hostname}${url.pathname}`.replace(/\/+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${(slug || url.hostname).slice(0, 180)}.md`;
}

/**
 * Website ingestion: crawl a site through Web Capabilities, then ingest every
 * page as a Markdown document whose canonical ID is the page URL, so a re-crawl
 * supersedes the previous version. The crawl runs inside the idempotency
 * window, so a retried request neither re-crawls nor re-charges.
 */
export async function createWebsiteWorkspaceIntake(
  args: IntakeTargetArgs & {
    startUrl: string;
    crawl: () => Promise<{ pages: Array<{ url: string; title?: string; markdown?: string }>; credits: number }>;
    crawlOptions: Record<string, unknown>;
    idempotencyKey?: string;
    audit?: WorkspaceIntakeAudit;
  },
  ports: WorkspaceIntakePorts = workspaceIntakePorts,
): Promise<WorkspaceIntakeActionResult> {
  const { idempotencyKey, audit, crawl, crawlOptions, startUrl, ...target } = args;
  return await idempotently(
    {
      idempotencyKey,
      routeKey: "web.ingest",
      requestHash: hashIdempotencyPayload({ ...target, startUrl, crawlOptions, idempotencyKey }),
      userId: args.userId,
    },
    async () => {
      const crawled = await crawl();
      const pages = crawled.pages.filter((page) => page.markdown?.trim());
      if (!pages.length) throw new WorkspaceIntakeError("The crawl found no readable pages at this URL.", 422);
      const intake = await requiredIntake(
        {
          ...target,
          kind: "url-ingest",
          items: pages.map((page) => {
            const body = page.title && !page.markdown!.trimStart().startsWith("#") ? `# ${page.title}\n\n${page.markdown}` : page.markdown!;
            return {
              filename: webPageFilename(page.url),
              mimeType: "text/markdown",
              canonicalId: canonicalIdForUrl(page.url),
              metadata: { sourceUrl: page.url, source: "website-crawl", crawlStartUrl: startUrl },
              content: { bytes: Buffer.from(body, "utf8") },
            };
          }),
          urls: [startUrl],
          audit,
        },
        ports,
      );
      return actionResult(intake, {
        ingested: intake.documents.map((document) => ({ filename: document.filename, mimeType: document.mimeType })),
        pipeline: intake.pipeline,
        crawl: { startUrl, pages: pages.length, credits: crawled.credits },
      });
    },
  );
}

/** Multipart encodes the same tag array as JSON. Validate before storing files. */
export function parseFormDocumentTags(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { throw new WorkspaceIntakeError("tags must be a JSON array of strings", 422); }
  const parsed = documentTagsSchema.safeParse(value);
  if (!parsed.success) throw new WorkspaceIntakeError("Invalid tags", 422, parsed.error.issues.map((issue) => ({
    path: ["tags", ...issue.path].join("."), message: issue.message, code: issue.code,
  })));
  return parsed.data;
}
