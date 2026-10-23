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
  workspaceTemplateKeySchema,
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
  "userId" | "orgId" | "workspace" | "newWorkspace" | "templateKey" | "allowedWorkspaceIds" | "pipeline" | "tags" | "indexingMode"
>;

async function requiredIntake(
  request: WorkspaceIntakeRequest,
  ports: WorkspaceIntakePorts,
): Promise<WorkspaceIntakeResult> {
  const intake = await intakeIntoWorkspace(request, ports);
  if (!intake) throw new WorkspaceIntakeError("Attach at least one file.", 400);
  return intake;
}

function actionResult(
  intake: WorkspaceIntakeResult,
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
      const result = actionResult({ workspace, run: mapWorkspaceRun(existing), documents: documents.map(mapDocument), pipeline: existing.pipeline, deferredReason: null, rejected: [] });
      await persistDirectUploadResult(args.sessionId, result);
      return result;
    }
    if (existing) await discardUnstartedRun(args.sessionId);
    const { session, items } = await prepareDirectUploadWorkspaceIntake(args.sessionId, args.userId);
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
      pipeline: session.pipeline ?? undefined,
      tags: session.tags ?? [],
      apiKeyId: session.api_key_id,
      allowedWorkspaceIds: session.allowed_workspace_ids,
      runId: args.sessionId,
      kind: "direct-upload",
      items,
      audit: args.audit,
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
  const requestHash = hashIdempotencyPayload({
    ...target,
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
    { idempotencyKey, routeKey: "uploads.bulk", requestHash, userId: args.userId },
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
  return await idempotently(
    {
      idempotencyKey,
      routeKey: "uploads.url",
      requestHash: hashIdempotencyPayload({ ...target, canonicalIds: canonicalIds ?? null, idempotencyKey }),
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
