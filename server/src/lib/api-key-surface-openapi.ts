/**
 * OpenAPI entries for API-key routes that had no documentation of their own
 * (document reads, direct uploads, AI operations, run events and search
 * helpers). Document writes stay session-only: the documents router rejects
 * non-GET API key requests.
 * `route-auth-integration.test.ts` requires the bearerAuth operations in the
 * OpenAPI document to match the routes declared with `acceptApiKeys` exactly.
 */
export const keyOrSessionSecurity = [{ bearerAuth: [] }, { sessionAuth: [] }];
/** /v1/ai/* answers API keys only. */
export const keyOnlySecurity = [{ bearerAuth: [] }];

type Method = "get" | "post" | "put" | "patch" | "delete";

const errors = {
  "400": { description: "Invalid request" },
  "401": { description: "Authentication required" },
  "403": { description: "Key scope, key type, workspace allowlist or browser domain denied" },
  "404": { description: "Resource not found in your organization" },
  "429": { description: "Rate limit reached" },
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
  ["/v1/ai/usage", "get", "ai", "Automation usage for the key's organization", "API key", "Usage totals", { security: keyOnlySecurity }],
  ["/v1/ai/operations/{id}/approve", "post", "ai", "Approve a durable automation operation waiting for confirmation", "API key", "Operation approved", { security: keyOnlySecurity }],
  ["/v1/runs/activity/stream", "get", "runs", "Stream account run activity over SSE", "ingest, search or artifacts", "Server-sent event stream"],
  ["/v1/runs/{runId}/events", "get", "runs", "List a run's events", "ingest, search or artifacts", "Run events"],
  ["/v1/runs/{runId}/events/stream", "get", "runs", "Stream a run's events over SSE", "ingest, search or artifacts", "Server-sent event stream"],
  ["/v1/documents", "get", "documents", "List documents with filters", "artifacts", "Documents"],
  ["/v1/documents/index", "get", "documents", "List the document index for a workspace", "artifacts", "Document index"],
  ["/v1/documents/review-queue", "get", "documents", "List low-confidence documents waiting for review", "artifacts", "Review queue"],
  ["/v1/documents/{docId}", "get", "documents", "Get a document with its viewer payload", "artifacts", "Document"],
  ["/v1/files/{token}/{name}", "get", "documents", "Stream a document file or artifact through the authenticated file proxy. URLs come from document, artifact and export responses; each is bound to the key that received it and expires", "artifacts", "File bytes (Range supported)"],
  ["/v1/documents/{docId}/structured", "get", "documents", "Get a document's structured extraction output", "artifacts", "Structured output"],
  ["/v1/documents/{docId}/versions", "get", "documents", "List a document's versions and tags", "artifacts", "Document versions"],
  ["/v1/documents/{docId}/changelog", "get", "documents", "Get the changelog between document versions", "artifacts", "Version changelog"],
  ["/v1/documents/{docId}/correction-workbench", "get", "documents", "Get the correction workbench for a document", "artifacts", "Correction workbench"],
  ["/v1/uploads/direct/sessions", "post", "ingest", "Start a direct-to-storage upload session", "ingest", "Upload session with presigned targets", jsonBody],
  ["/v1/uploads/direct/sessions/{sessionId}", "get", "ingest", "Get a direct upload session", "ingest", "Upload session"],
  ["/v1/uploads/direct/sessions/{sessionId}/files/complete", "post", "ingest", "Mark files in a direct upload session as uploaded", "ingest", "Files recorded", jsonBody],
  ["/v1/uploads/direct/sessions/{sessionId}/abort", "post", "ingest", "Abort a direct upload session", "ingest", "Session aborted"],
  ["/v1/uploads/direct/sessions/{sessionId}/confirm", "post", "ingest", "Confirm a direct upload session and start its run", "ingest", "Run started"],
  ["/v1/artifacts/preview", "get", "artifacts", "Preview an artifact's content", "artifacts", "Artifact preview"],
  ["/v1/search/chat/stream", "get", "search", "Legacy chat stream; use POST /v1/chat/completions with stream: true", "search", "Server-sent event stream", { deprecated: true }],
  ["/v1/search/aggregate", "post", "search", "Search several workspaces and merge the results", "search", "Aggregated results", jsonBody],
  ["/v1/search/{sessionId}/feedback", "post", "search", "Record click or relevance feedback for a search session", "search", "Feedback recorded", jsonBody],
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
