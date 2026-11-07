import { projectRefParameter } from "./state-management-openapi.js";

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
  // POST /v1/projects/{projectId}/settings-proposals/apply is a DocSlurp-app (session) endpoint, not public API.
  "/v1/projects/{projectId}/estimate": {
    post: {
      tags: ["projects"],
      summary: "Estimate a project update",
      description: "Same body as PATCH /v1/projects/{projectId}. Returns `{ impact, estimate, billing }`: whether the change needs a re-index (none, search-only, new-uploads, reindex-recommended, reindex-required) and what it would cost.",
      security,
      parameters: [projectRefParameter],
      requestBody: body,
      responses: estimateResponses,
    },
  },
  "/v1/projects/{projectId}/search-settings/estimate": {
    post: {
      tags: ["projects"],
      summary: "Estimate a search settings update",
      description: "Same body and access as PATCH /v1/projects/{projectId}/search-settings (session, or a server key with projects:manage). Returns `{ impact, estimate, billing }` and changes nothing.",
      security,
      parameters: [projectRefParameter],
      requestBody: body,
      responses: estimateResponses,
    },
  },
  "/v1/projects/{projectId}/full-index/estimate": {
    post: {
      tags: ["projects"],
      summary: "Estimate a project full index",
      security,
      parameters: [projectRefParameter],
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
  "/v1/projects/{projectId}/graph/jobs/estimate": {
    post: {
      tags: ["projects"],
      summary: "Estimate a knowledge graph rebuild",
      description: "Same body as POST …/graph/rebuild.",
      security,
      parameters: [projectRefParameter],
      requestBody: body,
      responses: estimateResponses,
    },
  },
  "/v1/uploads/estimate": {
    post: {
      tags: ["ingest"],
      summary: "Estimate an upload",
      description: "Body `{ files: [{ name, size, pages?, type?, durationSeconds?, profile? }], project? }` (project ID, slug or name; omitted: the default project; at most 1,000 files). Pages default to one for an image file and about one per 75 KB otherwise. `profile` is the file profile the offline profiler (`@docslurp/estimate`) measured on the caller's machine: neutral facts (page counts, PDF page facts, media duration). It is validated, clamped against `size` and used only to narrow the estimate; it never affects what an upload is charged. Audio and video files (by `type` or extension) are priced by duration: pass `durationSeconds` when known, otherwise it is guessed from the size. The response names the `orgId` whose credits the upload would spend (and `billingExempt` when that organization is never charged) and adds `media` when any file is audio or video: its credits (`low` reads video from the audio track only, `high` also reads frames), whether durations were assumed, and `lighter`, the upload pipeline override that skips video frames for the lower price. `kind` is always `estimate`; `profile` is the project's estimate profile and `pricingVersion` the pricing version that priced it.",
      security,
      requestBody: body,
      responses: estimateResponses,
    },
  },
  "/v1/estimate": {
    post: {
      tags: ["ingest"],
      summary: "Quote files before uploading (public)",
      description: "No account needed. Body `{ files: [{ name, size, type?, pages?, durationSeconds?, profile? }], settings? }` with at most 200 files, each `profile` from the offline profiler `@docslurp/estimate` (files never leave the caller's machine). `settings` are the quote's knobs: `quality` (fast, auto, good), `indexing` (full, on-demand, visual; visual cannot be combined with fast), `documentSummary`, `structuredFields`, `knowledgeGraph`, `propositions`, `videoFrames`, `speedBoost`, `hostingMonths` (1-60), `searchesPerMonth`, `chatAnswersPerMonth`, `chatTier`. Answers an estimate (`kind: estimate`, never a charge): ingest credits, monthly hosting and usage credits, neutral `lines`, page and byte ranges, `pricingVersion` and `validUntil`. Rate limited per client IP and per quote session (an opaque `ds_estimate_session` cookie); reads no account data and stores nothing. Signed-in callers quote a project with `POST /v1/uploads/estimate`.",
      security: [],
      requestBody: body,
      responses: estimateResponses,
    },
  },
};
