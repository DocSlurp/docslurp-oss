import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { startSummaryTreeBackfillSchema, updateProjectSummaryTreeSchema } from "@docslurp/shared";

import { SEARCH_SCOPES } from "../lib/search-tiers.js";
import { actorHasAnyApiKeyScope, getRequestActor, apiKeyCanUseProject } from "../lib/request-actor.js";
import { requestIp } from "../lib/request-context.js";
import { appendAuditLog } from "../services/audit-log.js";
import {
  getProjectSummaryTree,
  ProjectSummaryTreeError,
  updateProjectSummaryTree,
} from "../services/project-summary-tree.js";
import { isSpendBlockedError, spendBlockedResponse } from "../services/billing/spend-guard.js";
import { billingState } from "../services/config-change.js";
import { jobStatusForMutation } from "../services/jobs.js";
import {
  cancelSummaryTreeJob,
  estimateSummaryTreeBackfill,
  getProjectSummaryTreeBackfill,
  getSummaryTreeJob,
  startSummaryTreeBackfill,
  SummaryTreeJobError,
} from "../services/project-summary-tree-jobs.js";
import { getProject } from "../services/projects.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiErrorResponse, apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";

/**
 * API keys may read the summary tree state and its backfill jobs with any project scope; turning the tree on or off
 * and estimating, starting or cancelling a backfill need a server key with `projects:manage`. Keys are bound to
 * their organization, and a key restricted to other projects sees "Project not found".
 */
async function authorizeApiKey(c: Context, projectRef: string, write: boolean): Promise<Response | null> {
  const actor = getRequestActor(c);
  if (actor.type !== "apiKey") return null;
  const allowed = write
    ? actor.apiKey.keyType === "server" && actorHasAnyApiKeyScope(actor, ["projects:manage"])
    : actor.apiKey.keyType === "server" && actorHasAnyApiKeyScope(actor, ["ingest", ...SEARCH_SCOPES, "artifacts", "projects:manage"]);
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

function treeError(c: Context, error: unknown) {
  if (error instanceof ProjectSummaryTreeError) {
    return apiStatusError(c, error.status, error.message, error.code ? { code: error.code } : {});
  }
  if (error instanceof SummaryTreeJobError) {
    return apiStatusError(c, error.status, error.message, {
      ...(error.code ? { code: error.code } : {}),
      ...(error.activeJob ? { details: { activeJob: error.activeJob } } : {}),
    });
  }
  if (isSpendBlockedError(error)) return spendBlockedResponse(c, error);
  throw error;
}

async function audit(c: Context, projectRef: string, userId: string, action: string, resourceId: string, metadata: Record<string, unknown>) {
  const project = await getProject(projectRef, userId);
  if (!project) return;
  await appendAuditLog({
    orgId: project.orgId, userId, projectId: project.id, action, resourceType: "project-summary-tree", resourceId,
    ipAddress: requestIp(c), metadata,
  });
}

export const projectSummaryTreeRoutes = new Hono()
  /** Stored setting, deployment switches, build status, document counts and the read-only server constants. */
  .get("/:projectId/summary-tree", async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, false);
    if (denied) return denied;
    try {
      return c.json(await getProjectSummaryTree(projectRef, c.get("sessionUser").id));
    } catch (error) {
      return treeError(c, error);
    }
  })
  /**
   * The only way to turn a project's summary tree on or off: `{ "enabled": true | false }`. A general project save
   * keeps the stored value. Nothing is queued: new uploads get a tree, existing documents do not change.
   */
  .patch("/:projectId/summary-tree", zValidator("json", updateProjectSummaryTreeSchema, validationHook), async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, true);
    if (denied) return denied;
    const userId = c.get("sessionUser").id;
    const body = c.req.valid("json");
    try {
      const state = await updateProjectSummaryTree(projectRef, userId, body);
      const project = await getProject(projectRef, userId);
      if (project) {
        await appendAuditLog({
          orgId: project.orgId,
          userId,
          projectId: project.id,
          action: "project.summary_tree.updated",
          resourceType: "project-summary-tree",
          resourceId: project.id,
          ipAddress: requestIp(c),
          metadata: { enabled: state.enabled },
        });
      }
      return c.json(state);
    } catch (error) {
      return treeError(c, error);
    }
  })
  /**
   * Backfill: trees for the project's already indexed documents. What a job started now would cover and cost
   * (computed from counts, no model call), the active job and the last one.
   */
  .get("/:projectId/summary-tree/backfill", async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, false);
    if (denied) return denied;
    try {
      return c.json(await getProjectSummaryTreeBackfill(projectRef, c.get("sessionUser").id));
    } catch (error) {
      return treeError(c, error);
    }
  })
  /** The estimate a started job would carry, in the shared estimate shape. */
  .post("/:projectId/summary-tree/backfill/estimate", async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, true);
    if (denied) return denied;
    try {
      const estimate = await estimateSummaryTreeBackfill(projectRef, c.get("sessionUser").id);
      return c.json({ estimate, billing: billingState() });
    } catch (error) {
      return treeError(c, error);
    }
  })
  /**
   * Starts a backfill job: `{ "maxCostCents": n }`, mandatory. One active job per project. Follow it through
   * `GET /v1/jobs/:jobId` (polling) or `GET /v1/jobs/:jobId/events` (server-sent events).
   */
  .post("/:projectId/summary-tree/backfill", zValidator("json", startSummaryTreeBackfillSchema, validationHook), async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, true);
    if (denied) return denied;
    const userId = c.get("sessionUser").id;
    try {
      const job = await startSummaryTreeBackfill(projectRef, userId, c.req.valid("json"));
      await audit(c, projectRef, userId, "project.summary_tree.backfill_started", job.id, {
        documents: job.documentsTotal,
        estimatedCostCents: job.estimate?.costCents ?? null,
        maxCostCents: job.maxCostCents,
      });
      const read = await jobStatusForMutation({ id: job.id, kind: "summary-tree-backfill" }, [], userId);
      return c.json({ ...job, job: { ...read, estimateUrl: `/v1/projects/${projectRef}/summary-tree/backfill/estimate` } }, 202);
    } catch (error) {
      return treeError(c, error);
    }
  })
  .get("/:projectId/summary-tree/backfill/:jobId", async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, false);
    if (denied) return denied;
    try {
      return c.json(await getSummaryTreeJob(projectRef, c.get("sessionUser").id, c.req.param("jobId")));
    } catch (error) {
      return treeError(c, error);
    }
  })
  /** A queued or parked job is cancelled at once; a running job stops before its next model call. What was built is kept. */
  .post("/:projectId/summary-tree/backfill/:jobId/cancel", async (c) => {
    const projectRef = c.req.param("projectId");
    const denied = await authorizeApiKey(c, projectRef, true);
    if (denied) return denied;
    const userId = c.get("sessionUser").id;
    try {
      const job = await cancelSummaryTreeJob(projectRef, userId, c.req.param("jobId"));
      await audit(c, projectRef, userId, "project.summary_tree.backfill_cancelled", job.id, { status: job.status });
      return c.json(job);
    } catch (error) {
      return treeError(c, error);
    }
  });

acceptApiKeys(projectSummaryTreeRoutes);
