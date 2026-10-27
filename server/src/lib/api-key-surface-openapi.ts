import { apiErrorOpenApiResponse } from "./api-error-openapi.js";
/**
 * OpenAPI entries for API-key routes that had no documentation of their own
 * (document reads, direct uploads, run events and search
 * helpers). Of the document writes, only content updates (delete, retag,
 * bulk, run reprocess) accept a key: a server key with the `ingest` scope.
 * `route-auth-integration.test.ts` requires the bearerAuth operations in the
 * OpenAPI document to match the routes declared with `acceptApiKeys` exactly.
 */
export const keyOrSessionSecurity = [{ bearerAuth: [] }, { sessionAuth: [] }];

type Method = "get" | "post" | "put" | "patch" | "delete";

const errors = {
  "400": apiErrorOpenApiResponse("Invalid request"),
  "401": apiErrorOpenApiResponse("Authentication required"),
  "403": apiErrorOpenApiResponse("Key scope, key type, workspace allowlist or browser domain denied"),
  "404": apiErrorOpenApiResponse("Resource not found in your organization"),
  "429": apiErrorOpenApiResponse("Rate limit reached"),
};

function pathParameters(path: string) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({ in: "path", name, required: true, schema: { type: "string" } }));
}

function operation(path: string, tag: string, summary: string, scope: string, success: string, extra: Record<string, unknown> = {}) {
  return {
    tags: [tag],
    summary,
    description: scope === "API key" ? "API key only." : `API keys need the \`${scope}\` scope.`,
    security: keyOrSessionSecurity,
    parameters: pathParameters(path),
    responses: { "200": { description: success }, ...errors },
    ...extra,
  };
}

const jsonBody = { requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } } };

const entries: Array<[path: string, method: Method, tag: string, summary: string, scope: string, success: string, extra?: Record<string, unknown>]> = [
  ["/v1/capabilities", "post", "search", "Mint a sealed search capability (X-DocSlurp-Capability) that bounds query-time page parsing for browser callers. Server keys only", "search", "Capability token, expiry and effective policy", jsonBody],
  ["/v1/runs/activity/stream", "get", "runs", "Stream account run activity over SSE", "ingest, search or artifacts", "Server-sent event stream"],
  ["/v1/runs/{runId}/events", "get", "runs", "List a run's events", "ingest, search or artifacts", "Run events"],
  ["/v1/runs/{runId}/events/stream", "get", "runs", "Stream a run's events over SSE", "ingest, search or artifacts", "Server-sent event stream"],
  ["/v1/documents", "get", "documents", "List documents with filters", "artifacts", "Documents"],
  ["/v1/documents/index", "get", "documents", "List the document index for a workspace", "artifacts", "Document index"],
  ["/v1/documents/{docId}", "get", "documents", "Get a document with its viewer payload", "artifacts", "Document"],
  ["/v1/files/{token}/{name}", "get", "documents", "Stream a document file or artifact through the authenticated file proxy. URLs come from document, artifact and export responses; each is bound to the key that received it and expires", "artifacts", "File bytes (Range supported)"],
  ["/v1/exports", "post", "documents", "Queue a zip export of one document (documentId) or a workspace's current documents (workspaceId: UUID, slug or default; omit both for the default workspace). content \"markdown\" (default) holds Markdown, per-page Markdown, structured data and metadata; \"all\" adds originals, page images and readable outputs. The worker builds it; poll GET /v1/exports/{exportId}. Exports over 250 MB are emailed when ready; over 3 GB are refused (413). Links last 7 days", "artifacts", "202 with the queued export", jsonBody],
  ["/v1/exports", "get", "documents", "List your recent exports", "artifacts", "{ exports }"],
  ["/v1/exports/{exportId}", "get", "documents", "Get an export's status, size and expiry; downloadUrl appears once it is ready", "artifacts", "{ export }"],
  ["/v1/exports/{exportId}/download", "get", "documents", "Check the export, then redirect (302) to a two-minute presigned storage link, so the zip downloads directly from storage. 404 once its 7 days have passed", "artifacts", "Redirect to the zip"],
  ["/v1/documents/{docId}/structured", "get", "documents", "Get a document's structured extraction output", "artifacts", "Structured output"],
  ["/v1/documents/{docId}/versions", "get", "documents", "List a document's versions and tags", "artifacts", "Document versions"],
  ["/v1/documents/{docId}/changelog", "get", "documents", "Get the changelog between document versions", "artifacts", "Version changelog"],
  ["/v1/documents/{docId}", "delete", "documents", "Delete a document. Server keys only; the key's user must be able to edit the workspace. 409 while a run is still processing it", "ingest", "Identities of the deleted document"],
  ["/v1/documents/{docId}/tags", "put", "documents", "Replace a document's tags. Server keys only", "ingest", "Document ID and tags", jsonBody],
  ["/v1/documents/bulk", "post", "documents", "Act on up to many documents at once: reprocess (new versions with each run's pipeline; spends credits), apply-tags, remove-tags, delete, or export-artifacts. Server keys only; export-artifacts needs artifacts instead of ingest. Every document must be in a workspace the key can use (404 otherwise, before any change)", "ingest", "Per-action result: runs, updated or deleted counts, or artifacts", jsonBody],
  ["/v1/workspaces/{workspaceId}/documents/bulk/estimate", "post", "documents", "What a bulk document action would cost, without starting it. Server keys only", "ingest", "{ estimate, billing }", jsonBody],
  ["/v1/runs/{runId}/reprocess", "post", "runs", "Re-run a run's documents as new versions, all stages or from stageFrom / only stages. Server keys only; spends credits. Use it to pick up extraction fixes for files whose bytes did not change (uploads of identical bytes reuse the earlier extraction)", "ingest", "The new run and its job", jsonBody],
  ["/v1/runs/{runId}/reprocess/estimate", "post", "runs", "What reprocessing a run would cost, without starting it. Server keys only", "ingest", "{ estimate, billing }", jsonBody],
  ["/v1/documents/{docId}/correction-workbench", "get", "documents", "Get the correction workbench for a document", "artifacts", "Correction workbench"],
  ["/v1/web/search", "post", "web", "Search the public web. Returns ranked URLs, titles and snippets (optionally page Markdown); charged web-search credits", "search", "Web results, cache flag and credits charged", jsonBody],
  ["/v1/web/fetch", "post", "web", "Read up to 10 public web pages as Markdown; charged per page read", "search", "Pages, unreadable URLs and credits charged", jsonBody],
  ["/v1/web/map", "post", "web", "List a website's URLs, optionally ranked by search text", "search", "Discovered URLs and credits charged", jsonBody],
  ["/v1/web/crawl", "post", "web", "Crawl a website (same site, bounded pages and depth) and return each page's Markdown without storing it", "search", "Crawled pages and credits charged", jsonBody],
  ["/v1/web/ingest", "post", "web", "Crawl a website and ingest each page as a Markdown document into a workspace", "ingest", "Workspace intake result with crawl summary", jsonBody],
  ["/v1/uploads/direct/sessions", "post", "ingest", "Start a direct-to-storage upload session", "ingest", "Upload session with presigned targets", jsonBody],
  ["/v1/uploads/direct/sessions/{sessionId}", "get", "ingest", "Get a direct upload session", "ingest", "Upload session"],
  ["/v1/uploads/direct/sessions/{sessionId}/files/complete", "post", "ingest", "Mark files in a direct upload session as uploaded", "ingest", "Files recorded", jsonBody],
  ["/v1/uploads/direct/sessions/{sessionId}/files/{fileId}/parts/sign", "post", "ingest", "Sign additional multipart upload parts", "ingest", "Presigned part URLs", jsonBody],
  ["/v1/uploads/direct/sessions/{sessionId}/abort", "post", "ingest", "Abort a direct upload session", "ingest", "Session aborted"],
  ["/v1/uploads/direct/sessions/{sessionId}/confirm", "post", "ingest", "Confirm a direct upload session and start its run", "ingest", "Run started"],
  ["/v1/artifacts/preview", "get", "artifacts", "Preview an artifact's content", "artifacts", "Artifact preview"],
  ["/v1/chat/stream", "get", "chat", "Stream a cited chat answer as server-sent events (for EventSource clients); POST /v1/chat takes the full request body", "chat", "Server-sent event stream"],
  ["/v1/search/aggregate", "post", "search", "Search several workspaces and merge the results", "search", "Aggregated results", jsonBody],
  ["/v1/search/{sessionId}/feedback", "post", "search", "Record click or relevance feedback for a search session", "search", "Feedback recorded", jsonBody],
  ["/v1/searches/{sessionId}/materialization", "get", "search", "Poll on-demand page materialization for a deferred-index search session", "search", "Candidate pages and their ledger state"],
  ["/v1/search/diagnostics", "get", "search", "Zero-result diagnostics for a search session in a workspace you can read", "search", "Diagnostics or null", {
    parameters: [{ in: "query", name: "sessionId", required: true, schema: { type: "string" } }],
  }],
];

export const apiKeySurfacePaths: Record<string, Partial<Record<Method, ReturnType<typeof operation>>>> = {};
for (const [path, method, tag, summary, scope, success, extra] of entries) {
  (apiKeySurfacePaths[path] ??= {})[method] = operation(path, tag, summary, scope, success, extra);
}

for (const [path, operations] of Object.entries(apiKeySurfacePaths)) {
  if (path.startsWith("/v1/uploads/")) {
    apiKeySurfacePaths[path.replace("/v1/uploads/", "/v1/ingest/")] = Object.fromEntries(
      Object.entries(operations).map(([method, operation]) => [method, {
        ...operation, deprecated: true, summary: `Deprecated alias; use ${method.toUpperCase()} ${path}`,
      }]),
    );
  }
}
