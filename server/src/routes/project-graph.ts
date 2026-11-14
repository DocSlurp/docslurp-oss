import { Hono, type Context } from "hono";
import { SEARCH_SCOPES } from "../lib/search-tiers.js";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { startGraphRebuildSchema, updateProjectGraphSchema, type GraphJob } from "@docslurp/shared";

import { actorHasAnyApiKeyScope, getRequestActor, apiKeyCanUseProject } from "../lib/request-actor.js";
import { requestIp } from "../lib/request-context.js";
import { appendAuditLog } from "../services/audit-log.js";
import { jobStatusForMutation } from "../services/jobs.js";
import { billingState } from "../services/config-change.js";
import {
  cancelGraphJob,
  estimateGraphRebuild,
  getGraphJob,
  getProjectGraphStatus,
  isGraphJobActive,
  startGraphRebuild,
  updateProjectGraph,
  ProjectGraphError,
} from "../services/project-graph.js";
import { getProject } from "../services/projects.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";

const JOB_STREAM_POLL_MS = 1_000;
const JOB_STREAM_MAX_MS = 10 * 60_000;

/**
 * API keys may read graph state with any project scope; changing settings
 * or starting/cancelling rebuilds needs a server key with `projects:manage`.
 * Keys are bound to their organization.
 */
async function authorizeApiKey(c: Context, projectRef: string, write: boolean): Promise<Response | null> {
  const actor = getRequestActor(c);
  if (actor.type !== "apiKey") return null;
  const allowed = write
    ? actor.apiKey.keyType === "server" && actorHasAnyApiKeyScope(actor, ["projects:manage"])
    : actorHasAnyApiKeyScope(actor, ["ingest", ...SEARCH_SCOPES, "artifacts", "projects:manage"]);
  if (!allowed) {
    return apiStatusError(c, 403, write
        ? "This endpoint requires a server API key with the projects:manage scope"
        : "Forbidden");
  }
  const project = await getProject(projectRef, actor.userId);
  if (!project || !apiKeyCanUseProject(actor.apiKey, project)) {
    return apiErrorResponse(c, 404, "project_not_found", "Project not found");
  }
  return null;
}

function graphError(c: Context, error: unknown) {
  if (error instanceof ProjectGraphError) {
    return apiStatusError(c, error.status, error.message, { ...(error.code ? { code: error.code } : {}), ...(error.activeJob ? { details: { activeJob: error.activeJob } } : {}) });
  }
  throw error;
}

async function audit(c: Context, projectRef: string, userId: string, action: string, resourceId: string, metadata: Record<string, unknown>) {
  const project = await getProject(projectRef, userId);
  if (!project) return;
  await appendAuditLog({
    orgId: project.orgId,
    userId,
    projectId: project.id,
    action,
    resourceType: "project-graph",
    resourceId,
    ipAddress: requestIp(c),
    metadata,
  });
}

export const projectGraphRoutes = new Hono()
  /** Settings, coverage, stats, rebuild estimates and the active/last job. */
  .get("/:projectId/graph", async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, false);
    if (denied) return denied;
    try {
      return c.json(await getProjectGraphStatus(projectRef, c.get("sessionUser").id));
    } catch (error) {
      return graphError(c, error);
    }
  })
  /** Partial update: only the fields sent change. */
  .patch("/:projectId/graph", zValidator("json", updateProjectGraphSchema, validationHook), async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, true);
    if (denied) return denied;
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    try {
      const status = await updateProjectGraph(projectRef, userId, body);
      await audit(c, projectRef, userId, "project.graph.updated", status.projectId, {
        changed: Object.keys(body),
        configHash: status.configHash,
      });
      return c.json(status);
    } catch (error) {
      return graphError(c, error);
    }
  })
  .post("/:projectId/graph/rebuild", zValidator("json", startGraphRebuildSchema, validationHook), async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, true);
    if (denied) return denied;
    const userId = c.get("sessionUser").id;
    try {
      const job = await startGraphRebuild(projectRef, userId, c.req.valid("json"));
      await audit(c, projectRef, userId, "project.graph.rebuild_started", job.id, {
        mode: job.mode,
        documents: job.documentsTotal,
        estimatedCostCents: job.estimate?.costCents ?? null,
        maxCostCents: job.maxCostCents,
      });
      const read = await jobStatusForMutation({ id: job.id, kind: "graph-rebuild" }, [], userId);
      // The same estimate the estimate route returns, and that route.
      return c.json({ ...job, job: { ...read, estimateUrl: `/v1/projects/${projectRef}/graph/jobs/estimate` } }, 202);
    } catch (error) {
      return graphError(c, error);
    }
  })
  .post("/:projectId/graph/jobs/estimate", zValidator("json", startGraphRebuildSchema), async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, true);
    if (denied) return denied;
    try {
      const estimate = await estimateGraphRebuild(projectRef, c.get("sessionUser").id, c.req.valid("json"));
      return c.json({ estimate, billing: billingState() });
    } catch (error) {
      return graphError(c, error);
    }
  })
  .get("/:projectId/graph/jobs/:jobId", async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, false);
    if (denied) return denied;
    try {
      return c.json(await getGraphJob(projectRef, c.get("sessionUser").id, c.req.param("jobId")));
    } catch (error) {
      return graphError(c, error);
    }
  })
  /**
   * Server-sent `progress` events whenever the job changes, then `done`.
   * Streams end after 10 minutes; reconnect, or poll GET .../jobs/:jobId.
   */
  .get("/:projectId/graph/jobs/:jobId/events", async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, false);
    if (denied) return denied;
    const userId = c.get("sessionUser").id;
    const jobId = c.req.param("jobId");
    let initial: GraphJob;
    try {
      initial = await getGraphJob(projectRef, userId, jobId);
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
        job = await getGraphJob(projectRef, userId, jobId);
      }
    });
  })
  .post("/:projectId/graph/jobs/:jobId/cancel", async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, true);
    if (denied) return denied;
    const userId = c.get("sessionUser").id;
    try {
      const job = await cancelGraphJob(projectRef, userId, c.req.param("jobId"));
      await audit(c, projectRef, userId, "project.graph.rebuild_cancelled", job.id, { status: job.status });
      return c.json(job);
    } catch (error) {
      return graphError(c, error);
    }
  });

acceptApiKeys(projectGraphRoutes);
