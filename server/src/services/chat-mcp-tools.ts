import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { CHAT_AGENT_LIMIT_DEFAULTS, CHAT_MAX_RETRIEVED_PASSAGES, searchResultSchema, type SearchResult, type WorkspaceSearchRetrievalDefaults } from "@docslurp/shared";
import { startTelemetrySpan, type TelemetrySpan } from "@docslurp/shared/observability";
import type { McpDispatch, McpManifest } from "../lib/mcp-http.js";
import { runInChatAgentContext } from "../lib/chat-agent-context.js";

/** Tool result returned once the turn's tool-call budget is spent; `code` lets callers tell it apart. */
export const TOOL_CALL_LIMIT_RESULT = {
  error: "Tool call limit reached. Summarize the results already obtained.",
  code: "tool_call_limit",
  limitReached: true,
} as const;

/** Retrieval shape of one search tool call: counts and scores only, never passage text. */
export interface ChatSearchCallStats {
  toolCallId: string;
  ok: boolean;
  /** Retrieval queries: 1 for `q`, the batch size for `queries`. */
  queryCount: number;
  /** Parallelism used for a batch (1 for a single query). */
  concurrency: number;
  resultCount: number;
  topScore: number | null;
  documentCount: number;
  zeroHit: boolean;
  searchSessionIds: string[];
}

function searchCallStats(toolCallId: string, ok: boolean, queryCount: number, concurrency: number, result: unknown): ChatSearchCallStats {
  const responses: Array<{ results?: unknown; sessionId?: unknown }> = [];
  const body = result && typeof result === "object" ? result as { results?: unknown; sessionId?: unknown } : {};
  if (queryCount > 1 || (Array.isArray(body.results) && body.results.some(item => item && typeof item === "object" && "ok" in item))) {
    for (const item of Array.isArray(body.results) ? body.results : []) {
      const entry = item as { ok?: unknown; data?: { results?: unknown; sessionId?: unknown } };
      if (entry?.ok === true && entry.data) responses.push(entry.data);
    }
  } else if (ok) responses.push(body);
  const hits = responses.flatMap(response => Array.isArray(response.results) ? response.results as Array<{ score?: unknown; citation?: { documentId?: unknown } }> : []);
  const scores = hits.map(hit => hit?.score).filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  const documents = new Set(hits.map(hit => hit?.citation?.documentId).filter((id): id is string => typeof id === "string"));
  return {
    toolCallId, ok, queryCount, concurrency, resultCount: hits.length,
    topScore: scores.length ? Math.max(...scores) : null, documentCount: documents.size,
    zeroHit: ok && hits.length === 0,
    searchSessionIds: [...new Set(responses.map(response => response.sessionId).filter((id): id is string => typeof id === "string"))],
  };
}

export interface ChatToolActivity {
  id: string;
  name: string;
  status: "loading" | "success" | "error";
  runtimeMs?: number;
}

/**
 * Chat never exposes ingestion tools: upload fetches arbitrary URLs and starts
 * paid ingestion, and the model's arguments can be steered by document text (G-04).
 */
const CHAT_EXCLUDED_TOOLS = new Set(["upload", "completeUpload", "listWorkspaces"]);

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
  /** Tool calls allowed in this turn (default 12); later calls get TOOL_CALL_LIMIT_RESULT. */
  maxToolCalls?: number;
  /** Ceiling for a search batch's `concurrency`; also its value when the model omits it (default 4). */
  searchConcurrency?: number;
  /** Chat session that owns this turn; retrieval spans and search sessions link back to it. */
  chatSessionId?: string;
  /** Parent for the `execute_tool` spans (the agent span). */
  traceParent?: TelemetrySpan;
}) {
  const citations: SearchResult[] = [];
  const activity = new Map<string, ChatToolActivity>();
  const searchCalls: ChatSearchCallStats[] = [];
  const maxToolCalls = args.maxToolCalls ?? CHAT_AGENT_LIMIT_DEFAULTS.maxToolCalls;
  const searchConcurrency = args.searchConcurrency ?? CHAT_AGENT_LIMIT_DEFAULTS.searchConcurrency;
  const counters = { executed: 0, refused: 0, byTool: {} as Record<string, number> };
  let calls = 0;
  const tools: ToolSet = {};
  const defaults = args.retrievalDefaults;
  const limit = defaults ? Math.min(defaults.resultCount, CHAT_MAX_RETRIEVED_PASSAGES) : undefined;
  const searchDefaults = defaults ? {
    limit, hyde: defaults.useHyDE, rerank: defaults.useRerank, mmr: defaults.useMmr,
    candidateDepth: defaults.candidateDepth, resultOrder: defaults.resultOrder,
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
    candidateDepth: defaults.candidateDepth, resultOrder: defaults.resultOrder,
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
    for (const key of ["results", "citations", "data", "response"]) collectEvidence(object[key]);
  }

  for (const definition of args.manifest.capabilities.filter(item => item.category === "tool" && !CHAT_EXCLUDED_TOOLS.has(item.id))) {
    // OpenAI-compatible providers restrict function names to letters, numbers, _ and -.
    const name = definition.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (tools[name]) throw new Error("Duplicate model tool name");
    tools[name] = dynamicTool({
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema),
      execute: async (input, { toolCallId }) => {
        args.signal.throwIfAborted();
        const span = startTelemetrySpan("docslurp.chat", `execute_tool ${definition.id}`, {
          "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": definition.id,
          "gen_ai.tool.call.id": toolCallId, "gen_ai.tool.type": "function",
          ...(args.chatSessionId ? { "docslurp.chat.session_id": args.chatSessionId } : {}),
          "docslurp.workspaceId": args.workspaceId,
        }, { parent: args.traceParent });
        if (++calls > maxToolCalls) {
          counters.refused++;
          span.set({ "docslurp.chat.tool_call_refused": true });
          span.end("tool_call_limit");
          return { ...TOOL_CALL_LIMIT_RESULT };
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          span.end("invalid_arguments");
          return { error: "Expected object arguments" };
        }
        counters.executed++;
        counters.byTool[definition.id] = (counters.byTool[definition.id] ?? 0) + 1;
        const supplied = input as Record<string, unknown>;
        const batch = definition.id === "search" && Array.isArray(supplied.queries);
        const queryCount = batch ? (supplied.queries as unknown[]).length : 1;
        // The turn's concurrency is the ceiling, and the value when the model omits it.
        const concurrency = batch
          ? typeof supplied.concurrency === "number" && Number.isFinite(supplied.concurrency)
            ? Math.max(1, Math.min(Math.trunc(supplied.concurrency), searchConcurrency))
            : searchConcurrency
          : 1;
        // G-04: the user-selected workspace is the only scope. It is applied
        // after the model's arguments, so a prompt-injected workspaceId can't
        // send a search into another workspace the user happens to reach.
        // Workspace retrieval controls (including this request's overrides) are
        // also applied after the model's arguments so a tool call cannot widen them.
        const body = definition.id === "search"
          ? Array.isArray(supplied.queries)
            ? { ...supplied, concurrency, queries: supplied.queries.map(q => ({ ...(q && typeof q === "object" && !Array.isArray(q) ? q : {}), ...searchDefaults, workspaceId: args.workspaceId })) }
            : { ...supplied, ...searchDefaults, workspaceId: args.workspaceId }
          : definition.id === "chat" && chatDefaults
            ? { ...supplied, retrieval: chatDefaults, workspaceId: args.workspaceId }
            : { ...supplied, workspaceId: args.workspaceId };
        const started = Date.now();
        const update = (status: ChatToolActivity["status"]) => {
          const event: ChatToolActivity = { id: toolCallId, name: definition.id, status,
            ...(status !== "loading" ? { runtimeMs: Date.now() - started } : {}) };
          activity.set(toolCallId, event);
          args.onActivity?.(event);
        };
        update("loading");
        try {
          const dispatch = () => span.run(() => args.dispatch(`/tools/${encodeURIComponent(definition.id)}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: args.signal,
          }));
          const response = await (args.chatSessionId ? runInChatAgentContext(args.chatSessionId, dispatch) : dispatch());
          const result: unknown = await response.json();
          if (response.ok) {
            collectEvidence(result);
            args.onEvidence?.([...citations]);
          }
          update(response.ok ? "success" : "error");
          if (definition.id === "search") {
            const stats = searchCallStats(toolCallId, response.ok, queryCount, concurrency, result);
            searchCalls.push(stats);
            span.set({
              "docslurp.rag.query_count": stats.queryCount, "docslurp.rag.concurrency": stats.concurrency,
              "docslurp.rag.result_count": stats.resultCount, "docslurp.rag.zero_hit": stats.zeroHit,
              "docslurp.rag.document_count": stats.documentCount,
              ...(stats.topScore !== null ? { "docslurp.rag.top_score": stats.topScore } : {}),
              ...(stats.searchSessionIds.length ? { "docslurp.rag.search_session_id": stats.searchSessionIds.length === 1 ? stats.searchSessionIds[0]! : stats.searchSessionIds } : {}),
            });
          }
          span.set({ "docslurp.tool.status_code": response.status });
          span.end(response.ok ? undefined : `http_${response.status}`);
          const serialized = JSON.stringify(result);
          return {
            ok: response.ok, status: response.status,
            result: serialized.length <= 40_000 ? result : { truncated: true, preview: serialized.slice(0, 40_000) },
            // Local citation numbers in a nested answer must not overwrite the outer turn's numbering.
            evidence: citations.map((citation, index) => ({ citationIndex: index + 1,
              filename: citation.citation.filename, documentId: citation.citation.documentId,
              pageNumber: citation.citation.pageNumber, text: citation.text.slice(0, 1500) })),
          };
        } catch (error) {
          update("error");
          if (definition.id === "search") searchCalls.push(searchCallStats(toolCallId, false, queryCount, concurrency, null));
          span.end(error ?? "Error");
          args.signal.throwIfAborted();
          return { error: "Tool execution failed. Do not assume the action succeeded or retry a submission automatically." };
        }
      },
    });
  }
  return { tools, citations, activity, searchCalls, counters };
}
