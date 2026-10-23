import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { CHAT_AGENT_LIMIT_DEFAULTS, CHAT_MAX_RETRIEVED_PASSAGES, searchResultSchema, type SearchResult, type WorkspaceSearchRetrievalDefaults } from "@docslurp/shared";
import { startTelemetrySpan, type TelemetrySpan } from "@docslurp/shared/observability";
import type { McpDispatch, McpManifest } from "../lib/mcp-http.js";
import { runInChatAgentContext } from "../lib/chat-agent-context.js";
import { withSearchSignal } from "../search/query-bounds.js";
import { raceAbort } from "./chat-turn-deadline.js";

/** Tool result returned once the turn's tool-call budget is spent; `code` lets callers tell it apart. */
export const TOOL_CALL_LIMIT_RESULT = {
  error: "Tool call limit reached. Summarize the results already obtained.",
  code: "tool_call_limit",
  limitReached: true,
} as const;

/** Tool result once the turn's final-answer reserve has started: the tool does not run. */
export const TOOL_DEADLINE_RESULT = {
  error: "The turn is nearly out of time, so no more tools can run. Answer now from the evidence already gathered and say what could not be checked.",
  code: "deadline",
} as const;

/** One page of a tool call's evidence; pageNumber is null only for a document with no known page. */
export type EvidencePage = { documentId: string; pageNumber: number | null };

/**
 * One tool call as reported in the response's `debug.toolCalls`. `queries` are
 * the model's own search strings: fine for the caller's debug, never put on spans.
 */
export interface ChatToolCallDetail extends ChatToolActivity {
  queries?: string[];
  resultCount?: number;
  zeroHit?: boolean;
  /** Distinct pages of the evidence this call returned. */
  evidencePages?: EvidencePage[];
  errorCode?: string;
  /** Provider cost the tool reported for its own work (embeddings, rewrites, nested answers), USD cents. */
  costCents?: number;
}

function modelQueries(supplied: Record<string, unknown>): string[] {
  const items = Array.isArray(supplied.queries) ? supplied.queries : [supplied];
  return items.slice(0, 20).map(item => item && typeof item === "object" ? (item as { q?: unknown }).q : undefined)
    .filter((q): q is string => typeof q === "string").map(q => q.slice(0, 1000));
}

/** Provider cost (USD cents) a tool response reports for its own work: retrieval AI steps or a nested answer. */
function reportedToolCostCents(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const body = result as { usage?: { costCents?: unknown }; results?: unknown };
  const own = typeof body.usage?.costCents === "number" && Number.isFinite(body.usage.costCents) ? body.usage.costCents : 0;
  const batch = Array.isArray(body.results) ? body.results.reduce<number>((sum, item) => {
    const cost = item && typeof item === "object" ? (item as { data?: { usage?: { costCents?: unknown } } }).data?.usage?.costCents : undefined;
    return sum + (typeof cost === "number" && Number.isFinite(cost) ? cost : 0);
  }, 0) : 0;
  return own + batch;
}

function responseErrorCode(result: unknown, status: number): string {
  const error = result && typeof result === "object" ? (result as { error?: unknown }).error : undefined;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/i.test(code) ? code : `http_${status}`;
}

/**
 * Distinct pages of a tool call's evidence. A chunk spanning pages has a null
 * `pageNumber` and lists them in `pageNumbers`, so each listed page is reported.
 * A document gets a null page only when none of its evidence names a page.
 */
export function evidencePages(results: SearchResult[]): EvidencePage[] {
  const byDocument = new Map<string, Set<number>>();
  for (const { citation } of results) {
    const pages = byDocument.get(citation.documentId) ?? new Set<number>();
    byDocument.set(citation.documentId, pages);
    for (const page of citation.pageNumber != null ? [citation.pageNumber] : citation.pageNumbers ?? []) pages.add(page);
  }
  return [...byDocument].flatMap(([documentId, pages]) => pages.size
    ? [...pages].sort((a, b) => a - b).map((pageNumber): EvidencePage => ({ documentId, pageNumber }))
    : [{ documentId, pageNumber: null }]);
}

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
const CHAT_EXCLUDED_TOOLS = new Set(["upload", "completeUpload", "listWorkspaces", "openUploader"]);

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
  /** Ceiling for a search batch's `concurrency`; also its value when the model omits it (default 6). */
  searchConcurrency?: number;
  /** Chat session that owns this turn; retrieval spans and search sessions link back to it. */
  chatSessionId?: string;
  /** Parent for the `execute_tool` spans (the agent span). */
  traceParent?: TelemetrySpan;
  /**
   * Time budget for the next tool call in ms (turn deadline). 0 refuses the call
   * with TOOL_DEADLINE_RESULT; a call over budget is cancelled and returns a
   * `tool_timeout` error result. Omitted: tools run until the turn signal aborts.
   */
  toolBudgetMs?: () => number;
}) {
  const citations: SearchResult[] = [];
  const activity = new Map<string, ChatToolActivity>();
  const searchCalls: ChatSearchCallStats[] = [];
  const maxToolCalls = args.maxToolCalls ?? CHAT_AGENT_LIMIT_DEFAULTS.maxToolCalls;
  const searchConcurrency = args.searchConcurrency ?? CHAT_AGENT_LIMIT_DEFAULTS.searchConcurrency;
  const counters = { executed: 0, refused: 0, byTool: {} as Record<string, number>, toolCostCents: 0, timedOut: 0, deadlineRefused: 0 };
  const details = new Map<string, ChatToolCallDetail>();
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

  function collectEvidence(value: unknown, returned: SearchResult[]): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) collectEvidence(item, returned); return; }
    const parsed = searchResultSchema.safeParse(value);
    if (parsed.success) {
      const item = parsed.data;
      returned.push(item);
      if (citations.length < 80 && !citations.some(c => c.citation.documentId === item.citation.documentId
        && c.citation.chunkIndex === item.citation.chunkIndex && c.text === item.text)) citations.push(item);
      return;
    }
    const object = value as Record<string, unknown>;
    for (const key of ["results", "citations", "data", "response"]) collectEvidence(object[key], returned);
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
        const started = Date.now();
        const detail = (fields: Omit<ChatToolCallDetail, "id" | "name" | "runtimeMs">) => {
          details.set(toolCallId, { id: toolCallId, name: definition.id, runtimeMs: Date.now() - started, ...fields });
        };
        if (++calls > maxToolCalls) {
          counters.refused++;
          detail({ status: "error", errorCode: "tool_call_limit" });
          span.set({ "docslurp.chat.tool_call_refused": true });
          span.end("tool_call_limit");
          return { ...TOOL_CALL_LIMIT_RESULT };
        }
        const budgetMs = args.toolBudgetMs?.();
        if (budgetMs !== undefined && budgetMs <= 0) {
          counters.deadlineRefused++;
          detail({ status: "error", errorCode: "deadline" });
          span.set({ "docslurp.chat.tool_deadline_refused": true });
          span.end("deadline");
          return { ...TOOL_DEADLINE_RESULT };
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          detail({ status: "error", errorCode: "invalid_arguments" });
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
        // G-04: the user-selected workspace is the only scope. The model's own
        // workspace/workspaceId arguments are stripped, then the resolved
        // workspace is applied, so a prompt-injected workspace key can't send a
        // search into another workspace and the strict route schema never sees a
        // stray field. Workspace retrieval controls (including this request's
        // overrides) are applied after the model's arguments too.
        const withoutWorkspace = (value: unknown): Record<string, unknown> => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return {};
          const { workspace: _workspace, workspaceId: _workspaceId, ...rest } = value as Record<string, unknown>;
          return rest;
        };
        const modelSupplied = withoutWorkspace(supplied);
        const body = definition.id === "search"
          ? Array.isArray(supplied.queries)
            ? { ...modelSupplied, concurrency, queries: (supplied.queries as unknown[]).map(q => ({ ...withoutWorkspace(q), ...searchDefaults, workspace: args.workspaceId })) }
            : { ...modelSupplied, ...searchDefaults, workspace: args.workspaceId }
          : definition.id === "chat" && chatDefaults
            ? { ...modelSupplied, retrieval: chatDefaults, workspace: args.workspaceId }
            : { ...modelSupplied, workspace: args.workspaceId };
        const queries = definition.id === "search" ? modelQueries(supplied) : undefined;
        const update = (status: ChatToolActivity["status"]) => {
          const event: ChatToolActivity = { id: toolCallId, name: definition.id, status,
            ...(status !== "loading" ? { runtimeMs: Date.now() - started } : {}) };
          activity.set(toolCallId, event);
          args.onActivity?.(event);
        };
        update("loading");
        // The tool, its nested searches (SQL included) and any nested model call
        // run under this signal: the turn's (deadline, client disconnect) plus
        // the tool's own budget. The in-process dispatcher keeps the outer HTTP
        // request's context, so the signal is also put in the search and chat
        // agent contexts, which nested work reads before the request signal.
        const toolAbort = new AbortController();
        const onTurnAbort = () => toolAbort.abort(args.signal.reason);
        args.signal.addEventListener("abort", onTurnAbort, { once: true });
        let toolTimedOut = false;
        const budgetTimer = budgetMs === undefined ? undefined : setTimeout(() => {
          toolTimedOut = true;
          toolAbort.abort(Object.assign(new Error(`Tool exceeded its ${budgetMs} ms budget`), { name: "TimeoutError" }));
        }, budgetMs);
        budgetTimer?.unref?.();
        const toolSignal = toolAbort.signal;
        try {
          const dispatch = () => span.run(() => args.dispatch(`/tools/${encodeURIComponent(definition.id)}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: toolSignal,
          }));
          // Settles at the abort even when nested work ignores the signal.
          const response = await raceAbort(withSearchSignal(toolSignal, () => runInChatAgentContext(args.chatSessionId ?? null, dispatch, toolSignal)), toolSignal);
          const result: unknown = await raceAbort(response.json() as Promise<unknown>, toolSignal);
          const returned: SearchResult[] = [];
          if (response.ok) {
            collectEvidence(result, returned);
            args.onEvidence?.([...citations]);
          }
          update(response.ok ? "success" : "error");
          const pages = evidencePages(returned);
          const costCents = response.ok ? reportedToolCostCents(result) : 0;
          counters.toolCostCents += costCents;
          const stats = definition.id === "search" ? searchCallStats(toolCallId, response.ok, queryCount, concurrency, result) : undefined;
          detail({ status: response.ok ? "success" : "error", ...(queries ? { queries } : {}),
            ...(stats ? { resultCount: stats.resultCount, zeroHit: stats.zeroHit } : {}),
            evidencePages: pages, ...(response.ok ? { costCents } : {}),
            ...(response.ok ? {} : { errorCode: responseErrorCode(result, response.status) }) });
          if (stats) {
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
          const timedOut = toolTimedOut && !args.signal.aborted;
          detail({ status: "error", ...(queries ? { queries } : {}), errorCode: args.signal.aborted ? "aborted" : timedOut ? "tool_timeout" : "exception" });
          if (definition.id === "search") searchCalls.push(searchCallStats(toolCallId, false, queryCount, concurrency, null));
          span.end(error ?? "Error");
          args.signal.throwIfAborted();
          if (timedOut) {
            counters.timedOut++;
            return { error: `The ${definition.id} tool ran out of time and was cancelled. Answer from the evidence already gathered, or try one narrower search.`, code: "tool_timeout" };
          }
          return { error: "Tool execution failed. Do not assume the action succeeded or retry a submission automatically." };
        } finally {
          if (budgetTimer) clearTimeout(budgetTimer);
          args.signal.removeEventListener("abort", onTurnAbort);
        }
      },
    });
  }
  return { tools, citations, activity, details, searchCalls, counters };
}
