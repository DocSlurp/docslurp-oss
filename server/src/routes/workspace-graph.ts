import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { startGraphRebuildSchema, updateWorkspaceGraphSchema, type GraphJob } from "@docslurp/shared";

import { actorHasAnyApiKeyScope, getRequestActor, apiKeyCanUseWorkspace } from "../lib/request-actor.js";
import { requestIp } from "../lib/request-context.js";
import { appendAuditLog } from "../services/audit-log.js";
import { INLINE_ESTIMATE_BUDGET_MS, jobStatusForMutation } from "../services/jobs.js";
import { billingState } from "../services/config-change.js";
import {
  cancelGraphJob,
  estimateGraphRebuild,
  getGraphJob,
  getWorkspaceGraphStatus,
  isGraphJobActive,
  startGraphRebuild,
  updateWorkspaceGraph,
  WorkspaceGraphError,
} from "../services/workspace-graph.js";
import { getWorkspace } from "../services/workspaces.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";

const JOB_STREAM_POLL_MS = 1_000;
const JOB_STREAM_MAX_MS = 10 * 60_000;

/**
 * API keys may read graph state with any workspace scope; changing settings
 * or starting/cancelling rebuilds needs a server key with `workspaces:manage`.
 * Keys are bound to their organization.
 */
async function authorizeApiKey(c: Context, workspaceRef: string, write: boolean): Promise<Response | null> {
  const actor = getRequestActor(c);
  if (actor.type !== "apiKey") return null;
  const allowed = write
    ? actor.apiKey.keyType === "server" && actorHasAnyApiKeyScope(actor, ["workspaces:manage"])
    : actorHasAnyApiKeyScope(actor, ["ingest", "search", "artifacts", "workspaces:manage"]);
  if (!allowed) {
    return apiStatusError(c, 403, write
        ? "This endpoint requires a server API key with the workspaces:manage scope"
        : "Forbidden");
  }
  const workspace = await getWorkspace(workspaceRef, actor.userId);
  if (!workspace || !apiKeyCanUseWorkspace(actor.apiKey, workspace)) {
    return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
  }
  return null;
}

function graphError(c: Context, error: unknown) {
  if (error instanceof WorkspaceGraphError) {
    return apiStatusError(c, error.status, error.message, error.activeJob ? { details: { activeJob: error.activeJob } } : {});
  }
  throw error;
}

async function audit(c: Context, workspaceRef: string, userId: string, action: string, resourceId: string, metadata: Record<string, unknown>) {
  const workspace = await getWorkspace(workspaceRef, userId);
  if (!workspace) return;
  await appendAuditLog({
    orgId: workspace.orgId,
    userId,
    workspaceId: workspace.id,
    action,
    resourceType: "workspace-graph",
    resourceId,
    ipAddress: requestIp(c),
    metadata,
  });
}

export const workspaceGraphRoutes = new Hono()
  /** Settings, coverage, stats, rebuild estimates and the active/last job. */
  .get("/:workspaceId/graph", async (c) => {
    const workspaceRef = c.req.param("workspaceId");
    const denied = await authorizeApiKey(c, workspaceRef, false);
    if (denied) return denied;
    try {
      return c.json(await getWorkspaceGraphStatus(workspaceRef, c.get("sessionUser").id));
    } catch (error) {
      return graphError(c, error);
    }
  })
  /** Partial update: only the fields sent change. */
  .patch("/:workspaceId/graph", zValidator("json", updateWorkspaceGraphSchema, validationHook), async (c) => {
    const workspaceRef = c.req.param("workspaceId");
    const denied = await authorizeApiKey(c, workspaceRef, true);
    if (denied) return denied;
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    try {
      const status = await updateWorkspaceGraph(workspaceRef, userId, body);
      await audit(c, workspaceRef, userId, "workspace.graph.updated", status.workspaceId, {
        changed: Object.keys(body),
        configHash: status.configHash,
      });
      return c.json(status);
    } catch (error) {
      return graphError(c, error);
    }
  })
  .post("/:workspaceId/graph/rebuild", zValidator("json", startGraphRebuildSchema, validationHook), async (c) => {
    const workspaceRef = c.req.param("workspaceId");
    const denied = await authorizeApiKey(c, workspaceRef, true);
    if (denied) return denied;
    const userId = c.get("sessionUser").id;
    try {
      let estimateMs = 0;
      const job = await startGraphRebuild(workspaceRef, userId, c.req.valid("json"), { onEstimateTimed: (ms) => { estimateMs = ms; } });
      await audit(c, workspaceRef, userId, "workspace.graph.rebuild_started", job.id, {
        mode: job.mode,
        documents: job.documentsTotal,
        estimatedCostCents: job.estimate?.costCents ?? null,
        maxCostCents: job.maxCostCents,
      });
      const read = await jobStatusForMutation({ id: job.id, kind: "graph-rebuild" }, [], userId);
      // Inline estimates only when they computed within the budget.
      const status = estimateMs > INLINE_ESTIMATE_BUDGET_MS
        ? { ...read, estimate: null, estimateUrl: `/v1/workspaces/${workspaceRef}/graph/jobs/estimate` }
        : read;
      return c.json({ ...job, job: status }, 202);
    } catch (error) {
      return graphError(c, error);
    }
  })
  .post("/:workspaceId/graph/jobs/estimate", zValidator("json", startGraphRebuildSchema), async (c) => {
    const workspaceRef = c.req.param("workspaceId");
    const denied = await authorizeApiKey(c, workspaceRef, true);
    if (denied) return denied;
    try {
      const estimate = await estimateGraphRebuild(workspaceRef, c.get("sessionUser").id, c.req.valid("json"));
      return c.json({ estimate, billing: billingState() });
    } catch (error) {
      return graphError(c, error);
    }
  })
  .get("/:workspaceId/graph/jobs/:jobId", async (c) => {
    const workspaceRef = c.req.param("workspaceId");
    const denied = await authorizeApiKey(c, workspaceRef, false);
    if (denied) return denied;
    try {
      return c.json(await getGraphJob(workspaceRef, c.get("sessionUser").id, c.req.param("jobId")));
    } catch (error) {
      return graphError(c, error);
    }
  })
  /**
   * Server-sent `progress` events whenever the job changes, then `done`.
   * Streams end after 10 minutes; reconnect, or poll GET .../jobs/:jobId.
   */
  .get("/:workspaceId/graph/jobs/:jobId/events", async (c) => {
    const workspaceRef = c.req.param("workspaceId");
    const denied = await authorizeApiKey(c, workspaceRef, false);
    if (denied) return denied;
    const userId = c.get("sessionUser").id;
    const jobId = c.req.param("jobId");
    let initial: GraphJob;
    try {
      initial = await getGraphJob(workspaceRef, userId, jobId);
    } catch (error) {
      return graphError(c, error);
    }

    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const deadline = Date.now() + JOB_STREAM_MAX_MS;
      let job = initial;
      let lastSent = "";
      while (!stream.aborted) {
        const snapshot = JSON.stringify(job);
        if (snapshot !== lastSent) {
          await stream.writeSSE({ event: "progress", data: snapshot });
          lastSent = snapshot;
        }
        if (!isGraphJobActive(job)) {
          await stream.writeSSE({ event: "done", data: snapshot });
          return;
        }
        if (Date.now() >= deadline) return;
        await stream.sleep(JOB_STREAM_POLL_MS);
        job = await getGraphJob(workspaceRef, userId, jobId);
      }
    });
  })
  .post("/:workspaceId/graph/jobs/:jobId/cancel", async (c) => {
    const workspaceRef = c.req.param("workspaceId");
    const denied = await authorizeApiKey(c, workspaceRef, true);
    if (denied) return denied;
    const userId = c.get("sessionUser").id;
    try {
      const job = await cancelGraphJob(workspaceRef, userId, c.req.param("jobId"));
      await audit(c, workspaceRef, userId, "workspace.graph.rebuild_cancelled", job.id, { status: job.status });
      return c.json(job);
    } catch (error) {
      return graphError(c, error);
    }
  });

acceptApiKeys(workspaceGraphRoutes);
