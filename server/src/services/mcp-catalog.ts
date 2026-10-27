import { workspaceSettingsProposalInputSchema } from "./workspace-settings-proposal-input.js";
import { z } from "zod";

import { deferredProfilesEnabled } from "@docslurp/shared";

import { env } from "../config.js";
import { batchSearchInputSchema, searchInputSchema, workspaceChatInputSchema } from "../lib/search-input.js";
import { toolInputJsonSchema } from "./mcp-tool-schemas.js";
import { webMcpTools } from "./web/mcp-web-tools.js";
import { apiKeyMayUseEstimateTool, estimateToolDefinitions, jobsGetInputSchema, jobsGetToolDefinition, type EstimateToolName } from "./mcp-estimate-catalog.js";

export { jobsGetInputSchema };

export const workspaceRef = z.string().min(1).max(256).optional().describe('Workspace ID, slug or name (names match by slug, so "Legal Contracts" finds legal-contracts). Omit for the organization default workspace.');
export const listWorkspacesInput = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
}).strict();
/**
 * Inline uploads carry file bytes in the tool call, for MCP clients whose
 * sandbox cannot reach storage upload URLs. The total must fit the 1 MiB MCP
 * request body after base64 expansion.
 */
export const INLINE_UPLOAD_MAX_BYTES = 512 * 1024;
const INLINE_UPLOAD_MAX_BASE64_CHARS = Math.ceil(INLINE_UPLOAD_MAX_BYTES / 3) * 4 + 1024;
export const uploadInput = z.object({
  workspace: z.string().min(1).max(256).optional().describe('Workspace ID, slug or name. A name that matches no workspace creates one with that name, so only pass a new name when the user asks for a new workspace. Omit for the organization default workspace.'),
  urls: z.array(z.url().refine(url => /^https?:\/\//i.test(url), "Use HTTP or HTTPS URLs")).min(1).max(20).optional(),
  files: z.array(z.object({
    filename: z.string().min(1).max(512),
    sizeBytes: z.number().int().positive().max(5 * 1024 ** 3),
    mimeType: z.string().min(1).max(256).describe("Content-Type to send with the signed PUT request."),
  }).strict()).min(1).max(10).optional(),
  inlineFiles: z.array(z.object({
    filename: z.string().min(1).max(512).describe("File name with extension; the extension sets the type when mimeType is omitted."),
    mimeType: z.string().min(1).max(256).optional(),
    contentBase64: z.string().min(1).max(INLINE_UPLOAD_MAX_BASE64_CHARS).optional().describe("File bytes as base64. Use for binary files such as PDFs and images."),
    text: z.string().min(1).max(INLINE_UPLOAD_MAX_BYTES).optional().describe("UTF-8 file contents. Use instead of contentBase64 for Markdown, text, CSV, JSON or HTML."),
  }).strict().refine(file => Boolean(file.contentBase64) !== Boolean(file.text), "Supply either contentBase64 or text for each inline file")).min(1).max(10).optional()
    .describe(`Small files sent in this call (at most ${INLINE_UPLOAD_MAX_BYTES / 1024} KiB in total) when you cannot make HTTP requests to storage upload URLs.`),
  idempotencyKey: z.string().min(1).max(200).optional().describe("For URL and inline uploads: reuse the same key when retrying this exact request to avoid duplicate ingestion."),
}).strict().refine(value => [value.urls, value.files, value.inlineFiles].filter(Boolean).length === 1, "Supply exactly one of urls, files or inlineFiles");

export const completeUploadInput = z.object({
  sessionId: z.string().uuid(),
  fileIds: z.array(z.string().uuid()).min(1).max(10).refine(ids => new Set(ids).size === ids.length, "File IDs must be unique").describe("IDs returned by upload, after every corresponding PUT succeeds."),
}).strict();

export const uploadStatusInput = z.object({
  sessionId: z.string().uuid().optional().describe("Upload session returned by upload; use this to follow storage upload and automatic ingestion handoff."),
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

export type McpScope = "search" | "chat" | "ingest";
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
  keyAccess?: (key: { scopes: readonly string[]; keyType?: string; oauth?: { audience: string } }) => boolean;
  annotations: ToolAnnotations;
}

/**
 * Listing order for every surface that keeps server order (tools/list, manifest, chat tools): discover → upload →
 * search → chat, then settings, web, cost estimates and legacy fallbacks. Ids not listed keep their place at the end.
 * Some clients (Claude.ai connector settings) re-sort by id, so titles must read well in any order: sentence case,
 * verb first, and the same verb for the same kind of tool (List, Upload, Check, Search, Read, Estimate … cost).
 */
const TOOL_ORDER = [
  "listWorkspaces", "upload", "getUploadStatus", "search", "chat", "getMediaEvidence", "suggestQueries",
  "getWorkspaceSettings", "proposeWorkspaceSettings", "fullIndex",
  "webSearch", "webFetch", "webMap", "webCrawl", "ingestWebsite",
  "uploadEstimate", "fullIndexEstimate", "reprocessEstimate", "updateEstimate", "searchSettingsEstimate", "indexingModeEstimate", "graphRebuildEstimate",
  "getJob", "completeUpload",
];
const toolRank = (id: string) => { const rank = TOOL_ORDER.indexOf(id); return rank < 0 ? TOOL_ORDER.length : rank; };

/** The public MCP catalog, in TOOL_ORDER. Tool ids are the public names. */
export function mcpTools(baseUrl: string): McpTool[] {
  const estimates: Omit<McpTool, "category" | "endpoint">[] = estimateToolDefinitions.map(({ name, title, description, inputSchema }) => ({
    id: name, title, description, inputSchema, scopes: ["search", "ingest"],
    keyAccess: (key) => apiKeyMayUseEstimateTool(name as EstimateToolName, key),
    annotations: READ_ONLY,
  }));
  const tools: Omit<McpTool, "category" | "endpoint">[] = [
    { id: "getWorkspaceSettings", title: "Read workspace settings", scopes: ["search", "ingest"], annotations: READ_ONLY,
      description: "Read current supported pipeline toggles, chat settings and retrieval defaults for the selected workspace. Use before proposing changes and to verify what is actually saved after the user applies a proposal. Does not expose secrets or change settings.",
      inputSchema: toolInputJsonSchema(z.object({ workspace: workspaceRef }).strict()) },
    { id: "proposeWorkspaceSettings", title: "Propose workspace settings", scopes: ["search", "ingest"],
      keyAccess: key => key.keyType === "server" && key.scopes.includes("workspaces:manage"), annotations: READ_ONLY,
      description: "Prepare an exact workspace-settings change and impact for the signed-in chat's Apply card. Does not save settings or start work. Requires workspace editor access. Call proactively when configuration would help the user's goal, including enabling video frames. Safe chat changes (changes.chat): enabled, mode, answerStyle, citations, searchInstructions. Safe retrieval changes (changes.retrieval): resultCount, useRerank, useMmr, mmrLambda, candidateDepth, resultOrder. Allowed pipeline toggles: mediaVideo.enabled, chunkOverlap, summarize, embed, indexVectors, preserveTables, preserveCode, preserveImages, pdfRegionExtraction, visionFallback, and vision page selection (vision.forceAllPages reads every page with vision up to vision.maxPagesPerDocument, at most 32; it adds per-page cost and applies to new uploads, while existing files need reprocessing). Example: {changes:{pipeline:{mediaVideo:{enabled:true}}}}. An ingest report recommendation that has a patch can be proposed as {changes:{pipeline:<patch>}}. The user applies the structured card; never claim the proposal has been applied. Existing-document reprocessing requires separate explicit consent. Available inside a workspace chat session only.",
      inputSchema: toolInputJsonSchema(workspaceSettingsProposalInputSchema) },
    { id: "listWorkspaces", title: "List workspaces", scopes: ["search", "ingest"], annotations: READ_ONLY,
      description: "List workspaces you can access, including their IDs, slugs, default workspace, document/page counts and latest processing status. Pass a returned slug (or the name) as workspace in upload, search or chat. Does not call AI.",
      inputSchema: toolInputJsonSchema(listWorkspacesInput) },
    { id: "upload", title: "Upload documents", scopes: ["ingest"],
      annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: true, consequential: true },
      description: `Upload documents using exactly one of urls, files or inlineFiles. urls: DocSlurp's server downloads each HTTP(S) file directly, so prefer it for a file that is already public; do not fetch it with web tools first. files: return direct storage upload targets for up to 10 files (5 GiB each, subject to account limits). Small files use putUrl with the declared Content-Type; large files use multipart pendingParts URLs with byte slices determined by partNumber, partSize and sizeBytes. Upload every part. Storage notifications and background reconciliation automatically complete known-size uploads and start ingestion; no completeUpload call is needed. Follow getUploadStatus with sessionId. inlineFiles: if you cannot make HTTP requests to the upload URLs (for example a sandbox firewall blocks them), send small files in this call as text or contentBase64, ${INLINE_UPLOAD_MAX_BYTES / 1024} KiB in total; ingestion starts immediately and the response has workspace and run IDs for getUploadStatus. Never send local paths. Omit workspace for the default workspace; a name that matches no workspace creates it. Ingestion can incur cost. idempotencyKey applies to URL and inline upload retries.`,
      // Flat like every tool schema: uploadInput's refinement enforces exactly one of urls, files or inlineFiles.
      inputSchema: toolInputJsonSchema(uploadInput) },
    { id: "completeUpload", title: "Complete upload (legacy)", scopes: ["ingest"],
      annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false, consequential: true },
      description: "Legacy fallback for single-PUT sessions: verify uploaded files and start ingestion after every PUT succeeds. Normal uploads complete automatically; use getUploadStatus with sessionId instead. Pass sessionId and fileIds from upload. Do not use for multipart uploads.",
      inputSchema: toolInputJsonSchema(completeUploadInput) },
    { id: "search", title: "Search documents", scopes: ["search"], annotations: READ_ONLY,
      description: "Retrieve cited passages for one query (q) or up to 20 independent queries (queries). Supply exactly one form: q with top-level options, or queries (each item has its own q and options) with optional concurrency; a call with both is rejected. Batch results stay in input order with per-query errors; each query can select a workspace; concurrency (1-8, default 4) bounds parallel retrieval. Omitted workspace uses the default. Does not generate answers.",
      inputSchema: searchToolInputSchema() },
    { id: "chat", title: "Chat with workspace", scopes: ["chat"],
      annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false, consequential: false },
      description: "Generate a grounded answer with citations and token usage using the workspace's configured model. This calls AI and can incur cost; use search for your own LLM.",
      inputSchema: toolInputJsonSchema(workspaceChatInputSchema.omit({ agent: true })) },
    ...webMcpTools(),
    { id: "getUploadStatus", title: "Check upload status", scopes: ["search", "ingest"], annotations: READ_ONLY,
      description: "Pass sessionId from upload to check file upload state and retrieve the automatic ingestion result containing workspace and run IDs. Then check ingestion progress with workspace and optional runId. Reports searchable pages, failures, costs and processing speed without AI calls. Use before search or chat when files are still processing.",
      inputSchema: toolInputJsonSchema(uploadStatusInput) },
    { id: "getMediaEvidence", title: "Read video and audio transcripts", scopes: ["search"], annotations: READ_ONLY,
      description: "Read an indexed video or audio document's extracted transcript, timestamped frame descriptions and media summary. Use a documentId from getUploadStatus or search. Returns cited text and nextOffset for bounded continuation; does not run new AI or play raw video. Use this before claiming you cannot inspect an uploaded video. One logical page can contain many sampled frames.",
      inputSchema: toolInputJsonSchema(mediaEvidenceInput) },
    { id: "suggestQueries", title: "Suggest search queries", scopes: ["search"], annotations: READ_ONLY,
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
  return tools
    .sort((a, b) => toolRank(a.id) - toolRank(b.id))
    .map(tool => ({ ...tool, category: "tool", endpoint: `${baseUrl}/v1/mcp/tools/${tool.id}` }));
}

/**
 * The catalog visible to a caller: session callers see everything, API keys see tools their scopes allow.
 * `oauth` is the key's OAuth marker: a CLI (REST-audience) token sees web tools only with the `web` scope.
 */
export function mcpManifest(baseUrl: string, scopes?: string[], keyType?: string, oauth?: { audience: string }) {
  return {
    server: {
      id: env.mcpServerId, title: "DocSlurp MCP", version: "0.1.0",
      transports: ["streamable-http", "stdio"], endpoint: `${baseUrl}/v1/mcp`,
      auth: { type: "apiKey", scopes: ["search", "ingest"] },
    },
    capabilities: mcpTools(baseUrl).filter(tool => !scopes || (tool.keyAccess ? tool.keyAccess({ scopes, keyType, oauth }) : tool.scopes.some(scope => scopes.includes(scope)))),
  };
}
