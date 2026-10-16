/**
 * HTTP-facing Workspace Intake actions: request parsing, idempotency, and the
 * response payload. Each action is a thin source adapter over
 * `intakeIntoWorkspace`, which owns validation, storage, workspace resolution,
 * run creation, processing start, and audit.
 */
import { createHash } from "node:crypto";

import {
  pipelineFeatureOverridesSchema,
  workspaceTemplateKeySchema,
  type PipelineFeatureOverrides,
  type PipelineFeatures,
  type WorkspaceTemplateKey,
} from "@docslurp/shared";

import { enforceRequestContentLength } from "../lib/upload-policy.js";
import {
  getCachedIdempotentResponse,
  hashIdempotencyPayload,
  storeIdempotentResponse,
} from "./idempotency.js";
import {
  markDirectUploadSessionConfirmed,
  prepareDirectUploadWorkspaceIntake,
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
  /** Bulk uploads only: files that were not accepted, with why. Absent when every file was taken. */
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
  "userId" | "orgId" | "workspaceId" | "newWorkspace" | "workspaceName" | "templateKey" | "pipeline"
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
  const { session, items } = await prepareDirectUploadWorkspaceIntake(args.sessionId, args.userId);
  const intake = await requiredIntake(
    {
      userId: args.userId,
      orgId: session.org_id,
      workspaceId: session.workspace_id,
      // Sessions resolve the default workspace up front, so no target means "create one".
      newWorkspace: !session.workspace_id,
      workspaceName: session.workspace_name,
      templateKey: session.template_key
        ? workspaceTemplateKeySchema.parse(session.template_key)
        : undefined,
      pipeline: session.pipeline ?? undefined,
      kind: "direct-upload",
      items,
      audit: args.audit,
    },
    ports,
  );

  await markDirectUploadSessionConfirmed({
    sessionId: args.sessionId,
    workspaceId: intake.workspace.id,
    orgId: intake.workspace.orgId,
  });
  return actionResult(intake);
}

export async function createBulkWorkspaceIntake(
  args: IntakeTargetArgs & {
    files: BulkWorkspaceIntakeFile[];
    /** Aligned with `files`. */
    canonicalIds?: Array<string | null>;
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
      bytes: Buffer.from(await file.arrayBuffer()),
    })),
  );
  const { files: _files, canonicalIds: _canonicalIds, idempotencyKey, contentLength: _length, audit, ...target } = args;
  const requestHash = hashIdempotencyPayload({
    ...target,
    templateKey: target.templateKey ?? null,
    files: files.map((file) => ({
      filename: file.filename,
      mimeType: file.mimeType,
      canonicalId: file.canonicalId,
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
            acceptPartial: true,
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
