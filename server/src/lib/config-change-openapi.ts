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
  "/v1/workspaces/{workspaceId}/settings-proposals/apply": {
    post: {
      tags: ["workspaces"],
      summary: "Apply a trusted workspace settings proposal",
      description: "Explicit approval action for a proposal prepared in the same actor's workspace conversation. Requires workspace editor access; server API keys also need workspaces:manage and matching organization/workspace scope. This operation is never exposed as an MCP/model tool. The opaque token binds the exact changes, actor, conversation, workspace and current state, expires after ten minutes and cannot be reused after settings change. Existing-document work requires separate reprocessExisting consent; required reindex proposals reject false. Refresh expired or stale proposals instead of retrying them automatically.",
      security,
      parameters: [workspaceRefParameter],
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object", additionalProperties: false, required: ["token"], properties: {
          token: { type: "string", minLength: 1, maxLength: 32768 },
          reprocessExisting: { type: "boolean", default: false },
        },
      } } } },
      responses: {
        "200": { description: "Settings saved: { applied: true, workspaceId, reprocess: { requested, status: queued | not-requested | blocked, jobId? } }. Queued does not imply work completed." },
        "400": { description: "Invalid token input or unavailable reprocessing" },
        "401": { description: "Authentication required" },
        "403": { description: "Actor, workspace, conversation, permission or key scope mismatch" },
        "409": { description: "Stale proposal or required reprocessing consent missing" },
        "410": { description: "Proposal expired; request a fresh proposal" },
      },
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
      description: "Body `{ files: [{ name, size, pages?, type?, durationSeconds? }], workspace? }` (workspace ID, slug or name; omitted: the default workspace). Pages default to about one per 75 KB. Audio and video files (by `type` or extension) are priced by duration: pass `durationSeconds` when known, otherwise it is guessed from the size. The response names the `orgId` whose credits the upload would spend (and `billingExempt` when that organization is never charged) and adds `media` when any file is audio or video: its credits (`low` reads video from the audio track only, `high` also reads frames), whether durations were assumed, and `lighter`, the upload pipeline override that skips video frames for the lower price.",
      security,
      requestBody: body,
      responses: estimateResponses,
    },
  },
};
