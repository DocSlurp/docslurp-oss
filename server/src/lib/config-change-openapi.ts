import { workspaceRefParameter } from "./state-management-openapi.js";

const security = [{ bearerAuth: [] }, { sessionAuth: [] }];
const jobIdParameter = { in: "path", name: "jobId", required: true, schema: { type: "string", minLength: 1 } };
const estimateResponses = {
  "200": { description: "`{ estimate, billing }`. `estimate` is a CostEstimate (pages, documents, credits range, seconds range, basis); `credits` is null and `billing` is \"disabled\" on deployments that do not bill." },
  "401": { description: "Authentication required" },
  "404": { description: "Not found" },
};
const body = { required: false, content: { "application/json": { schema: { type: "object" } } } };

/**
 * Jobs and estimates: `GET /v1/jobs/:id` is the shared job resource; every work-creating route has a
 * `…/estimate` twin with the same body that changes nothing. Mutations return `job` (same shape as the resource).
 */
export const configChangePaths = {
  "/v1/jobs/{jobId}": {
    get: {
      tags: ["jobs"],
      summary: "Job status",
      description: "Status of a re-index, full-index, reprocess or graph-rebuild job: queue position, run ids, estimate and progress. A blocked job (no credits or budget) resumes by itself.",
      security,
      parameters: [jobIdParameter],
      responses: { "200": { description: "JobStatus" }, "404": { description: "Job not found" } },
    },
  },
  "/v1/jobs/{jobId}/events": {
    get: {
      tags: ["jobs"],
      summary: "Job status stream",
      description: "Server-sent `status`, `progress` and a final `done` event. Streams end after 10 minutes; reconnect, or poll GET /v1/jobs/{jobId}.",
      security,
      parameters: [jobIdParameter],
      responses: { "200": { description: "text/event-stream" }, "404": { description: "Job not found" } },
    },
  },
  "/v1/workspaces/{workspaceId}/estimate": {
    post: {
      tags: ["workspaces"],
      summary: "Estimate a workspace update",
      description: "Same body as PATCH /v1/workspaces/{workspaceId}. Returns `{ impact, estimate, billing }`: whether the change needs a re-index (none, search-only, new-uploads, reindex-recommended, reindex-required) and what it would cost.",
      security,
      parameters: [workspaceRefParameter],
      requestBody: body,
      responses: estimateResponses,
    },
  },
  "/v1/workspaces/{workspaceId}/full-index/estimate": {
    post: {
      tags: ["workspaces"],
      summary: "Estimate a workspace full index",
      security,
      parameters: [workspaceRefParameter],
      requestBody: body,
      responses: estimateResponses,
    },
  },
  "/v1/documents/{documentId}/full-index/estimate": {
    post: {
      tags: ["documents"],
      summary: "Estimate a document full index",
      security,
      parameters: [{ in: "path", name: "documentId", required: true, schema: { type: "string" } }],
      responses: estimateResponses,
    },
  },
  "/v1/workspaces/{workspaceId}/graph/jobs/estimate": {
    post: {
      tags: ["workspaces"],
      summary: "Estimate a knowledge graph rebuild",
      description: "Same body as POST …/graph/rebuild.",
      security,
      parameters: [workspaceRefParameter],
      requestBody: body,
      responses: estimateResponses,
    },
  },
  "/v1/uploads/estimate": {
    post: {
      tags: ["ingest"],
      summary: "Estimate an upload",
      description: "Body `{ files: [{ name, size, pages? }], workspaceId? }`. Pages default to about one per 75 KB.",
      security,
      requestBody: body,
      responses: estimateResponses,
    },
  },
};
