import { z } from "zod";
import {
  graphJobSchema,
  startGraphRebuildSchema,
  updateProjectGraphSchema,
  projectGraphStatusSchema,
} from "@docslurp/shared";

import { projectRefHeaders, projectRefParameter } from "./state-management-openapi.js";
import { apiErrorOpenApiResponse } from "./api-error-openapi.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ "application/json": { schema } });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { unrepresentable: "any" });
const inputSchema = (value: z.ZodType) => z.toJSONSchema(value, { unrepresentable: "any", io: "input" });
const security = [{ bearerAuth: [] }, { sessionAuth: [] }];
const jobIdParameter = { in: "path", name: "jobId", required: true, schema: { type: "string", minLength: 1 } };
const readAccess = "Session project access, or an organization-bound key with any of ingest, search, artifacts, projects:manage.";
const writeAccess = "Session with edit access, or a server key with the opt-in projects:manage scope (the key owner's project role still applies).";
const errors = {
  "401": apiErrorOpenApiResponse("Authentication required"),
  "403": apiErrorOpenApiResponse("Missing scope or project edit access"),
  "404": apiErrorOpenApiResponse("Project or job not found"),
};

export const projectGraphSchemas = {
  ProjectGraphStatus: schema(projectGraphStatusSchema),
  UpdateProjectGraph: inputSchema(updateProjectGraphSchema),
  StartGraphRebuild: inputSchema(startGraphRebuildSchema),
  GraphJob: schema(graphJobSchema),
};

export const projectGraphPaths = {
  "/v1/projects/{projectId}/graph": {
    get: {
      tags: ["projects"],
      summary: "Read the project knowledge graph",
      description: `${readAccess} Settings, entity/relationship/community counts, document coverage (current, stale = extracted with other settings, missing), cost/time estimates for updating stale documents and for a full rebuild at each depth, and the active/last rebuild job. Estimates use observed per-call figures once earlier extractions with the same settings exist (basis: observed), otherwise typical rates (basis: default) with a wider range.`,
      security,
      parameters: [projectRefParameter],
      responses: { "200": { description: "Graph status", headers: projectRefHeaders, content: json(ref("ProjectGraphStatus")) }, ...errors },
    },
    patch: {
      tags: ["projects"],
      summary: "Update knowledge graph settings",
      description: `${writeAccess} Partial update: fields left out keep their value. enabled turns the graph on or off (off also stops entity indexing and community summaries; the existing graph is kept). domain describes the project's business or project scope (null falls back to the project's own name and template). entityTypes is the node vocabulary (empty = generic set). depth trades cost for coverage. New uploads use new settings immediately; existing documents become stale until rebuilt.`,
      security,
      parameters: [projectRefParameter],
      requestBody: { required: true, content: json(ref("UpdateProjectGraph")) },
      responses: {
        "200": { description: "Updated graph status", headers: projectRefHeaders, content: json(ref("ProjectGraphStatus")) },
        "400": apiErrorOpenApiResponse("Invalid fields, or the graph needs embeddings enabled"),
        ...errors,
      },
    },
  },
  "/v1/projects/{projectId}/graph/rebuild": {
    post: {
      tags: ["projects"],
      summary: "Rebuild the project knowledge graph",
      description: `${writeAccess} Queues a job that re-extracts documents from stored text (no re-parsing), merging each into the graph as it finishes, then re-clusters communities. mode stale (default) covers documents never extracted or extracted with other settings; full covers every current document. maxCostCents stops the job once actual spend reaches it. One active job per project. Spend is attributed to the project.`,
      security,
      parameters: [projectRefParameter],
      requestBody: { required: true, content: json(ref("StartGraphRebuild")) },
      responses: {
        "202": { description: "Queued job with its estimate", content: json(ref("GraphJob")) },
        "409": apiErrorOpenApiResponse("Graph disabled, nothing to rebuild, or a job is already active (returned as activeJob)"),
        ...errors,
      },
    },
  },
  "/v1/projects/{projectId}/graph/jobs/{jobId}": {
    get: {
      tags: ["projects"],
      summary: "Read a graph rebuild job",
      description: `${readAccess} Progress (documents, extraction calls, tokens, cost), phase (queued, extracting, communities, done) and etaSeconds at the observed pace. Poll this when server-sent events are unavailable.`,
      security,
      parameters: [projectRefParameter, jobIdParameter],
      responses: { "200": { description: "Job", content: json(ref("GraphJob")) }, ...errors },
    },
  },
  "/v1/projects/{projectId}/graph/jobs/{jobId}/events": {
    get: {
      tags: ["projects"],
      summary: "Stream graph rebuild progress",
      description: `${readAccess} Server-sent events: progress (GraphJob JSON) whenever the job changes, then done with the final job. Streams close after 10 minutes; reconnect or poll GET .../graph/jobs/{jobId}.`,
      security,
      parameters: [projectRefParameter, jobIdParameter],
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
  "/v1/projects/{projectId}/graph/jobs/{jobId}/cancel": {
    post: {
      tags: ["projects"],
      summary: "Stop a graph rebuild",
      description: `${writeAccess} Queued jobs cancel immediately; running jobs stop after their current batch. Documents already merged stay in the graph.`,
      security,
      parameters: [projectRefParameter, jobIdParameter],
      responses: { "200": { description: "Job with cancelRequested set", content: json(ref("GraphJob")) }, ...errors },
    },
  },
};
