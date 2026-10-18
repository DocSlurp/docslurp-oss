import { z } from "zod";
import {
  graphJobSchema,
  startGraphRebuildSchema,
  updateWorkspaceGraphSchema,
  workspaceGraphStatusSchema,
} from "@docslurp/shared";

import { workspaceRefHeaders, workspaceRefParameter } from "./state-management-openapi.js";
import { apiErrorOpenApiResponse } from "./api-error-openapi.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ "application/json": { schema } });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { unrepresentable: "any" });
const inputSchema = (value: z.ZodType) => z.toJSONSchema(value, { unrepresentable: "any", io: "input" });
const security = [{ bearerAuth: [] }, { sessionAuth: [] }];
const jobIdParameter = { in: "path", name: "jobId", required: true, schema: { type: "string", minLength: 1 } };
const readAccess = "Session workspace access, or an organization-bound key with any of ingest, search, artifacts, workspaces:manage.";
const writeAccess = "Session with edit access, or a server key with the opt-in workspaces:manage scope (the key owner's workspace role still applies).";
const errors = {
  "401": apiErrorOpenApiResponse("Authentication required"),
  "403": apiErrorOpenApiResponse("Missing scope or workspace edit access"),
  "404": apiErrorOpenApiResponse("Workspace or job not found"),
};

export const workspaceGraphSchemas = {
  WorkspaceGraphStatus: schema(workspaceGraphStatusSchema),
  UpdateWorkspaceGraph: inputSchema(updateWorkspaceGraphSchema),
  StartGraphRebuild: inputSchema(startGraphRebuildSchema),
  GraphJob: schema(graphJobSchema),
};

export const workspaceGraphPaths = {
  "/v1/workspaces/{workspaceId}/graph": {
    get: {
      tags: ["workspaces"],
      summary: "Read the workspace knowledge graph",
      description: `${readAccess} Settings, entity/relationship/community counts, document coverage (current, stale = extracted with other settings, missing), cost/time estimates for updating stale documents and for a full rebuild at each depth, and the active/last rebuild job. Estimates use observed per-call figures once earlier extractions with the same settings exist (basis: observed), otherwise typical rates (basis: default) with a wider range.`,
      security,
      parameters: [workspaceRefParameter],
      responses: { "200": { description: "Graph status", headers: workspaceRefHeaders, content: json(ref("WorkspaceGraphStatus")) }, ...errors },
    },
    patch: {
      tags: ["workspaces"],
      summary: "Update knowledge graph settings",
      description: `${writeAccess} Partial update: fields left out keep their value. enabled turns the graph on or off (off also stops entity indexing and community summaries; the existing graph is kept). domain describes the workspace's business or project scope (null falls back to the workspace's own name and template). entityTypes is the node vocabulary (empty = generic set). depth trades cost for coverage. New uploads use new settings immediately; existing documents become stale until rebuilt.`,
      security,
      parameters: [workspaceRefParameter],
      requestBody: { required: true, content: json(ref("UpdateWorkspaceGraph")) },
      responses: {
        "200": { description: "Updated graph status", headers: workspaceRefHeaders, content: json(ref("WorkspaceGraphStatus")) },
        "400": apiErrorOpenApiResponse("Invalid fields, or the graph needs embeddings enabled"),
        ...errors,
      },
    },
  },
  "/v1/workspaces/{workspaceId}/graph/rebuild": {
    post: {
      tags: ["workspaces"],
      summary: "Rebuild the workspace knowledge graph",
      description: `${writeAccess} Queues a job that re-extracts documents from stored text (no re-parsing), merging each into the graph as it finishes, then re-clusters communities. mode stale (default) covers documents never extracted or extracted with other settings; full covers every current document. maxCostCents stops the job once actual spend reaches it. One active job per workspace. Spend is attributed to the workspace.`,
      security,
      parameters: [workspaceRefParameter],
      requestBody: { required: true, content: json(ref("StartGraphRebuild")) },
      responses: {
        "202": { description: "Queued job with its estimate", content: json(ref("GraphJob")) },
        "409": apiErrorOpenApiResponse("Graph disabled, nothing to rebuild, or a job is already active (returned as activeJob)"),
        ...errors,
      },
    },
  },
  "/v1/workspaces/{workspaceId}/graph/jobs/{jobId}": {
    get: {
      tags: ["workspaces"],
      summary: "Read a graph rebuild job",
      description: `${readAccess} Progress (documents, extraction calls, tokens, cost), phase (queued, extracting, communities, done) and etaSeconds at the observed pace. Poll this when server-sent events are unavailable.`,
      security,
      parameters: [workspaceRefParameter, jobIdParameter],
      responses: { "200": { description: "Job", content: json(ref("GraphJob")) }, ...errors },
    },
  },
  "/v1/workspaces/{workspaceId}/graph/jobs/{jobId}/events": {
    get: {
      tags: ["workspaces"],
      summary: "Stream graph rebuild progress",
      description: `${readAccess} Server-sent events: progress (GraphJob JSON) whenever the job changes, then done with the final job. Streams close after 10 minutes; reconnect or poll GET .../graph/jobs/{jobId}.`,
      security,
      parameters: [workspaceRefParameter, jobIdParameter],
      responses: {
        "200": {
          description: "SSE frames: progress = GraphJob, done = GraphJob",
          content: { "text/event-stream": { schema: { type: "string" } } },
          "x-sse-events": { progress: ref("GraphJob"), done: ref("GraphJob") },
        },
        ...errors,
      },
    },
  },
  "/v1/workspaces/{workspaceId}/graph/jobs/{jobId}/cancel": {
    post: {
      tags: ["workspaces"],
      summary: "Stop a graph rebuild",
      description: `${writeAccess} Queued jobs cancel immediately; running jobs stop after their current batch. Documents already merged stay in the graph.`,
      security,
      parameters: [workspaceRefParameter, jobIdParameter],
      responses: { "200": { description: "Job with cancelRequested set", content: json(ref("GraphJob")) }, ...errors },
    },
  },
};
