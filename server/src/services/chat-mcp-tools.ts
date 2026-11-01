import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { workspaceSettingsProposalSchema, type WorkspaceSettingsProposal, CHAT_AGENT_LIMIT_DEFAULTS, CHAT_MAX_RETRIEVED_PASSAGES, searchResultSchema, type SearchResult, type WorkspaceSearchRetrievalDefaults } from "@docslurp/shared";
import type { WebToolActivity } from "@docslurp/shared/workspace-chat-ui";
import { startTelemetrySpan, type TelemetrySpan } from "@docslurp/shared/observability";
import type { McpDispatch, McpManifest } from "../lib/mcp-http.js";
import { runInChatAgentContext } from "../lib/chat-agent-context.js";
import { withSearchSignal } from "../search/query-bounds.js";
import { raceAbort } from "./chat-turn-deadline.js";

import { batchSearchInputSchema } from "../lib/search-input.js";
import { toolInputJsonSchema } from "./mcp-tool-schemas.js";

import { ChatToolBlockedError } from "./chat-tool-error.js";
import { ESTIMATE_TOOL_NAMES } from "./mcp-estimate-catalog.js";
export { ChatToolBlockedError } from "./chat-tool-error.js";

/** Batch endpoints may return HTTP 200 with failed items. Never treat that as success. */
function resultFailed(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const body = value as { ok?: unknown; error?: unknown; results?: unknown; failed?: unknown };
  return body.ok === false || body.error != null || (Array.isArray(body.failed) && body.failed.length > 0) || (Array.isArray(body.results)
    && body.results.some(item => item && typeof item === "object" && "ok" in item && resultFailed(item)));
}

/** Pages a webFetch result could not read (`failed`), or undefined when it reports none. */
function fetchFailures(value: unknown): Array<{ url: string; reason: string }> | undefined {
  const failed = (value as { failed?: unknown } | null)?.failed;
  if (!Array.isArray(failed) || !failed.length) return undefined;
  return failed.flatMap(item => {
    const entry = item as { url?: unknown; reason?: unknown } | null;
    return typeof entry?.url === "string" ? [{ url: entry.url, reason: typeof entry.reason === "string" ? entry.reason : "unreadable" }] : [];
  });
}

function fetchPageCount(value: unknown): number {
  const pages = (value as { pages?: unknown } | null)?.pages;
  return Array.isArray(pages) ? pages.length : 0;
}

/** Tool result returned once the turn's tool-call budget is spent; `code` lets callers tell it apart. */
export const TOOL_CALL_LIMIT_RESULT = {
  error: "Tool call limit reached. The task is blocked.",
  code: "tool_call_limit",
  limitReached: true,
} as const;

/** Tool result once the turn's final-answer reserve has started: the tool does not run. */
export const TOOL_DEADLINE_RESULT = {
  error: "No tool time remains. The task is blocked.",
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
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/i.test(code) ? code : status < 400 ? "partial_failure" : `http_${status}`;
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
  settingsProposal?: WorkspaceSettingsProposal;
  web?: WebToolActivity;
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** The web tool's request as shown while it runs (model-written query or URLs). */
/** Sources shown per web call; the UI shows five, and the full tools list is resent on every status update. */
const WEB_ACTIVITY_SOURCES = 5;
const WEB_ACTIVITY_URL_MAX = 512;

/** An http(s) URL short enough to stream and link; anything else is dropped rather than cut into a broken link. */
function streamableUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > WEB_ACTIVITY_URL_MAX) return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

function webActivityRequest(id: string, supplied: Record<string, unknown>): WebToolActivity | undefined {
  if (id === "webSearch") return { kind: "search", ...(typeof supplied.query === "string" ? { query: supplied.query.slice(0, 400) } : {}) };
  if (id === "webFetch") {
    const urls = Array.isArray(supplied.urls) ? supplied.urls : [];
    return { kind: "fetch", urls: urls.filter(streamableUrl).slice(0, WEB_ACTIVITY_SOURCES), requestedCount: urls.length };
  }
  return undefined;
}

/** The web tool's outcome: results by domain and title, never page text or provider fields. */
function webActivityResult(request: WebToolActivity, result: unknown): WebToolActivity {
  const body = (result && typeof result === "object" ? result : {}) as { results?: unknown; pages?: unknown; failed?: unknown; cached?: unknown; usage?: { credits?: unknown } };
  const items = (Array.isArray(request.kind === "search" ? body.results : body.pages) ? (request.kind === "search" ? body.results : body.pages) as unknown[] : []);
  const results = items.flatMap((item) => {
    const entry = item as { url?: unknown; title?: unknown };
    if (!streamableUrl(entry?.url)) return [];
    return [{ url: entry.url, domain: domainOf(entry.url).slice(0, 253),
      ...(typeof entry.title === "string" && entry.title ? { title: entry.title.slice(0, 300) } : {}) }];
  }).slice(0, WEB_ACTIVITY_SOURCES);
  return { ...request, results, resultCount: items.length,
    ...(Array.isArray(body.failed) ? { failedCount: body.failed.length } : {}),
    ...(typeof body.cached === "boolean" ? { cached: body.cached } : {}),
    ...(typeof body.usage?.credits === "number" ? { credits: body.usage.credits } : {}) };
}

/**
 * Chat never exposes ingestion tools: upload fetches arbitrary URLs and starts
 * paid ingestion, and the model's arguments can be steered by document text (G-04).
 * fullIndex is excluded for the same reason: it spends credits on the model's say-so.
 * The cost estimates, getJob and suggestQueries are left out because every tool
 * definition is resent on every step: in production (30 days to 2026-10-25) they
 * made 24 of ~9,000 chat tool calls. proposeWorkspaceSettings already reports a
 * change's impact, and the app prices uploads and indexing itself.
 */
// The agent generates the answer itself. A nested chat starts another paid answer
// generator under a short tool deadline and can block otherwise usable retrieval.
const CHAT_EXCLUDED_TOOLS = new Set(["chat", "openUploader", "upload", "completeUpload", "listWorkspaces", "webMap", "webCrawl", "ingestWebsite", "fullIndex",
  ...ESTIMATE_TOOL_NAMES, "getJob", "suggestQueries"]);
/**
 * Workspace settings tools: offered to the chat agent only for the first-party
 * DocSlurp app (`settingsTools`). The catalog already hides
 * proposeWorkspaceSettings from every other caller; reading settings is held
 * back too, so a customer's end users cannot read workspace configuration
 * through its chat.
 */
const CHAT_SETTINGS_TOOLS = new Set(["getWorkspaceSettings", "proposeWorkspaceSettings"]);
/**
 * Withheld from browser (client) key chats, whose users are a customer's
 * anonymous visitors: upload status reports runs, costs and failed files.
 */
const CHAT_PUBLIC_CLIENT_EXCLUDED_TOOLS = new Set(["getUploadStatus"]);
/** Web tools chat may use when the turn allows them (`webTools`). */
const CHAT_WEB_TOOLS = new Set(["webSearch", "webFetch"]);

/**
 * Tools whose failure never invalidates the answer: a proposal is an optional
 * extra (often prepared after the answer in suggestions mode), and it changes
 * nothing by itself. Their failures, refusals and timeouts go back to the model
 * as an error result instead of blocking the turn.
 */
const NON_BLOCKING_TOOLS = new Set(["proposeWorkspaceSettings"]);

/**
 * Read-only checks suggestions mode adds to a turn. Their refusals (tool-call
 * budget, deadline reserve) do not block in that mode: the user asked a document
 * question, and a skipped diagnosis must not cost them the answer. Their real
 * failures (an error response, a timeout) still block, as for any read.
 */
const SUGGESTIONS_DIAGNOSTIC_TOOLS = new Set(["getUploadStatus", "getWorkspaceSettings"]);
const REFUSAL_CODES = new Set(["tool_call_limit", "deadline"]);

/** Result for a failed non-blocking tool: the answer stands; the extra is reported as unavailable. */
export function nonBlockingToolFailure(code: string, toolId = "proposeWorkspaceSettings") {
  return {
    ok: false, code, blocked: false,
    error: toolId === "proposeWorkspaceSettings"
      ? "The settings proposal could not be prepared. Keep your answer, say the suggested change could not be prepared, and do not claim it is ready to apply or retry it."
      : "This check did not run: the turn is out of tool calls or time. Answer from the evidence already gathered, say the check was skipped, and do not claim its result.",
  } as const;
}

/**
 * Web reads are extras to a workspace answer: their failures go back to the
 * model as an explanation it passes on, and the rest of the request is still
 * answered. The exfiltration guard (`url_not_allowed`) is not one of these.
 */
const WEB_FAILURE_CAUSES: Record<string, string> = {
  unavailable: "Every web provider we tried failed to reach it. The site or the web service may be down, or the site's bot protection or website filters may be blocking automated (AI) access.",
  blocked: "The site refused automated access (bot protection, a login wall, a paywall or website filters that block AI tools).",
  thin: "The page loaded without readable text (it probably needs a browser with JavaScript or a login).",
  unreadable: "No readable content came back. The site may be down, or its bot protection or website filters may block automated (AI) access.",
  invalid_request: "The web service rejected the request; the URL or query may be malformed or unsupported.",
  url_blocked: "That address is not a public web URL, so it cannot be fetched.",
  rate_limited: "Web lookups are rate limited right now; the user can try again in a minute.",
  web_disabled: "Web tools are turned off for this workspace.",
  privacy_mode_blocked: "This workspace's privacy mode does not allow web tools.",
  tool_timeout: "The web lookup timed out. The site or the web service may be slow or down.",
  tool_call_limit: "This turn has no tool calls left for a web lookup.",
  deadline: "This turn has no time left for a web lookup.",
};

/** Plain-language cause of a web failure (an error code or a fetch `failed` reason). */
export function webFailureCause(code: string): string {
  if (/^http_4\d\d$/.test(code)) return `The site answered with an error (${code.slice(5)}); it may require a login or block automated (AI) access.`;
  if (/^http_5\d\d$/.test(code)) return `The site answered with a server error (${code.slice(5)}); it may be down.`;
  return WEB_FAILURE_CAUSES[code] ?? "The web lookup failed. The site or the web service may be down, or the site may block automated (AI) access.";
}

/** Result for a failed webSearch/webFetch: the turn continues and the model explains the gap. */
export function webToolFailure(toolId: string, code: string, failed?: Array<{ url: string; reason: string }>) {
  const what = toolId === "webFetch" ? "the requested web page" : "the web search";
  return {
    ok: false, code, blocked: false,
    error: `Could not retrieve ${what}. ${webFailureCause(code)}`,
    ...(failed?.length ? { failed: failed.slice(0, 10).map(item => ({ url: item.url, reason: webFailureCause(item.reason) })) } : {}),
    instruction: "Tell the user plainly, near the start of your answer, that this part could not be completed and why, using the reason above. Do not guess or invent what the page or search would have said. Still complete every other part of the request as well as you can, from workspace evidence and other results, and say which parts are unverified. Do not repeat the same web call.",
  } as const;
}

/** Rejected tool arguments the model may correct per turn before a rejection blocks the turn. */
const ARGUMENT_RETRIES = 2;

/** Validation issues from a 400 body (native envelope or plain), compact enough for the model. */
function validationIssues(result: unknown): unknown {
  const error = (result as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return undefined;
  const issues = (error as { details?: { issues?: unknown }; issues?: unknown }).details?.issues ?? (error as { issues?: unknown }).issues;
  if (issues === undefined) return undefined;
  const serialized = JSON.stringify(issues) ?? "";
  return serialized.length <= 2_000 ? issues : serialized.slice(0, 2_000);
}

/** Comparable form of a URL: no fragment; preserve path and query exactly. */
function urlKey(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** HTTP(S) URLs written in user text (the only URLs webFetch may read at any time). */
export function urlsInText(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)].map((match) => match[0].replace(/[.,;:!?]+$/, ""));
}

/**
 * Exfiltration guard: in chat, webFetch reads only URLs the user wrote only. Document or web text cannot make the model
 * fetch an attacker URL carrying workspace data in its query string.
 */
export const WEB_FETCH_URL_REFUSED = {
  error: "webFetch can only read URLs from the user's messages. This request is blocked.",
  code: "url_not_allowed",
} as const;

/** Ceiling for the non-passage part of a tool result shown to the model. */
const MODEL_RESULT_MAX_CHARS = 12_000;
/** Ceiling for one evidence passage shown to the model. */
const EVIDENCE_TEXT_MAX_CHARS = 4_000;

/** The tool result without its search passages (they are sent once, as `evidence`); undefined when nothing else is left. */
export function withoutEvidence(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (!value.length) return value;
    const kept = value.filter(item => !searchResultSchema.safeParse(item).success).map(withoutEvidence).filter(item => item !== undefined);
    return kept.length ? kept : undefined;
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const kept = withoutEvidence(item);
    return kept === undefined ? [] : [[key, kept] as const];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

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
  /** Offer webSearch/webFetch (when the catalog has them). Off: no web tools at all. */
  webTools?: boolean;
  /** The user's own messages, whose URLs webFetch may read. */
  userText?: string[];
  /** Suggestions mode: budget and deadline refusals of its diagnostic reads do not block the turn. */
  suggestions?: boolean;
  /** First-party DocSlurp app only (isFirstPartyAppActor): offer the workspace settings tools. Default off. */
  settingsTools?: boolean;
  /** A browser (client) key's chat: withhold tools that report account internals. */
  publicClient?: boolean;
}) {
  let failure: ChatToolBlockedError | undefined;
  const blocked = new AbortController();
  const block = (toolName: string, code: string) => {
    failure ??= new ChatToolBlockedError(toolName, code);
    blocked.abort(failure);
    return { ok: false, error: failure.message, code: failure.toolCode, blocked: true };
  };
  const throwIfBlocked = () => { if (failure) throw failure; };
  const allowedWebUrls = new Set((args.userText ?? []).flatMap(urlsInText).map(urlKey).filter((key): key is string => Boolean(key)));
  const citations: SearchResult[] = [];
  const activity = new Map<string, ChatToolActivity>();
  const searchCalls: ChatSearchCallStats[] = [];
  const maxToolCalls = args.maxToolCalls ?? CHAT_AGENT_LIMIT_DEFAULTS.maxToolCalls;
  const searchConcurrency = args.searchConcurrency ?? CHAT_AGENT_LIMIT_DEFAULTS.searchConcurrency;
  // `refused`: blocking budget refusals (a `tool_call_limit` stop). `softRefused`: refusals of optional calls, which still answer normally.
  const counters = { executed: 0, refused: 0, softRefused: 0, byTool: {} as Record<string, number>, toolCostCents: 0, timedOut: 0, deadlineRefused: 0 };
  const details = new Map<string, ChatToolCallDetail>();
  let calls = 0;
  let argumentRetries = 0;
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

  /** This call's passages, deduplicated, numbered as the turn cites them. Passages past the citation cap are not citable, so they are left out. */
  function modelEvidence(returned: SearchResult[]) {
    const seen = new Set<number>();
    const evidence = [];
    for (const item of returned) {
      const index = citations.findIndex(c => c.citation.documentId === item.citation.documentId
        && c.citation.chunkIndex === item.citation.chunkIndex && c.text === item.text);
      if (index < 0 || seen.has(index)) continue;
      seen.add(index);
      evidence.push({ citationIndex: index + 1, filename: item.citation.filename, documentId: item.citation.documentId,
        pageNumber: item.citation.pageNumber, text: (item.parentText ?? item.text).slice(0, EVIDENCE_TEXT_MAX_CHARS) });
    }
    return evidence;
  }

  const offered = (id: string) => !CHAT_EXCLUDED_TOOLS.has(id)
    && (args.settingsTools === true || !CHAT_SETTINGS_TOOLS.has(id))
    && (args.publicClient !== true || !CHAT_PUBLIC_CLIENT_EXCLUDED_TOOLS.has(id)) && (!id.startsWith("web") || (args.webTools === true && CHAT_WEB_TOOLS.has(id)));
  for (const definition of args.manifest.capabilities.filter(item => item.category === "tool" && offered(item.id))) {
    // OpenAI-compatible providers restrict function names to letters, numbers, _ and -.
    const name = definition.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (tools[name]) throw new Error("Duplicate model tool name");
    tools[name] = dynamicTool({
      description: definition.id === "search"
        ? "Retrieve cited passages from the selected workspace. Send queries as an array of objects with q and optional filters, even for one query. Each query has its own options; only concurrency may accompany queries. Use the returned evidence to write your answer; this tool does not generate an answer."
        : definition.description,
      // One shape avoids the public MCP catalog's flat q/queries union, which
      // models can satisfy while producing a mixed request the route rejects.
      inputSchema: jsonSchema(definition.id === "search" ? toolInputJsonSchema(batchSearchInputSchema) : definition.inputSchema),
      execute: async (input, { toolCallId }) => {
        args.signal.throwIfAborted();
        throwIfBlocked();
        const span = startTelemetrySpan("docslurp.chat", `execute_tool ${definition.id}`, {
          "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": definition.id,
          "gen_ai.tool.call.id": toolCallId, "gen_ai.tool.type": "function",
          ...(args.chatSessionId ? { "docslurp.chat.session_id": args.chatSessionId } : {}),
          "docslurp.workspaceId": args.workspaceId,
        }, { parent: args.traceParent });
        const started = Date.now();
        const webTool = CHAT_WEB_TOOLS.has(definition.id);
        const nonBlocking = (code: string) => NON_BLOCKING_TOOLS.has(definition.id) || webTool
          || (args.suggestions === true && SUGGESTIONS_DIAGNOSTIC_TOOLS.has(definition.id) && REFUSAL_CODES.has(code));
        const fail = (code: string, failed?: Array<{ url: string; reason: string }>) => webTool
          ? webToolFailure(definition.id, code, failed)
          : nonBlocking(code) ? nonBlockingToolFailure(code, definition.id) : block(definition.id, code);
        const detail = (fields: Omit<ChatToolCallDetail, "id" | "name" | "runtimeMs">) => {
          details.set(toolCallId, { id: toolCallId, name: definition.id, runtimeMs: Date.now() - started, ...fields });
        };
        if (++calls > maxToolCalls) {
          if (nonBlocking("tool_call_limit")) counters.softRefused++; else counters.refused++;
          detail({ status: "error", errorCode: "tool_call_limit" });
          span.set({ "docslurp.chat.tool_call_refused": true });
          span.end("tool_call_limit");
          return { ...TOOL_CALL_LIMIT_RESULT, ...fail("tool_call_limit") };
        }
        const budgetMs = args.toolBudgetMs?.();
        if (budgetMs !== undefined && budgetMs <= 0) {
          counters.deadlineRefused++;
          detail({ status: "error", errorCode: "deadline" });
          span.set({ "docslurp.chat.tool_deadline_refused": true });
          span.end("deadline");
          return { ...TOOL_DEADLINE_RESULT, ...fail("deadline") };
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          detail({ status: "error", errorCode: "invalid_arguments" });
          span.end("invalid_arguments");
          return fail("invalid_arguments");
        }
        const supplied = { ...input } as Record<string, unknown>;
        // The model may select user text, but may not construct an outbound query
        // or filters from private evidence or hostile search results.
        if (definition.id === "webSearch") {
          if (typeof supplied.query !== "string" || !(args.userText ?? []).some(text => text.trim() === supplied.query)) {
            span.end("query_not_allowed");
            return fail("query_not_allowed");
          }
          for (const key of Object.keys(supplied)) {
            if (key !== "query") delete supplied[key];
          }
        }

        if (definition.id === "webFetch") {
          const urls = Array.isArray(supplied.urls) ? supplied.urls : [];
          if (!urls.length || urls.some((url) => typeof url !== "string" || !allowedWebUrls.has(urlKey(url) ?? ""))) {
            detail({ status: "error", errorCode: WEB_FETCH_URL_REFUSED.code });
            span.set({ "docslurp.chat.web_fetch_refused": true });
            span.end(WEB_FETCH_URL_REFUSED.code);
            return { ...WEB_FETCH_URL_REFUSED, ...block(definition.id, WEB_FETCH_URL_REFUSED.code) };
          }
        }
        counters.executed++;
        counters.byTool[definition.id] = (counters.byTool[definition.id] ?? 0) + 1;
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
          : { ...modelSupplied, workspace: args.workspaceId };
        const queries = definition.id === "search" ? modelQueries(supplied) : undefined;
        let settingsProposal: WorkspaceSettingsProposal | undefined;
        let web = webActivityRequest(definition.id, supplied);
        const update = (status: ChatToolActivity["status"]) => {
          const event: ChatToolActivity = { id: toolCallId, name: definition.id, status,
            ...(status !== "loading" ? { runtimeMs: Date.now() - started } : {}), ...(settingsProposal ? { settingsProposal } : {}),
            ...(web ? { web } : {}) };
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
        const toolSignal = AbortSignal.any([toolAbort.signal, blocked.signal]);
        try {
          const dispatch = () => span.run(() => args.dispatch(`/tools/${encodeURIComponent(definition.id)}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: toolSignal,
          }));
          // Settles at the abort even when nested work ignores the signal.
          const response = await raceAbort(withSearchSignal(toolSignal, () => runInChatAgentContext(args.chatSessionId ?? null, dispatch, toolSignal)), toolSignal);
          const result: unknown = await raceAbort(response.json() as Promise<unknown>, toolSignal);
          throwIfBlocked();
          // A page read that returned some pages succeeded; the unread ones are reported beside them.
          const fetchFailed = definition.id === "webFetch" && response.ok ? fetchFailures(result) : undefined;
          let ok = response.ok && (fetchFailed ? fetchPageCount(result) > 0 : !resultFailed(result));
          let failureCode: string | undefined;
          const returned: SearchResult[] = [];
          if (ok) {
            collectEvidence(result, returned);
            args.onEvidence?.([...citations]);

          }
          // A partial fetch failure still reports what was read and how many pages failed.
          if (response.ok && web) web = webActivityResult(web, result);
          if (ok && definition.id === "proposeWorkspaceSettings") {
            const parsed = workspaceSettingsProposalSchema.safeParse((result as { settingsProposal?: unknown })?.settingsProposal);
            if (parsed.success) settingsProposal = parsed.data;
            // No card can render, so the model must not say a proposal is ready (or see a raw token).
            else { ok = false; failureCode = "invalid_proposal"; }
          }
          update(ok ? "success" : "error");
          const pages = evidencePages(returned);
          const costCents = ok ? reportedToolCostCents(result) : 0;
          counters.toolCostCents += costCents;
          const stats = definition.id === "search" ? searchCallStats(toolCallId, ok, queryCount, concurrency, result) : undefined;
          detail({ status: ok ? "success" : "error", ...(queries ? { queries } : {}),
            ...(stats ? { resultCount: stats.resultCount, zeroHit: stats.zeroHit } : {}),
            evidencePages: pages, ...(ok ? { costCents } : {}), ...(settingsProposal ? { settingsProposal } : {}),
            ...(ok ? {} : { errorCode: failureCode ?? responseErrorCode(result, response.status) }) });
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
          span.end(ok ? undefined : `http_${response.status}`);
          if (!ok) {
            const code = failureCode ?? (fetchFailed?.length ? fetchFailed[0]!.reason : responseErrorCode(result, response.status));
            // Arguments the route rejected before doing any work: the model can fix them, so they need not cost the answer.
            if (!webTool && response.status === 400 && ["invalid_request", "http_400"].includes(code) && argumentRetries < ARGUMENT_RETRIES) {
              argumentRetries++;
              const issues = validationIssues(result);
              return { ok: false, blocked: false, code: "invalid_arguments", status: 400,
                error: "The tool rejected these arguments before running. Nothing was searched or changed.",
                ...(issues === undefined ? {} : { issues }),
                instruction: "Call the tool again once with arguments that match its input schema, fixing the issues listed. Do not report this as a failure unless the corrected call also fails." };
            }
            return { ...fail(code, fetchFailed), status: response.status };
          }
          // Another concurrent tool may have failed while this one was running.
          throwIfBlocked();
          // Passages reach the model once, as this call's numbered evidence. Every
          // later step re-sends the whole history, so repeating the raw hits or the
          // turn's earlier evidence here multiplied input tokens per answer.
          const modelResult = settingsProposal ? { settingsProposal: { ...settingsProposal, token: undefined } } : withoutEvidence(result);
          const serialized = JSON.stringify(modelResult) ?? "";
          const evidence = modelEvidence(returned);
          return {
            ok, status: response.status,
            ...(fetchFailed?.length ? { unread: fetchFailed.slice(0, 10).map(item => ({ url: item.url, reason: webFailureCause(item.reason) })),
              instruction: "Some pages could not be read. Answer from the pages that were read, and tell the user plainly which pages could not be retrieved and why." } : {}),
            ...(modelResult === undefined ? {} : { result: serialized.length <= MODEL_RESULT_MAX_CHARS ? modelResult : { truncated: true, preview: serialized.slice(0, MODEL_RESULT_MAX_CHARS) } }),
            // Local citation numbers in a nested answer must not overwrite the outer turn's numbering.
            ...(evidence.length ? { evidence } : {}),
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
            return fail("tool_timeout");
          }
          return fail("exception");
        } finally {
          if (budgetTimer) clearTimeout(budgetTimer);
          args.signal.removeEventListener("abort", onTurnAbort);
        }
      },
    });
  }
  return { tools, citations, activity, details, searchCalls, counters, block, throwIfBlocked, get failure() { return failure; } };
}
