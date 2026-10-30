import { reportPublicError } from "../lib/public-errors.js";
import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import {
  reprocessRunSchema,
  runProcessingPreviewRequestSchema
} from "@docslurp/shared";

import { actorHasAnyApiKeyScope, getRequestActor, loadActorScopedWorkspace, requireActorWorkspace, type RequestActor } from "../lib/request-actor.js";
import { WorkspaceAccessError } from "../services/default-workspace.js";
import { validationErrorResponse, type ValidationErrorSource, validationHook } from "../lib/validation.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { appendAuditLog } from "../services/audit-log.js";
import { isApiKeyLive } from "../services/api-key-liveness.js";
import { streamRunProgressSnapshots } from "../services/run-progress-stream.js";
import { type RunStartOutcome } from "../services/run-lifecycle.js";
import {
  controlRun,
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
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { inlineEstimate, jobMetaFor, jobStatusForMutation, recordJobMeta } from "../services/jobs.js";
import { billingState } from "../services/config-change.js";
import { estimateRunReprocess } from "../services/work-estimates.js";
import { apiKeyCanUpdateContent, CONTENT_UPDATE_SCOPE_MESSAGE } from "../lib/content-update-access.js";
import { indexingModeErrorResponse } from "../lib/indexing-mode-error.js";
import { IndexingModeError } from "../services/workspace-indexing-mode.js";

/** A server key with `ingest` may reprocess runs in the workspaces it can use; null when the actor may proceed. */
async function denyRunContentUpdate(c: Context, runId: string): Promise<Response | null> {
  const actor = getRequestActor(c);
  if (actor.type !== "apiKey") return null;
  if (!apiKeyCanUpdateContent(actor.apiKey)) return apiStatusError(c, 403, CONTENT_UPDATE_SCOPE_MESSAGE);
  const run = await getRun(runId, actor.userId, { cost: false });
  if (!run || !await loadActorScopedWorkspace(run.workspaceId, actor)) return apiStatusError(c, 404, "Run not found");
  return null;
}

/**
 * Runs and run telemetry are operator surfaces. A browser/client API key is
 * search-only by design, so it must not read them even though it carries the
 * `search` scope (which the runs router also accepts). Security finding
 * SEC-2026-10-ROUND3-01: a public `dslp_pub_` key could list org runs and
 * workspace internals.
 */
function apiKeyMayReadRuns(actor: RequestActor): boolean {
  return actor.type !== "apiKey"
    || (actor.apiKey.keyType === "server" && actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts"]));
}

const STREAM_HEARTBEAT_MS = 4_000;
const STREAM_RECONCILE_MS = 30_000;

const controlRunSchema = z.object({
  action: z.enum(["cancel", "pause", "resume", "reprioritize", "recover"]),
  priority: z.number().int().min(-100).max(100).optional()
});

/** Maps workspace resolution and access failures to 403/404; rethrows anything else. */
function workspaceErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof WorkspaceAccessError) {
    return apiStatusError(c, error.status, error.message, { code: error.code, details: error.details });
  }
  if (error instanceof Error && error.message === "Workspace not found") {
    return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
  }
  if (error instanceof Error && error.message === "Forbidden") {
    return apiStatusError(c, 403, "Forbidden");
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
  .use("*", async (c, next) => {
    const actor = getRequestActor(c);
    // Run history and events contain configuration, costs and internal diagnostics.
    if (actor.type === "apiKey" && actor.apiKey.keyType !== "server") return apiStatusError(c, 403, "Server API key required");
    await next();
  })
  .get("/", async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    if (!apiKeyMayReadRuns(actor)) {
      return apiStatusError(c, 403, "Forbidden");
    }
    const runs = c.req.query("activity") === "true" ? await listRuns(userId, true) : await listRuns(userId);
    const orgId = actor.type === "apiKey" ? actor.apiKey.orgId : null;
    return c.json({ runs: orgId ? runs.filter((run) => run.orgId === orgId) : runs });
  })
  .get("/activity/stream", async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    if (!apiKeyMayReadRuns(actor)) {
      return apiStatusError(c, 403, "Forbidden");
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
      if (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts"])) {
        return apiStatusError(c, 403, "Forbidden");
      }
      const run = await getRun(c.req.param("runId"), userId, { cost: false });
      if (!run || !await loadActorScopedWorkspace(run.workspaceId, actor)) {
        return apiStatusError(c, 404, "Run not found");
      }
    }
    const snapshot = await getRunProgress(c.req.param("runId"), userId);

    if (!snapshot) {
      return apiStatusError(c, 404, "Run not found");
    }

    return c.json(snapshot);
  })
  .get("/:runId/progress/stream", async (c) => {
    const actor = getRequestActor(c);
    const runId = c.req.param("runId");
    if (!apiKeyMayReadRuns(actor)) {
      return apiStatusError(c, 403, "Forbidden");
    }
    const run = await getRun(runId, actor.userId, { cost: false });
    if (!run || !await loadActorScopedWorkspace(run.workspaceId, actor)) {
      return apiStatusError(c, 404, "Run not found");
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
  .get("/:runId/events", async (c) => {
    const userId = c.get("sessionUser").id;
    const actor = getRequestActor(c);
    if (actor.type === "apiKey") {
      if (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts"])) {
        return apiStatusError(c, 403, "Forbidden");
      }
      const run = await getRun(c.req.param("runId"), userId, { cost: false });
      if (!run || !await loadActorScopedWorkspace(run.workspaceId, actor)) {
        return apiStatusError(c, 404, "Run not found");
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
    if (!apiKeyMayReadRuns(actor)) {
      return apiStatusError(c, 403, "Forbidden");
    }
    if (!run || (actor.type === "apiKey" && !await loadActorScopedWorkspace(run.workspaceId, actor))) {
      return apiStatusError(c, 404, "Run not found");
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
      const workspace = await requireActorWorkspace(getRequestActor(c), body.workspace);
      const preview = await getRunProcessingPreview({ ...body, workspaceId: workspace.id }, userId);
      return c.json(preview);
    } catch (error) {
      return workspaceErrorResponse(c, error);
    }
  })
  .post("/:runId/reprocess/estimate", zValidator("json", reprocessRunSchema, validationHook), async (c) => {
    const denied = await denyRunContentUpdate(c, c.req.param("runId"));
    if (denied) return denied;
    const estimate = await estimateRunReprocess({ runId: c.req.param("runId"), userId: c.get("sessionUser").id, options: c.req.valid("json") });
    if (!estimate) return apiStatusError(c, 404, "Run not found");
    return c.json({ estimate, billing: billingState() });
  })
  .post("/:runId/reprocess", zValidator("json", reprocessRunSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    const denied = await denyRunContentUpdate(c, c.req.param("runId"));
    if (denied) return denied;
    const actor = getRequestActor(c);
    const inline = await inlineEstimate(
      () => estimateRunReprocess({ runId: c.req.param("runId"), userId, options: body }),
      `/v1/runs/${c.req.param("runId")}/reprocess/estimate`,
    );
    let reprocessed: Awaited<ReturnType<typeof reprocessRun>>;
    try {
      reprocessed = await reprocessRun(c.req.param("runId"), userId, body);
    } catch (error) {
      if (isReprocessRejectedError(error)) {
        return apiStatusError(c, error.statusCode, error.message, { code: error.code, details: error.details });
      }
      if (isRunCreationBlockedError(error)) {
        return apiStatusError(c, error.statusCode, error.message, { code: error.code });
      }
      // A stored run that combined Fast with visual indexing is not run again (visual_mode_quality, 400).
      if (error instanceof IndexingModeError) return indexingModeErrorResponse(c, error);
      throw error;
    }

    if (!reprocessed) {
      return apiStatusError(c, 404, "Run not found");
    }

    const { run, deferredReason: deferred } = reprocessed;
    const meta = jobMetaFor(run.id, "reprocess", inline);
    await recordJobMeta([run.id], meta);
    const job = await jobStatusForMutation(meta, [run.id], userId);

    await appendAuditLog({
      orgId: run.orgId,
      userId,
      workspaceId: run.workspaceId,
      runId: run.id,
      apiKeyId: actor.type === "apiKey" ? actor.apiKey.keyId : null,
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
      return c.json({ run, warnings: [deferred], job }, 201);
    }

    return c.json({ ...run, job }, 201);
  })
  .post("/:runId/retry", async (c) => {
    const userId = c.get("sessionUser").id;
    const retried = await retryRun(c.req.param("runId"), userId);

    if (!retried) {
      return apiStatusError(c, 404, "Run not found");
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
  .post("/:runId/control", zValidator("json", controlRunSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    const run = await controlRun(c.req.param("runId"), userId, {
      action: body.action,
      priority: body.priority
    });

    if (!run) {
      return apiStatusError(c, 404, "Run not found");
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
  "POST /:runId/reprocess",
  "POST /:runId/reprocess/estimate",
  "GET /",
  "GET /activity/stream",
  "GET /:runId/progress",
  "GET /:runId/progress/stream",
  "GET /:runId/events",
  "GET /:runId/events/stream",
]);
