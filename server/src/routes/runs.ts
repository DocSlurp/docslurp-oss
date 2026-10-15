import { reportPublicError } from "../lib/public-errors.js";
import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import {
  createWorkspaceRunSchema,
  reprocessRunSchema,
  runProcessingPreviewRequestSchema
} from "@docslurp/shared";

import { actorHasAnyApiKeyScope, getRequestActor, loadActorScopedWorkspace, requireActorWorkspace } from "../lib/request-actor.js";
import { WorkspaceAccessError } from "../services/default-workspace.js";
import { validationErrorResponse, type ValidationErrorSource } from "../lib/validation.js";
import { getCachedIdempotentResponse, hashIdempotencyPayload, storeIdempotentResponse } from "../services/idempotency.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { appendAuditLog } from "../services/audit-log.js";
import { isApiKeyLive } from "../services/api-key-liveness.js";
import { streamRunProgressSnapshots } from "../services/run-progress-stream.js";
import { getRunForensics } from "../services/run-forensics.js";
import { runLifecycle, type RunStartOutcome } from "../services/run-lifecycle.js";
import {
  controlRun,
  createRun,
  exportRun,
  getRun,
  getRunProcessingPreview,
  getRunProgress,
  isReprocessRejectedError,
  isRunCreationBlockedError,
  listenForRunEvents,
  listRunEvents,
  listRuns,
  reprocessRun,
  retryRun
} from "../services/runs.js";
import { acceptApiKeys } from "../lib/route-auth.js";

const STREAM_HEARTBEAT_MS = 4_000;
const STREAM_RECONCILE_MS = 30_000;

const controlRunSchema = z.object({
  action: z.enum(["cancel", "pause", "resume", "reprioritize", "recover"]),
  priority: z.number().int().min(-100).max(100).optional()
});

/** Maps workspace resolution and access failures to 403/404; rethrows anything else. */
function workspaceErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof WorkspaceAccessError) {
    return c.json({ error: error.message, code: error.code }, error.status === 403 ? 403 : 404);
  }
  if (error instanceof Error && error.message === "Workspace not found") {
    return c.json({ error: "Workspace not found" }, 404);
  }
  if (error instanceof Error && error.message === "Forbidden") {
    return c.json({ error: "Forbidden" }, 403);
  }
  throw error;
}

function deferredReason(start: RunStartOutcome | undefined): string | null {
  return start?.status === "deferred" ? start.reason : null;
}

const runValidationHook = (result: { success: boolean; error?: ValidationErrorSource }, c: Context) => {
  if (result.success) {
    return;
  }

  return validationErrorResponse(c, result.error ?? new z.ZodError([]), "Invalid run payload");
};

export const runsRoutes = new Hono()
  .get("/", async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts"])) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const runs = c.req.query("activity") === "true" ? await listRuns(userId, true) : await listRuns(userId);
    const orgId = actor.type === "apiKey" ? actor.apiKey.orgId : null;
    return c.json({ runs: orgId ? runs.filter((run) => run.orgId === orgId) : runs });
  })
  .get("/activity/stream", async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts"])) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const orgId = actor.type === "apiKey" ? actor.apiKey.orgId : null;
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async stream => {
      let aborted = stream.aborted;
      let resolveAbort!: () => void;
      const abortSignal = new Promise<void>(resolve => { resolveAbort = resolve; });
      stream.onAbort(() => { aborted = true; resolveAbort(); });
      const subscription = await listenForRunEvents(async event => {
        if (aborted) return;
        // Recheck workspace membership for each event; never trust event user ids.
        const run = await getRun(event.runId, userId);
        if (!run || (orgId && run.orgId !== orgId)) return;
        if (aborted) return;
        await stream.writeSSE({ event: "activity-run", data: JSON.stringify(run) });
        await stream.writeSSE({ event: "activity-event", id: event.id, data: JSON.stringify(event) });
      });
      async function inventory() {
        const runs = await listRuns(userId, true);
        return orgId ? runs.filter(run => run.orgId === orgId) : runs;
      }
      try {
        let reconciledAt = Number.NEGATIVE_INFINITY;
        while (!aborted) {
          // Event snapshots carry live changes; inventory reconciles membership,
          // access revocation and missed notifications at a bounded cadence.
          if (Date.now() - reconciledAt >= STREAM_RECONCILE_MS) {
            const runs = await inventory();
            if (aborted) break;
            await stream.writeSSE({ event: "activity", data: JSON.stringify({ runs }) });
            reconciledAt = Date.now();
          }
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
          await Promise.race([stream.sleep(STREAM_HEARTBEAT_MS), abortSignal]);
        }
      } finally { await subscription.close(); }
    });
  })
  .get("/:runId/progress", async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    if (actor.type === "apiKey") {
      if (!actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts"])) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const run = await getRun(c.req.param("runId"), userId, { cost: false });
      if (!run || !await loadActorScopedWorkspace(run.workspaceId, actor)) {
        return c.json({ error: "Run not found" }, 404);
      }
    }
    const snapshot = await getRunProgress(c.req.param("runId"), userId);

    if (!snapshot) {
      return c.json({ error: "Run not found" }, 404);
    }

    return c.json(snapshot);
  })
  .get("/:runId/progress/stream", async (c) => {
    const actor = getRequestActor(c);
    const runId = c.req.param("runId");
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts"])) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const run = await getRun(runId, actor.userId, { cost: false });
    if (!run || !await loadActorScopedWorkspace(run.workspaceId, actor)) {
      return c.json({ error: "Run not found" }, 404);
    }
    c.header("X-Accel-Buffering", "no");
    const response = streamSSE(c, async stream => {
      await streamRunProgressSnapshots({
        stream,
        subscribe: invalidate => listenForRunEvents(event => { if (event.runId === runId) invalidate(); }, { runId }),
        snapshot: async () => {
          if (actor.type === "apiKey" && !await isApiKeyLive(actor.apiKey, ["ingest", "search", "artifacts"])) return null;
          const snapshot = await getRunProgress(runId, actor.userId, { recentEventLimit: 0 });
          if (!snapshot || !await loadActorScopedWorkspace(snapshot.run.workspaceId, actor)) return null;
          return snapshot;
        },
      });
    });
    // Hono applies its own no-cache header when creating an SSE response.
    response.headers.set("Cache-Control", "no-cache, no-transform");
    return response;
  })
  .get("/:runId/export", async (c) => {
    const userId = c.get("sessionUser").id;
    const manifest = await exportRun(c.req.param("runId"), userId);

    if (!manifest) {
      return c.json({ error: "Run not found" }, 404);
    }

    return c.json(manifest);
  })
  .get("/:runId/forensics", async (c) => {
    const userId = c.get("sessionUser").id;
    const forensics = await getRunForensics(c.req.param("runId"), userId);

    if (!forensics) {
      return c.json({ error: "Run not found" }, 404);
    }

    return c.json(forensics);
  })
  .get("/:runId/events", async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    if (actor.type === "apiKey") {
      if (!actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts"])) {
        return c.json({ error: "Forbidden" }, 403);
      }
      const run = await getRun(c.req.param("runId"), userId, { cost: false });
      if (!run || !await loadActorScopedWorkspace(run.workspaceId, actor)) {
        return c.json({ error: "Run not found" }, 404);
      }
    }
    const after = c.req.query("after") ?? undefined;
    const limit = c.req.query("limit");
    const events = await listRunEvents({
      runId: c.req.param("runId"),
      userId,
      after,
      limit: limit ? Number(limit) : undefined
    });
    return c.json({ events });
  })
  .get("/:runId/events/stream", async (c) => {
    const userId = c.get("sessionUser").id;
    const runId = c.req.param("runId");
    const run = await getRun(runId, userId, { cost: false });

    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts"])) {
      return c.json({ error: "Forbidden" }, 403);
    }
    if (!run || (actor.type === "apiKey" && !await loadActorScopedWorkspace(run.workspaceId, actor))) {
      return c.json({ error: "Run not found" }, 404);
    }

    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      let aborted = stream.aborted;
      let resolveAbort!: () => void;
      const abortSignal = new Promise<void>(resolve => { resolveAbort = resolve; });
      stream.onAbort(() => { aborted = true; resolveAbort(); });
      async function authorizedSnapshot() {
        const snapshot = await getRunProgress(runId, userId);
        if (!snapshot || (actor.type === "apiKey" && !await loadActorScopedWorkspace(snapshot.run.workspaceId, actor))) return null;
        return snapshot;
      }
      const subscription = await listenForRunEvents(async (event) => {
        if (aborted || event.runId !== runId) return;
        // Validate current access before sending either events or their snapshot.
        const snapshot = await authorizedSnapshot();
        if (!snapshot || aborted) return;
        await stream.writeSSE({ id: event.id, event: event.type, data: JSON.stringify(event) });
        await stream.writeSSE({ event: "snapshot", data: JSON.stringify(snapshot) });
      }, { runId });

      try {
        let reconciledAt = Number.NEGATIVE_INFINITY;
        while (!aborted) {
          if (Date.now() - reconciledAt >= STREAM_RECONCILE_MS) {
            const snapshot = await authorizedSnapshot();
            if (aborted) break;
            if (!snapshot) {
              await stream.writeSSE({ event: "activity-error", data: "{}" });
              break;
            }
            await stream.writeSSE({ event: "snapshot", data: JSON.stringify(snapshot) });
            reconciledAt = Date.now();
          }
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
          await Promise.race([stream.sleep(STREAM_HEARTBEAT_MS), abortSignal]);
        }
      } finally {
        await subscription.close();
      }
    });
  })
  .post("/preview", zValidator("json", runProcessingPreviewRequestSchema, runValidationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    try {
      const workspace = await requireActorWorkspace(getRequestActor(c), body.workspaceId);
      const preview = await getRunProcessingPreview({ ...body, workspaceId: workspace.id }, userId);
      return c.json(preview);
    } catch (error) {
      return workspaceErrorResponse(c, error);
    }
  })
  .post("/", zValidator("json", createWorkspaceRunSchema, runValidationHook), async (c) => {
    const input = c.req.valid("json");
    const userId = c.get("sessionUser").id;
    // Override userId from session regardless of what was sent in the body,
    // and resolve the workspace reference (omitted means the org default).
    let runInput;
    try {
      const workspace = await requireActorWorkspace(getRequestActor(c), input.workspaceId);
      runInput = { ...input, userId, workspaceId: workspace.id };
    } catch (error) {
      return workspaceErrorResponse(c, error);
    }
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
    const requestHash = hashIdempotencyPayload(runInput);

    if (idempotencyKey) {
      try {
        const cached = await getCachedIdempotentResponse({
          idempotencyKey,
          routeKey: "runs.create",
          requestHash
        });

        if (cached) {
          c.header("Idempotency-Replayed", "true");
          return c.json(cached.body, cached.status as 200 | 201);
        }
      } catch (error) {
        return c.json({ error: reportPublicError(error) }, 409);
      }
    }

    let run;
    try {
      run = await createRun(runInput);
    } catch (error) {
      if (isRunCreationBlockedError(error)) {
        return c.json(
          {
            error: error.message,
            code: error.code
          },
          error.statusCode
        );
      }
      return workspaceErrorResponse(c, error);
    }
    await appendAuditLog({
      orgId: run.orgId,
      userId,
      workspaceId: run.workspaceId,
      runId: run.id,
      action: "run.created",
      resourceType: "run",
      resourceId: run.id,
      ipAddress: requestIp(c),
      metadata: {
        kind: run.kind,
        totalDocuments: run.totalDocuments,
        userAgent: requestUserAgent(c)
      }
    });

    if (idempotencyKey) {
      await storeIdempotentResponse({
        idempotencyKey,
        routeKey: "runs.create",
        requestHash,
        userId,
        status: 201,
        body: run as unknown as Record<string, unknown>
      });
    }

    return c.json(run, 201);
  })
  .post("/:runId/reprocess", zValidator("json", reprocessRunSchema), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    let run: Awaited<ReturnType<typeof reprocessRun>>;
    try {
      run = await reprocessRun(c.req.param("runId"), userId, body);
    } catch (error) {
      if (isReprocessRejectedError(error)) {
        return c.json({ error: error.message, code: error.code, details: error.details }, error.statusCode);
      }
      throw error;
    }

    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }

    const deferred = deferredReason(await runLifecycle.start(run));

    await appendAuditLog({
      orgId: run.orgId,
      userId,
      workspaceId: run.workspaceId,
      runId: run.id,
      action: "run.reprocessed",
      resourceType: "run",
      resourceId: run.id,
      ipAddress: requestIp(c),
      metadata: {
        stages: body.stages ?? null,
        stageFrom: body.stageFrom ?? null,
        userAgent: requestUserAgent(c)
      }
    });

    if (deferred) {
      c.header("X-Temporal-Deferred", "true");
      return c.json({ run, warnings: [deferred] }, 201);
    }

    return c.json(run, 201);
  })
  .post("/:runId/retry", async (c) => {
    const userId = c.get("sessionUser").id;
    const retried = await retryRun(c.req.param("runId"), userId);

    if (!retried) {
      return c.json({ error: "Run not found" }, 404);
    }

    const { run, outcome } = retried;
    const deferred = deferredReason(outcome.status === "not-retryable" ? undefined : outcome.start);

    await appendAuditLog({
      orgId: run.orgId,
      userId,
      workspaceId: run.workspaceId,
      runId: run.id,
      action: "run.retried",
      resourceType: "run",
      resourceId: run.id,
      ipAddress: requestIp(c),
      metadata: {
        outcome: outcome.status,
        userAgent: requestUserAgent(c)
      }
    });

    if (deferred) {
      c.header("X-Temporal-Deferred", "true");
      return c.json({ run, warnings: [deferred] });
    }

    return c.json(run);
  })
  .post("/:runId/control", zValidator("json", controlRunSchema), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    const run = await controlRun(c.req.param("runId"), userId, {
      action: body.action,
      priority: body.priority
    });

    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }

    await appendAuditLog({
      orgId: run.orgId,
      userId,
      workspaceId: run.workspaceId,
      runId: run.id,
      action: `run.control.${body.action}`,
      resourceType: "run",
      resourceId: run.id,
      ipAddress: requestIp(c),
      metadata: {
        priority: body.priority ?? null,
        controlState: run.controlState ?? null,
        status: run.status,
        userAgent: requestUserAgent(c)
      }
    });

    return c.json(run);
  });

acceptApiKeys(runsRoutes, [
  "GET /",
  "GET /activity/stream",
  "GET /:runId/progress",
  "GET /:runId/progress/stream",
  "GET /:runId/events",
  "GET /:runId/events/stream",
]);
