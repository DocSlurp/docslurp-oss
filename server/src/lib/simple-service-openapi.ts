import { z } from "zod";
import { batchSearchInputSchema, searchInputSchema, workspaceChatInputSchema } from "./search-input.js";
import { searchResultSchema, workspaceChatResponseSchema } from "@docslurp/shared";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ "application/json": { schema } });
const response = (description: string, schema: object) => ({ description, content: json(schema) });
const request = (schema: object) => ({ required: true, content: json(schema) });
const serviceSecurity = [{ bearerAuth: [] }, { sessionAuth: [] }];
const keySecurity = [{ bearerAuth: [] }];
const scopedQuery = z.toJSONSchema(searchInputSchema);
const minScoreDescription = "Relevance floor, 0..1: drop results whose raw match strength is lower, and report noMatch when none remain. 0 disables it. Omitted: the workspace's retrieval default, else SEARCH_MIN_SCORE (0.1).";
const workspaceRef = { type: "string", description: "Workspace slug, former slug, UUID, or \"default\". Omitted: the organization default workspace." };
const uploadTarget = {
  workspaceId: { ...workspaceRef, description: "Append to this workspace (slug, former slug, UUID, or \"default\"). Omitted without newWorkspace, workspaceName or templateKey: the organization default workspace." },
  newWorkspace: { type: "boolean", description: "Create a new self-titled workspace instead of using the default workspace. Multipart sends the string \"true\"." },
  workspaceName: { type: "string", description: "Create a new workspace with this name." },
  templateKey: { type: "string", description: "Create a new workspace from this template." },
  orgId: { type: "string", description: "Session callers only: target this organization's default workspace. API keys use their organization." },
};
const errors = {
  "400": { description: "Invalid request" },
  "401": { description: "Authentication required" },
  "403": { description: "Key scope or browser domain denied" },
  "404": { description: "Resource not found in your organization" },
  "429": { description: "Rate limit reached" },
};

export const simpleServiceSchemas = {
  SearchResult: z.toJSONSchema(searchResultSchema),
  WorkspaceChatResponse: z.toJSONSchema(workspaceChatResponseSchema),
  Run: {
    type: "object", required: ["id", "workspaceId", "status"],
    properties: { id: { type: "string" }, workspaceId: { type: "string" }, status: { type: "string", enum: ["queued", "processing", "completed", "failed"] }, controlState: { type: ["string", "null"] }, error: { type: ["string", "null"] } },
  },
  UploadResponse: {
    type: "object", required: ["workspace", "run", "documents", "warnings"],
    properties: {
      workspace: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } },
      run: ref("Run"),
      documents: { type: "array", items: { type: "object", required: ["id", "filename", "status"], properties: { id: { type: "string" }, filename: { type: "string" }, status: { type: "string" } } } },
      warnings: { type: "array", items: { type: "string" } },
      rejected: {
        type: "array",
        description: "Bulk uploads only. Files left out of the run while the rest were accepted; the request fails only when no file is accepted, with the matching HTTP status (415, 413, or 422 when the reasons differ) and one issues entry per file whose path is the filename.",
        items: { type: "object", required: ["filename", "statusCode", "code", "message"], properties: {
          filename: { type: "string" }, statusCode: { type: "integer", enum: [413, 415, 422] },
          code: { enum: ["unsupported_type", "file_too_large", "unreadable_source", "rejected"] }, message: { type: "string" },
        } },
      },
    },
  },
  SearchAvailability: {
    type: ["object", "null"],
    description: "Corpus coverage for this search. isPartial is true while documents in scope are still processing; keywordOnly when some are served by keyword search before vector indexing finishes.",
    properties: {
      status: { enum: ["empty", "pending", "partial", "complete"] },
      isPartial: { type: "boolean" },
      keywordOnly: { type: "boolean" },
      scope: { type: "object", properties: { workspaceId: { type: "string" }, runId: { type: ["string", "null"] } } },
      coverage: {
        type: "object",
        properties: Object.fromEntries([
          "totalDocuments", "indexedDocuments", "pageIndexedDocuments", "searchableDocuments", "pageOnlyDocuments",
          "keywordOnlyDocuments", "failedDocuments", "inProgressDocuments", "totalPages", "searchablePages", "indexedChunkCount",
          "queuedRuns", "processingRuns",
        ].map((name) => [name, { type: "integer", minimum: 0 }])),
      },
      resultBreakdown: { type: "object", properties: { indexedResultCount: { type: "integer", minimum: 0 }, pageResultCount: { type: "integer", minimum: 0 } } },
      message: { type: ["string", "null"] },
    },
  },
  SearchResponse: {
    type: "object", required: ["results", "sessionId", "availability"],
    properties: {
      results: { type: "array", items: ref("SearchResult") }, sessionId: { type: "string" }, availability: ref("SearchAvailability"),
      noMatch: { type: "boolean", description: "True when the workspace is searchable but search returned no results: either nothing cleared the relevance floor (relevanceFloor.dropped > 0) or nothing was retrieved at all, e.g. a filter that matches nothing (dropped is 0). Say \"no good match\" instead of answering from weak passages; availability explains an empty or still-indexing corpus instead." },
      relevanceFloor: { type: "object", description: "The relevance floor applied to this search. Each result's relevance (0..1) is a raw match strength that does not depend on the other hits.", properties: {
        minScore: { type: "number", minimum: 0, maximum: 1, description: "Floor applied; 0 means disabled." }, dropped: { type: "integer", minimum: 0, description: "Retrieved candidates removed for being below the floor." },
      } },
    },
  },
  BatchSearchResponse: {
    type: "object", required: ["results"], properties: { results: { type: "array", minItems: 1, maxItems: 20, items: { oneOf: [
      { type: "object", required: ["ok", "data"], properties: { ok: { const: true }, data: ref("SearchResponse") } },
      { type: "object", required: ["ok", "error"], properties: { ok: { const: false }, error: { type: "object", required: ["code", "message", "status"], properties: {
        code: { enum: ["FORBIDDEN", "WORKSPACE_NOT_FOUND", "INVALID_SEARCH_SCOPE", "SEARCH_FAILED", "REQUEST_ABORTED"] }, message: { type: "string" }, status: { type: "integer" },
      } } } },
    ] } } },
  },
  WorkspaceModel: {
    type: "object", required: ["id", "object", "created", "owned_by"],
    properties: { id: { type: "string", pattern: "^workspace:" }, object: { const: "model" }, created: { type: "integer" }, owned_by: { const: "docslurp" }, name: { type: "string" } },
  },
  ChatCompletionRequest: {
    type: "object", additionalProperties: false, required: ["model", "messages"],
    description: "Text-only workspace chat. Include history; end with a nonempty user message. Unsupported controls are rejected.",
    properties: {
      model: { type: "string", pattern: "^workspace:(?:default|[0-9a-fA-F-]{36})$", description: "workspace:default for the organization default workspace, or workspace:<uuid> from GET /v1/models." },
      messages: { type: "array", minItems: 1, maxItems: 64, items: { type: "object", additionalProperties: false, required: ["role", "content"], properties: {
        role: { enum: ["system", "developer", "user", "assistant"] },
        content: { oneOf: [{ type: "string", maxLength: 64000 }, { type: "array", minItems: 1, maxItems: 16, items: { type: "object", additionalProperties: false, required: ["type", "text"], properties: { type: { const: "text" }, text: { type: "string", maxLength: 64000 } } } }] },
      } } },
      stream: { type: "boolean", default: false },
      stream_options: { type: "object", additionalProperties: false, properties: { include_usage: { type: "boolean" } } },
      max_completion_tokens: { type: "integer", minimum: 1, maximum: 16384 },
      max_tokens: { type: "integer", minimum: 1, maximum: 16384, description: "Alias; cannot be combined with max_completion_tokens" },
      n: { const: 1 }, user: { type: "string", maxLength: 256 },
    },
  },
  ChatCompletion: {
    type: "object", required: ["id", "object", "created", "model", "choices", "usage"],
    properties: {
      id: { type: "string" }, object: { const: "chat.completion" }, created: { type: "integer" }, model: { type: "string" },
      choices: { type: "array", items: { type: "object", required: ["index", "message", "finish_reason"], properties: { index: { const: 0 }, message: { type: "object", properties: { role: { const: "assistant" }, content: { type: "string" }, refusal: { type: "null" } } }, finish_reason: { enum: ["stop", "length", "content_filter"] }, logprobs: { type: "null" } } } },
      usage: { type: "object", required: ["prompt_tokens", "completion_tokens", "total_tokens"], properties: { prompt_tokens: { type: "integer" }, completion_tokens: { type: "integer" }, total_tokens: { type: "integer" } } },
      docslurp: { type: "object", description: "Structured citations and corpus availability; safe to ignore in standard clients." },
    },
  },
};

const legacyServicePaths = {
  "/v1/ingest/bulk": { post: {
    tags: ["ingest"], summary: "Upload files into the default workspace, a chosen workspace, or a new one", security: serviceSecurity,
    description: "One buffered multipart request, capped at MAX_MULTIPART_UPLOAD_BYTES (25 MB by default; 413 code multipart_upload_too_large above it). Upload larger files with a direct upload session: POST /v1/ingest/direct/sessions, PUT to the returned URLs, then confirm.",
    parameters: [{ in: "header", name: "Idempotency-Key", schema: { type: "string" }, description: "Reuse only for identical uploads" }],
    requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", required: ["files"], properties: {
      files: { type: "array", minItems: 1, items: { type: "string", format: "binary" } }, ...uploadTarget, newWorkspace: { type: "string", enum: ["true"], description: uploadTarget.newWorkspace.description },
    } } } } },
    responses: { "201": response("Accepted for asynchronous processing. Poll run progress before searching.", ref("UploadResponse")), ...errors },
  } },
  "/v1/ingest/url": { post: {
    tags: ["ingest"], summary: "Ingest remote documents into a workspace", security: serviceSecurity,
    requestBody: request({ type: "object", required: ["urls"], properties: { urls: { type: "array", minItems: 1, items: { type: "string", format: "uri" } }, ...uploadTarget } }),
    responses: { "201": response("Ingestion accepted", ref("UploadResponse")), ...errors },
  } },
  "/v1/runs/{runId}/progress": { get: {
    tags: ["runs"], summary: "Observe run completion", security: serviceSecurity,
    parameters: [{ in: "path", name: "runId", required: true, schema: { type: "string" } }],
    responses: { "200": response("Progress snapshot; run.status reports completion", { type: "object", required: ["run"], properties: { run: ref("Run") } }), ...errors },
  } },
  "/v1/search": {
    get: { tags: ["search"], summary: "Search a workspace", security: serviceSecurity, parameters: [
      { in: "query", name: "q", required: true, schema: { type: "string" } }, { in: "query", name: "workspaceId", description: workspaceRef.description, schema: { type: "string" } }, { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { in: "query", name: "minScore", description: minScoreDescription, schema: { type: "number", minimum: 0, maximum: 1 } },
    ], responses: { "200": response("Cited passages with corpus availability", ref("SearchResponse")), ...errors } },
    post: { tags: ["search"], summary: "Search a workspace", security: serviceSecurity, requestBody: request({ oneOf: [scopedQuery, z.toJSONSchema(batchSearchInputSchema)] }), responses: { "200": response("Single-query passages or ordered batch outcomes", { oneOf: [ref("SearchResponse"), ref("BatchSearchResponse")] }), ...errors } },
  },
  "/v1/search/batch": { post: {
    tags: ["search"], summary: "Retrieve cited passages for up to 20 independent queries", security: serviceSecurity,
    description: "Ordered results; per-item authorization and errors. Default concurrency 4, maximum 4. No answer generation; retrieval enhancements are opt-in. Disconnect stops queued work; already running retrieval may finish.",
    requestBody: request(z.toJSONSchema(batchSearchInputSchema)),
    responses: { "200": response("One ordered outcome per query", ref("BatchSearchResponse")), ...errors },
  } },
  "/v1/chat": { post: {
    tags: ["chat"], summary: "Ask a grounded workspace question", security: serviceSecurity,
    description: "Parallel requests may use independent conversations. Await each reply before sending the next turn with the same sessionId; concurrent turns in one conversation have no ordering guarantee.",
    requestBody: request(z.toJSONSchema(workspaceChatInputSchema)),
    responses: { "200": response("Grounded answer, citations and actual usage", ref("WorkspaceChatResponse")), ...errors },
  } },
  "/v1/search/chat": { post: {
    tags: ["search"], summary: "Compatibility alias for POST /v1/chat", security: serviceSecurity,
    requestBody: request(z.toJSONSchema(workspaceChatInputSchema)),
    responses: { "200": response("Grounded answer, citations and actual usage", ref("WorkspaceChatResponse")), ...errors },
  } },
  "/v1/models": { get: {
    tags: ["chat"], summary: "List accessible workspaces as chat models", security: keySecurity,
    responses: { "200": response("Workspace model list", { type: "object", required: ["object", "data"], properties: { object: { const: "list" }, data: { type: "array", items: ref("WorkspaceModel") } } }), ...errors },
  } },
  "/v1/chat/completions": { post: {
    tags: ["chat"], summary: "OpenAI-compatible workspace chat", security: keySecurity,
    requestBody: request(ref("ChatCompletionRequest")),
    responses: { "200": { description: "Completion JSON, or data-only SSE chunks ending with [DONE]. include_usage adds a final usage chunk. Usage covers answer generation; retrieval is logged separately.", content: { ...json(ref("ChatCompletion")), "text/event-stream": { schema: { type: "string" } } } }, ...errors, "500": { description: "Workspace answer failed" } },
  } },
};

export const simpleServicePaths = { ...legacyServicePaths,
  "/v1/uploads/bulk": legacyServicePaths["/v1/ingest/bulk"],
  "/v1/uploads/url": legacyServicePaths["/v1/ingest/url"],
};
