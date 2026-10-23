import { z } from "zod";

import { deferredProfilesEnabled } from "@docslurp/shared";

import { env } from "../config.js";
import { batchSearchInputSchema, searchInputSchema, workspaceChatInputSchema } from "../lib/search-input.js";
import { toolInputJsonSchema } from "./mcp-tool-schemas.js";
import { apiKeyMayUseEstimateTool, estimateToolDefinitions, jobsGetInputSchema, jobsGetToolDefinition, type EstimateToolName } from "./mcp-estimate-catalog.js";

export { jobsGetInputSchema };

export const workspaceRef = z.string().min(1).max(256).optional().describe('Workspace ID, slug or name (names match by slug, so "Legal Contracts" finds legal-contracts). Omit for the organization default workspace.');
export const listWorkspacesInput = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
}).strict();
export const uploadInput = z.object({
  workspace: z.string().min(1).max(256).optional().describe('Workspace ID, slug or name. A name that matches no workspace creates one with that name, so only pass a new name when the user asks for a new workspace. Omit for the organization default workspace.'),
  urls: z.array(z.url().refine(url => /^https?:\/\//i.test(url), "Use HTTP or HTTPS URLs")).min(1).max(20).optional(),
  files: z.array(z.object({
    filename: z.string().min(1).max(512),
    sizeBytes: z.number().int().positive().max(5 * 1024 ** 3),
    mimeType: z.string().min(1).max(256).describe("Content-Type to send with the signed PUT request."),
  }).strict()).min(1).max(10).optional(),
  idempotencyKey: z.string().min(1).max(200).optional().describe("For URL ingestion only: reuse the same key when retrying this exact request to avoid duplicate ingestion."),
}).strict().refine(value => Boolean(value.urls) !== Boolean(value.files), "Supply either urls or files, not both");

export const openUploaderInput = z.object({
  workspace: workspaceRef,
}).strict();

export const completeUploadInput = z.object({
  sessionId: z.string().uuid(),
  fileIds: z.array(z.string().uuid()).min(1).max(10).refine(ids => new Set(ids).size === ids.length, "File IDs must be unique").describe("IDs returned by upload, after every corresponding PUT succeeds."),
}).strict();

export const uploadStatusInput = z.object({
  workspace: workspaceRef,
  runId: z.string().trim().min(1).max(128).optional(),
  documentIds: z.array(z.string().min(1).max(128)).max(100).optional(),
}).strict();
export const mediaEvidenceInput = z.object({
  workspace: workspaceRef,
  documentId: z.string().min(1).max(128),
  offset: z.number().int().min(0).max(10_000_000).default(0).describe("Character offset from nextOffset; omit for the beginning."),
}).strict();
export const fullIndexInput = z.object({
  workspace: workspaceRef,
  documentIds: z.array(z.string().min(1)).max(500).optional().describe("Only these documents; omit to index every remaining page in the workspace."),
}).strict();
export const suggestQueriesInput = z.object({
  workspace: workspaceRef,
  q: z.string().max(10_000).optional(),
  limit: z.number().int().min(1).max(25).optional(),
});

/**
 * The search tool accepts one query (`q` plus its options) or a batch
 * (`queries` plus `concurrency`), both defined by the search route's own zod
 * schemas. The advertised schema is the flat union of their properties with
 * no top-level oneOf/anyOf/allOf/not: Anthropic (direct, Bedrock, Vertex) rejects
 * those combinators at the top level of a tool input schema, which broke the chat
 * agent and any MCP client that forwards tools to Claude. The search route
 * enforces q XOR queries and answers a mixed call with a recoverable 400.
 */
function searchToolInputSchema() {
  const single = toolInputJsonSchema(searchInputSchema) as { properties: Record<string, Record<string, unknown>> };
  const { properties: batch } = toolInputJsonSchema(batchSearchInputSchema) as { properties: Record<string, Record<string, unknown>> };
  return {
    type: "object", additionalProperties: false,
    properties: {
      ...single.properties,
      q: { ...single.properties.q, description: "One search query. Send either q (with the other top-level options) or queries, never both." },
      queries: { ...batch.queries, description: "Batch form: up to 20 independent queries, each an object with its own q and options. Use instead of q; only concurrency may accompany it." },
      concurrency: { ...batch.concurrency, description: "Batch form only: parallel retrievals for queries (1-8, default 4)." },
    },
  };
}

export type McpScope = "search" | "ingest";
// Agent-safety hints live with the tool definition so every surface (remote MCP,
// stdio, chat tools, WebMCP) reads the same values instead of inferring them per surface.
// `consequential` (WebMCP's consequentialHint) marks calls a person should confirm:
// they start paid ingestion of new content.
export type ToolAnnotations = { readOnly: boolean; destructive: boolean; idempotent: boolean; openWorld: boolean; consequential: boolean };
const READ_ONLY: ToolAnnotations = { readOnly: true, destructive: false, idempotent: true, openWorld: false, consequential: false };

export interface McpTool {
  id: string;
  title: string;
  description: string;
  category: "tool";
  endpoint: string;
  inputSchema: Record<string, unknown>;
  /** An API key needs at least one of these scopes to see or call the tool. */
  scopes: McpScope[];
  /** Replaces the `scopes` check for API keys (scope and key type): estimates mirror the access of the mutation they price. */
  keyAccess?: (key: { scopes: readonly string[]; keyType?: string }) => boolean;
  annotations: ToolAnnotations;
}

/** The public MCP catalog, in the product's upload → search → chat order. Tool ids are the public names. */
export function mcpTools(baseUrl: string): McpTool[] {
  const estimates: Omit<McpTool, "category" | "endpoint">[] = estimateToolDefinitions.map(({ name, title, description, inputSchema }) => ({
    id: name, title, description, inputSchema, scopes: ["search", "ingest"],
    keyAccess: (key) => apiKeyMayUseEstimateTool(name as EstimateToolName, key),
    annotations: READ_ONLY,
  }));
  const tools: Omit<McpTool, "category" | "endpoint">[] = [
    { id: "listWorkspaces", title: "List workspaces", scopes: ["search", "ingest"], annotations: READ_ONLY,
      description: "List workspaces you can access, including their IDs, slugs, default workspace, document/page counts and latest processing status. Pass a returned slug (or the name) as workspace in upload, search or chat. Does not call AI.",
      inputSchema: toolInputJsonSchema(listWorkspacesInput) },
    { id: "upload", title: "Upload documents", scopes: ["ingest"],
      annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true, consequential: true },
      description: "Upload documents using either fetchable HTTP(S) urls or files metadata, never both. For files, generate one presigned PUT URL per file, up to 10 files (5 GiB each, subject to account limits). PUT the raw bytes to each putUrl with the declared Content-Type, then call completeUpload with sessionId and file IDs. Never send file bytes or local paths as tool arguments. URLs start ingestion immediately; files start only on completion. Omit workspace for the default workspace; workspace takes an ID, slug or name, and a name that matches no workspace creates it. Ingestion can incur cost. idempotencyKey applies to URL ingestion retries.",
      // Flat like every tool schema: uploadInput's refinement enforces urls XOR files.
      inputSchema: toolInputJsonSchema(uploadInput) },
    ...(env.mcpAppsUiEnabled ? [{ id: "openUploader", title: "Open uploader", scopes: ["ingest" as const], annotations: READ_ONLY,
      description: "Show an upload widget so the user can drop local files you cannot read. Returns the target workspace and limits only; the widget uploads and reports progress itself. Never creates a workspace: omit workspace for the default. Hosts without MCP Apps support: use upload with urls instead.",
      inputSchema: toolInputJsonSchema(openUploaderInput) }] : []),
    { id: "completeUpload", title: "Complete upload", scopes: ["ingest"],
      annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false, consequential: true },
      description: "After all presigned PUT requests succeed, verify uploaded files and start ingestion. Pass sessionId and fileIds from upload. Returns workspace and run IDs for getUploadStatus. File size is verified before ingestion; do not call before uploading the bytes.",
      inputSchema: toolInputJsonSchema(completeUploadInput) },
    { id: "search", title: "Search documents", scopes: ["search"], annotations: READ_ONLY,
      description: "Retrieve cited passages for one query (q) or up to 20 independent queries (queries). Supply exactly one form: q with top-level options, or queries (each item has its own q and options) with optional concurrency; a call with both is rejected. Batch results stay in input order with per-query errors; each query can select a workspace; concurrency (1-8, default 4) bounds parallel retrieval. Omitted workspace uses the default. Does not generate answers.",
      inputSchema: searchToolInputSchema() },
    { id: "chat", title: "Chat with workspace", scopes: ["search"],
      annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false, consequential: false },
      description: "Generate a grounded answer with citations and token usage using the workspace's configured model. This calls AI and can incur cost; use search for your own LLM.",
      inputSchema: toolInputJsonSchema(workspaceChatInputSchema.omit({ agent: true })) },
    { id: "getUploadStatus", title: "Get upload status", scopes: ["search", "ingest"], annotations: READ_ONLY,
      description: "Check uploaded files and ingestion progress in a workspace, optionally for a runId returned by upload. Reports searchable pages, failures, costs and processing speed without AI calls. Use before search or chat when files are still processing.",
      inputSchema: toolInputJsonSchema(uploadStatusInput) },
    { id: "getMediaEvidence", title: "Read video and audio evidence", scopes: ["search"], annotations: READ_ONLY,
      description: "Read an indexed video or audio document's extracted transcript, timestamped frame descriptions and media summary. Use a documentId from getUploadStatus or search. Returns cited text and nextOffset for bounded continuation; does not run new AI or play raw video. Use this before claiming you cannot inspect an uploaded video. One logical page can contain many sampled frames.",
      inputSchema: toolInputJsonSchema(mediaEvidenceInput) },
    { id: "suggestQueries", title: "Suggest queries", scopes: ["search"], annotations: READ_ONLY,
      description: "Read prior queries and suggestions without AI calls.",
      inputSchema: toolInputJsonSchema(suggestQueriesInput) },
    ...(deferredProfilesEnabled() ? [{ id: "fullIndex", title: "Index workspace fully", scopes: ["ingest" as const],
      annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false, consequential: true },
      description: "Parse and index every remaining page of a deferred (map/visual) workspace, or of the listed documents, in the background. Spends credits and is refused unless the key or capability policy allows full-index requests.",
      inputSchema: toolInputJsonSchema(fullIndexInput) }] : []),
    ...estimates,
    { id: jobsGetToolDefinition.id, title: jobsGetToolDefinition.title, description: jobsGetToolDefinition.description,
      inputSchema: jobsGetToolDefinition.inputSchema, scopes: ["search", "ingest"], annotations: READ_ONLY },
  ];
  return tools.map(tool => ({ ...tool, category: "tool", endpoint: `${baseUrl}/v1/mcp/tools/${tool.id}` }));
}

/** The catalog visible to a caller: session callers see everything, API keys see tools their scopes allow. */
export function mcpManifest(baseUrl: string, scopes?: string[], keyType?: string) {
  return {
    server: {
      id: env.mcpServerId, title: "DocSlurp MCP", version: "0.1.0",
      transports: ["streamable-http", "stdio"], endpoint: `${baseUrl}/v1/mcp`,
      auth: { type: "apiKey", scopes: ["search", "ingest"] },
    },
    capabilities: mcpTools(baseUrl).filter(tool => !scopes || (tool.keyAccess ? tool.keyAccess({ scopes, keyType }) : tool.scopes.some(scope => scopes.includes(scope)))),
  };
}
