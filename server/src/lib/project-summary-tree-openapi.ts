import { z } from "zod";
import {
  projectSummaryTreeBackfillSchema,
  projectSummaryTreeStateSchema,
  startSummaryTreeBackfillSchema,
  summaryTreeJobSchema,
  updateProjectSummaryTreeSchema,
} from "@docslurp/shared";

import { projectRefHeaders, projectRefParameter } from "./state-management-openapi.js";
import { apiErrorOpenApiResponse } from "./api-error-openapi.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ "application/json": { schema } });
const security = [{ bearerAuth: [] }, { sessionAuth: [] }];
const readAccess = "Session project access, or an organization-bound server key with any of ingest, search, artifacts, projects:manage.";
const writeAccess = "Session with edit access, or a server key with the opt-in projects:manage scope (the key owner's project role still applies).";
const errors = {
  "401": apiErrorOpenApiResponse("Authentication required"),
  "403": apiErrorOpenApiResponse("Missing scope or project edit access"),
  "404": apiErrorOpenApiResponse("Project not found"),
};

export const projectSummaryTreeSchemas = {
  ProjectSummaryTreeState: z.toJSONSchema(projectSummaryTreeStateSchema, { unrepresentable: "any" }),
  UpdateProjectSummaryTree: z.toJSONSchema(updateProjectSummaryTreeSchema, { unrepresentable: "any", io: "input" }),
  ProjectSummaryTreeBackfill: z.toJSONSchema(projectSummaryTreeBackfillSchema, { unrepresentable: "any" }),
  StartSummaryTreeBackfill: z.toJSONSchema(startSummaryTreeBackfillSchema, { unrepresentable: "any", io: "input" }),
  SummaryTreeJob: z.toJSONSchema(summaryTreeJobSchema, { unrepresentable: "any" }),
};

const jobIdParameter = { in: "path", name: "jobId", required: true, schema: { type: "string" } };
const estimateResponse = {
  description: "The estimate and whether billing is enforced",
  content: json({
    type: "object",
    required: ["estimate", "billing"],
    properties: { estimate: { type: "object", additionalProperties: true }, billing: { type: "string", enum: ["enforced", "disabled"] } },
  }),
};

export const projectSummaryTreePaths = {
  "/v1/projects/{projectId}/summary-tree": {
    get: {
      tags: ["projects"],
      summary: "Read the project summary tree state",
      description: `${readAccess} The summary tree is an optional index of section summaries inside each long document, searched beside the document's passages. Returns the project's stored setting (enabled), whether this deployment builds trees (buildAvailable), whether it can account for a build (buildPriced: false when it charges for work but has no price for the tree) and lets search read them (serveAvailable), the project's stored retrieval mode (searchMode) and the mode a search runs without a per-request override (effectiveSearchMode: off unless the tree is enabled and served), the build status (off, building, partial, ready), counts of the project's current documents by tree status, the number of built nodes, and the read-only server constants. The same block is part of GET /v1/projects/{projectId}/state.`,
      security,
      parameters: [projectRefParameter],
      responses: { "200": { description: "Summary tree state", headers: projectRefHeaders, content: json(ref("ProjectSummaryTreeState")) }, ...errors },
    },
    patch: {
      tags: ["projects"],
      summary: "Turn the project summary tree on or off",
      description: `${writeAccess} The only way to change the setting: PATCH /v1/projects/{projectId} keeps the stored value whatever its pipeline says, and no template, default or upload option turns it on. Turning it on also turns document summaries on. Nothing is queued: new uploads get a tree; existing documents do not change. Refused with 400 summary_tree_unavailable while the deployment does not build trees, 400 summary_tree_unpriced while the deployment charges for work but has no price for the tree, 400 summary_tree_requires_vectors when the project does not embed and index vectors, and 409 summary_tree_summarize_locked when the project's template keeps document summaries off. Turning it off is always allowed.`,
      security,
      parameters: [projectRefParameter],
      requestBody: { required: true, content: json(ref("UpdateProjectSummaryTree")) },
      responses: {
        "200": { description: "Updated summary tree state", headers: projectRefHeaders, content: json(ref("ProjectSummaryTreeState")) },
        "400": apiErrorOpenApiResponse("Invalid body, the deployment does not build trees or has no price for the tree, or the project does not index vectors"),
        "409": apiErrorOpenApiResponse("The project's template keeps document summaries off"),
        ...errors,
      },
    },
  },
  "/v1/projects/{projectId}/summary-tree/backfill": {
    get: {
      tags: ["projects"],
      summary: "Read the summary tree backfill of a project",
      description: `${readAccess} The backfill builds summary trees for documents the project already holds (turning the tree on only affects new uploads). Returns what a job started now would cover and cost (estimate: documents without a servable tree, how many are long enough to get one, the section summaries and model calls expected, cost and time as ranges; computed from stored counts, without reading a document or calling a model, and calibrated by finished builds of the organization once there are some), the active job and the last finished one. The estimate here is a recent one, refreshed about once a minute; POST .../backfill/estimate and a started job's own estimate are always current. costBasis says what the cost figures and a job's cap count: billed (credits billed to the organization, one summary tree unit per summary model call) or provider (the model's own cost, on a deployment that does not charge). The estimate is null on a deployment that charges for work but has no price for the tree.`,
      security,
      parameters: [projectRefParameter],
      responses: { "200": { description: "Backfill estimate and jobs", headers: projectRefHeaders, content: json(ref("ProjectSummaryTreeBackfill")) }, ...errors },
    },
    post: {
      tags: ["projects"],
      summary: "Start a summary tree backfill",
      description: `${writeAccess} Queues a job that builds the summary tree of every current document of the project that has none it can serve. maxCostCents is required: the job stops before the model call that would pass it, and a later job continues from what was built. The cap counts billed credits where the deployment charges for the tree (each summary model call bills one summary tree unit, debited from the organization as it is made), and the model's own cost where it does not. One active job per project. Refused with 400 summary_tree_unavailable while the deployment does not build trees, 400 summary_tree_unpriced while the deployment charges for work but has no price for the tree, 400 summary_tree_backfill_cap_too_high when maxCostCents is above the deployment's limit for one job, 400 when maxCostCents is below 0.01, 409 when the tree is off for the project or no document needs one, and 402 when the organization may not spend. The job is also the shared job resource: follow it with GET /v1/jobs/{jobId} (polling) or GET /v1/jobs/{jobId}/events (server-sent events). A job that cannot proceed for a reason that clears on its own (the deployment paused building, the model provider cannot take more work, the organization is out of credits) is blocked, makes no call, and resumes by itself. Documents shorter than the long-document floor, spreadsheets and media get no tree and are counted as skipped.`,
      security,
      parameters: [projectRefParameter],
      requestBody: { required: true, content: json(ref("StartSummaryTreeBackfill")) },
      responses: {
        "202": { description: "Queued job with its estimate; `job` is the shared job status", content: json(ref("SummaryTreeJob")) },
        "400": apiErrorOpenApiResponse("Missing or invalid maxCostCents (below 0.01, or above the deployment's limit for one job), the deployment does not build trees or has no price for the tree, or the project does not index vectors"),
        "402": apiErrorOpenApiResponse("The organization may not spend"),
        "409": apiErrorOpenApiResponse("The tree is off for the project, nothing needs a tree, or a job is already active (returned as activeJob)"),
        ...errors,
      },
    },
  },
  "/v1/projects/{projectId}/summary-tree/backfill/estimate": {
    post: {
      tags: ["projects"],
      summary: "Estimate a summary tree backfill",
      description: `${writeAccess} The estimate a job started now would carry, in the shared estimate shape. No body. Nothing is queued and no model is called. Where billing is enforced, credits are what the organization would be billed: one summary tree unit per expected summary model call, the basis a job's maxCostCents is counted in. Refused with 400 summary_tree_unpriced while the deployment charges for work but has no price for the tree.`,
      security,
      parameters: [projectRefParameter],
      responses: {
        "200": estimateResponse,
        "400": apiErrorOpenApiResponse("The deployment does not build trees or has no price for the tree, or the project does not index vectors"),
        "409": apiErrorOpenApiResponse("The tree is off for the project"),
        ...errors,
      },
    },
  },
  "/v1/projects/{projectId}/summary-tree/backfill/{jobId}": {
    get: {
      tags: ["projects"],
      summary: "Read a summary tree backfill job",
      description: `${readAccess} Status (queued, running, blocked, completed, failed, cancelled), blockedReason while blocked (build-off, balance, credits, policy, unpriced), documents ready, skipped and partial, section summaries built, model calls, tokens, cost so far against maxCostCents (costCents, on costBasis: billed credits or the model's own cost), and etaSeconds at the observed pace. A blocked job waits longer after every park in a row and ends failed, with a note, when it has been parked for days without progress. A job of another project is not found.`,
      security,
      parameters: [projectRefParameter, jobIdParameter],
      responses: { "200": { description: "Job", content: json(ref("SummaryTreeJob")) }, ...errors },
    },
  },
  "/v1/projects/{projectId}/summary-tree/backfill/{jobId}/cancel": {
    post: {
      tags: ["projects"],
      summary: "Stop a summary tree backfill",
      description: `${writeAccess} A queued or blocked job is cancelled at once; a running job stops before its next model call. Trees already built stay and are served; a document stopped midway keeps its finished sections for the next job.`,
      security,
      parameters: [projectRefParameter, jobIdParameter],
      responses: { "200": { description: "Job with cancelRequested set", content: json(ref("SummaryTreeJob")) }, ...errors },
    },
  },
};
