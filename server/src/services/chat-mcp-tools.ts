import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { CHAT_MAX_RETRIEVED_PASSAGES, searchResultSchema, type SearchResult, type WorkspaceSearchRetrievalDefaults } from "@docslurp/shared";
import type { McpDispatch, McpManifest } from "../lib/mcp-http.js";

export interface ChatToolActivity {
  id: string;
  name: string;
  status: "loading" | "success" | "error";
  runtimeMs?: number;
}

/**
 * Chat never exposes automation tools: ai.simple / ai.advanced fetch
 * arbitrary sourceUrls and start paid ingestion, and the model's arguments
 * can be steered by document text (G-04). ai.operation.get goes with them.
 */
const CHAT_EXCLUDED_TOOL_PREFIX = "ai.";

/** A turn owns its tool budget and citation numbering; no global user state. */
export function createChatMcpTools(args: {
  manifest: McpManifest;
  dispatch: McpDispatch;
  workspaceId: string;
  retrievalDefaults?: WorkspaceSearchRetrievalDefaults;
  signal: AbortSignal;
  onActivity?: (activity: ChatToolActivity) => void;
  onEvidence?: (citations: SearchResult[]) => void;
  /**
   * Privacy gate for workspaces other than the chat workspace. Tool results go
   * to a hosted model, so a workspace whose privacyMode forbids that is refused.
   */
  allowWorkspace?: (workspaceRef: string) => Promise<boolean>;
}) {
  const citations: SearchResult[] = [];
  const activity = new Map<string, ChatToolActivity>();
  let calls = 0;
  const tools: ToolSet = {};
  const defaults = args.retrievalDefaults;
  const limit = defaults ? Math.min(defaults.resultCount, CHAT_MAX_RETRIEVED_PASSAGES) : undefined;
  const searchDefaults = defaults ? {
    limit, hyde: defaults.useHyDE, rerank: defaults.useRerank, mmr: defaults.useMmr,
    compression: defaults.useContextualCompression, mmrLambda: defaults.mmrLambda,
    minScore: defaults.minScore, parentRetrieval: defaults.parentRetrieval,
    summarySeed: defaults.summarySeed, queryRewrite: defaults.queryRewrite,
    queryDecompose: defaults.queryDecompose, stepback: defaults.stepback,
    selfQuery: defaults.selfQuery, iterativeMultiHop: defaults.iterativeMultiHop,
    graphExpansion: defaults.enableGraphExpansion, communityExpansion: defaults.enableCommunityExpansion,
    graphHops: defaults.graphHops,
  } : {};
  const chatDefaults = defaults ? {
    resultCount: limit, useHyDE: defaults.useHyDE, useRerank: defaults.useRerank,
    useMmr: defaults.useMmr, mmrLambda: defaults.mmrLambda,
    iterativeMultiHop: defaults.iterativeMultiHop, enableGraphExpansion: defaults.enableGraphExpansion,
    enableCommunityExpansion: defaults.enableCommunityExpansion, graphHops: defaults.graphHops,
  } : undefined;

  function collectEvidence(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collectEvidence); return; }
    const parsed = searchResultSchema.safeParse(value);
    if (parsed.success) {
      const item = parsed.data;
      if (citations.length < 80 && !citations.some(c => c.citation.documentId === item.citation.documentId
        && c.citation.chunkIndex === item.citation.chunkIndex && c.text === item.text)) citations.push(item);
      return;
    }
    const object = value as Record<string, unknown>;
    for (const key of ["results", "citations", "data", "response", "operation"]) collectEvidence(object[key]);
  }

  for (const definition of args.manifest.capabilities.filter(item => item.category === "tool" && !item.id.startsWith(CHAT_EXCLUDED_TOOL_PREFIX))) {
    // OpenAI-compatible providers restrict function names to letters, numbers, _ and -.
    const name = definition.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (tools[name]) throw new Error("Duplicate model tool name");
    tools[name] = dynamicTool({
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema),
      execute: async (input, { toolCallId }) => {
        args.signal.throwIfAborted();
        if (++calls > 12) return { error: "Tool call limit reached. Summarize the results already obtained." };
        if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Expected object arguments" };
        const supplied = input as Record<string, unknown>;
        // G-04: the user-selected workspace is the only scope. It is applied
        // after the model's arguments, so a prompt-injected workspaceId can't
        // send a search into another workspace the user happens to reach.
        const body = definition.id === "workspace.search-many"
          ? { ...supplied, queries: Array.isArray(supplied.queries)
            ? supplied.queries.map(q => ({ ...(q && typeof q === "object" && !Array.isArray(q) ? q : {}), ...searchDefaults, workspaceId: args.workspaceId }))
            : supplied.queries }
          : definition.id === "workspace.aggregate-rag-search"
            ? { ...supplied, workspaceIds: [args.workspaceId] }
            : { ...supplied,
              ...(definition.id === "workspace.search" ? searchDefaults : {}),
              ...(definition.id === "workspace.chat" && chatDefaults ? { retrieval: chatDefaults } : {}),
              workspaceId: args.workspaceId };
        const started = Date.now();
        const update = (status: ChatToolActivity["status"]) => {
          const event: ChatToolActivity = { id: toolCallId, name: definition.id, status,
            ...(status !== "loading" ? { runtimeMs: Date.now() - started } : {}) };
          activity.set(toolCallId, event);
          args.onActivity?.(event);
        };
        update("loading");
        try {
          const response = await args.dispatch(`/tools/${encodeURIComponent(definition.id)}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: args.signal,
          });
          const result: unknown = await response.json();
          if (response.ok) {
            collectEvidence(result);
            args.onEvidence?.([...citations]);
          }
          update(response.ok ? "success" : "error");
          const serialized = JSON.stringify(result);
          return {
            ok: response.ok, status: response.status,
            result: serialized.length <= 40_000 ? result : { truncated: true, preview: serialized.slice(0, 40_000) },
            // Local citation numbers in a nested answer must not overwrite the outer turn's numbering.
            evidence: citations.map((citation, index) => ({ citationIndex: index + 1,
              filename: citation.citation.filename, documentId: citation.citation.documentId,
              pageNumber: citation.citation.pageNumber, text: citation.text.slice(0, 1500) })),
          };
        } catch {
          update("error");
          args.signal.throwIfAborted();
          return { error: "Tool execution failed. Do not assume the action succeeded or retry a submission automatically." };
        }
      },
    });
  }
  return { tools, citations, activity };
}
