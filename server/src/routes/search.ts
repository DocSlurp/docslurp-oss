import { chatOperationRoutes, durableChatLaunchHandler } from "./chat-operations.js";
import { GeoSearchError } from "../search/geo-scope.js";
import { geoPredicateSchema, SEARCH_STREAM_PROTOCOL, searchResultId } from "@docslurp/shared";
import { reportPublicError } from "../lib/public-errors.js";
import { chatSessionForRequest, CHAT_SESSION_TOKEN_HEADER } from "../lib/chat-session-tokens.js";
import { apiErrorResponse, envelopeForError, nativeApiErrors, withApiErrorDetails } from "../lib/api-error.js";
import { Hono, type Context } from "hono";
import { batchSearchInputSchema, searchFormError, searchInputSchema, searchOptions, searchQueryText, projectChatRequestSchema, type SearchInput } from "../lib/search-input.js";
import { streamSSE } from "hono/streaming";
import { assertCanSpend } from "../services/billing/spend-guard.js";
import { enforceActorCategoryRateLimit } from "../middleware/rate-limit.js";
import { acquireChatSlot, chatSlotRefusedResponse } from "../middleware/chat-concurrency.js";

import { aggregateProjectRagSearchRequestSchema, deferredProfilesEnabled, PARSE_SOURCE_RESCAN_REASON, PUBLIC_ERROR_MESSAGES, type ApiErrorCode } from "@docslurp/shared";

import {
  actorHasAnyApiKeyScope,
  assertApiKeyProjectAccess,
  getRequestActor,
  resolveActorProjectId,
  actorCanSearch,
} from "../lib/request-actor.js";
import { withDeferredContext, type DeferredRequestContext, type MaterializeEvent } from "../search/deferred/deferred-context.js";
import { defaultMaterializeDeps, pageKey } from "../search/deferred/materialize-client.js";
import { loadProjectPipeline } from "../search/session-setup.js";
import { resolveMaterializationPolicy } from "../services/materialization-policy.js";
import { aggregateProjectRagSearch } from "../services/aggregate-rag.js";
import { resolveDefaultOrganization } from "../services/organizations.js";
import { ProjectAccessError } from "../services/default-project.js";
import { CrossProjectScopeError, hybridSearch, MissingProjectScopeError, ProjectNotFoundError } from "../services/search.js";
import { prefetchBatchQueryEmbeddings } from "../search/batch-embeddings.js";
import { chatProject, projectChatDisabledBody } from "../services/project-chat.js";
import { ProjectChatDisabledError } from "../services/project-chat-errors.js";
import { beginChatTurn, chatTurnFailureReason, type ChatTurn, type ChatTurnUsage } from "../services/billing/chat-turn-billing.js";
import { parseFilters } from "../search/filters.js";
import { InvalidRetrievalQueryError, parseRetrievalQueryFlags } from "../lib/retrieval-query-flags.js";
import { publicSearchResponse } from "../lib/search-usage.js";
import { sql } from "../db.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { currentRequestApiKeyId, getRequestId, currentRequestSearchCeiling } from "../lib/request-context.js";
import { cacheableApiKeyId, createCacheScopeMemo, primeCacheScope, readCachedResponse, responseCacheTicket, searchResponseCacheTtlMs, storeResponse, type CacheScopeMemo } from "../search/response-cache.js";
import { authorizeActorProjectSearch, type AuthorizedProjectSearch } from "../lib/search-access.js";
import type { SearchAccessScope } from "../search/access-scope.js";
export { clearSearchResponseCacheForTests } from "../search/response-cache.js";
import { SearchCapacityError, withSearchAdmissionGroup } from "../search/search-limiter.js";
import { SearchModeLimitError } from "../search/search-mode-limits.js";
import { withSearchStreamSink, type SearchStreamSink } from "../search/stream-events.js";
import { withSearchSignal } from "../search/query-bounds.js";
import { awaitSearchSessionWrites } from "../search/session.js";
import { randomUUID } from "node:crypto";
import { env } from "../config.js";
import { activeTraceparent } from "@docslurp/shared/observability";
import { chatModelRefused, ChatModelNotAllowedError, SpeedBoostUnavailableError } from "../lib/chat-model-policy.js";

function modelNotAllowed(c: Context): Response {
  return apiErrorResponse(c, 400, "model_not_allowed", new ChatModelNotAllowedError().message);
}

/**
 * Runs each validated query, preserving input order and per-item errors.
 * The batch is one admission group (at most SEARCH_MAX_SLOTS_PER_TURN
 * concurrent searches, search/search-limiter.ts), and its query embeddings
 * are fetched with one provider request per project before the searches
 * start (search/batch-embeddings.ts).
 */
async function runSearchBatch(c: Context, parsed: { queries: SearchInput[]; concurrency: number }, userId: string): Promise<BatchResult[]> {
  const { queries, concurrency } = parsed;
  const signal = c.req.raw.signal;
  const results: BatchResult[] = queries.map(() => ({ ok: false,
    error: { code: "REQUEST_ABORTED", message: "Request aborted before search started", status: 499 } }));
  if (signal.aborted) return results;
  // One access and privacy lookup per project for the whole batch, never reused by another request.
  const memo = createCacheScopeMemo();
  const authorizations = new Map<string, Promise<AuthorizedProjectSearch | { ok: false; status: 403 | 404 }>>();
  // Scope and API-key checks first, so embeddings are only prefetched for queries that will run.
  const inputs = await Promise.all(queries.map(async (query, index) => {
    try {
      const projectId = await resolveActorProjectId(getRequestActor(c), query.project, query.orgId);
      let authorization = authorizations.get(projectId);
      if (!authorization) {
        authorization = authorizeActorProjectSearch(getRequestActor(c), projectId, "search");
        authorizations.set(projectId, authorization);
      }
      const granted = await authorization;
      if (!granted.ok) {
        results[index] = { ok: false, error: {
          code: granted.status === 403 ? "FORBIDDEN" : "PROJECT_NOT_FOUND",
          message: granted.status === 403 ? "Forbidden" : "Project not found", status: granted.status } };
        return null;
      }
      primeCacheScope(memo, userId, granted.access);
      return { ...query, projectId, scope: granted.scope };
    } catch (error) {
      results[index] = { ok: false, error: searchError(error) };
      return null;
    }
  }));
  if (!signal.aborted) {
    // Keyword fan-outs (array q) never embed.
    await prefetchBatchQueryEmbeddings(inputs.flatMap((input) => input && !Array.isArray(input.q) ? [{ query: input.q.replaceAll("\u0000", ""), projectId: input.projectId, options: searchOptions(input), scope: input.scope }] : []), userId, signal);
  }
  let next = 0;
  async function worker() {
    while (!signal.aborted && next < queries.length) {
      const index = next++;
      const input = inputs[index];
      if (!input) continue;
      try {
        const deferred = await deferredRequestContext(c, input.projectId);
        if ("response" in deferred) {
          const status = deferred.response.status;
          results[index] = { ok: false, error: { code: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", message: "Search capability rejected", status } };
        } else {
          results[index] = { ok: true, data: await retrieve(input, input.scope, userId, requestApiKeyId(c), deferred.context, memo) };
        }
      } catch (error) {
        results[index] = { ok: false, error: searchError(error) };
      }
    }
  }
  await withSearchAdmissionGroup(`batch:${randomUUID()}`, () =>
    Promise.all(Array.from({ length: Math.min(concurrency, queries.length) }, () => worker())));
  return results;
}

function clampSearchLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.min(100, Math.floor(value)));
}

/**
 * The request's one project access read (lib/search-access.ts): API-key scope, project access, org and allowlist,
 * answered in the native error envelope on refusal. Answers need `chat`; passages need `search`. The granted result
 * carries the explicit search access scope and the access row the response cache reuses.
 */
async function authorizeProject(c: Context, projectId: string, required: "search" | "chat" = "search"): Promise<AuthorizedProjectSearch | Response> {
  const granted = await authorizeActorProjectSearch(getRequestActor(c), projectId, required);
  if (granted.ok) return granted;
  return granted.status === 403
    ? apiErrorResponse(c, 403, "forbidden", "Forbidden")
    : apiErrorResponse(c, 404, "project_not_found", "Project not found");
}

const CAPABILITY_ERRORS = {
  capability_invalid: { status: 401, message: "Search capability is invalid" },
  capability_expired: { status: 401, message: "Search capability has expired" },
  capability_origin: { status: 403, message: "Search capability is not valid for this origin" },
  capability_scope: { status: 403, message: "Search capability does not cover this project" },
} as const;

/**
 * Request-scoped deferred-search inputs: the presenting API key (so client-key
 * defaults apply) and, when an `X-DocSlurp-Capability` header is sent, its
 * policy, validated up front so a bad token is a 401/403 and not a silent
 * downgrade. Inert unless DOCSLURP_DEFERRED_PROFILES=1.
 */
async function deferredRequestContext(
  c: Context,
  projectId: string,
  onEvent?: (event: MaterializeEvent) => void,
): Promise<{ context: DeferredRequestContext } | { response: Response }> {
  const actor = getRequestActor(c);
  const context: DeferredRequestContext = { apiKey: actor?.type === "apiKey" ? actor.apiKey : null, ...(onEvent ? { onEvent } : {}) };
  const capability = c.req.header("X-DocSlurp-Capability")?.trim();
  if (deferredProfilesEnabled() && capability) {
    const resolved = await resolveMaterializationPolicy({
      projectPipeline: await loadProjectPipeline(projectId),
      apiKey: context.apiKey ?? null,
      capabilityHeader: capability,
      origin: c.req.header("Origin") ?? null,
      projectId,
    });
    if ("error" in resolved) {
      const { status, message } = CAPABILITY_ERRORS[resolved.error];
      return { response: apiErrorResponse(c, status, status === 401 ? "unauthorized" : "forbidden", message, { category: resolved.error }) };
    }
    context.policy = resolved.policy;
  }
  return { context };
}

/**
 * For cookie-authenticated GETs that do work: the browser says the request is
 * same-origin (Fetch Metadata), or its Origin is the API's own origin or an
 * allowed app origin. A request with neither header is refused.
 */
function sameOriginBrowserRequest(c: Context): boolean {
  const origin = c.req.header("Origin");
  const site = c.req.header("Sec-Fetch-Site");
  let ownOrigin = "";
  try { ownOrigin = new URL(c.req.url).origin; } catch { /* keep empty */ }
  const trustedOrigin = (value: string) => value === ownOrigin || env.corsAllowedOrigins.includes(value);
  if (origin) return trustedOrigin(origin) && (!site || site === "same-origin" || site === "same-site");
  // Neither header: refused. Browsers that send no Fetch Metadata on same-origin
  // GETs (Safari before 16.4) can't stream with a cookie session; POST /v1/chat works.
  return site === "same-origin";
}

/** `grounded` is the nested MCP tool target: retrieval-only, never another agent or a settings change. */
async function handleProjectChat(c: Context, mode: "public" | "grounded") {
  if (mode === "public" && process.env.DOCSLURP_DURABLE_CHAT === "1" && getRequestActor(c).type === "session") {
    return durableChatLaunchHandler(c);
  }
  // Lets clients join a turn to its trace (the trace id is the second field).
  const traceparent = activeTraceparent();
  if (traceparent) c.header("traceparent", traceparent);
  const parsed = projectChatRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return apiErrorResponse(c, 400, "invalid_request", "Invalid chat input", { issues: parsed.error.issues });
  const body = parsed.data;
  const userId = c.get("sessionUser")?.id;
  if (!userId) return apiErrorResponse(c, 401, "unauthorized", "Missing session");
  const projectId = await resolveActorProjectId(getRequestActor(c), body.project, body.orgId);
  const authorized = await authorizeProject(c, projectId, "chat");
  if (authorized instanceof Response) return authorized;
  // Before the turn starts, so a disabled chat is a plain 403 (chatProject enforces it too, for every caller).
  const chatDisabled = await projectChatDisabledBody(projectId, userId);
  if (chatDisabled) return apiErrorResponse(c, 403, "chat_disabled", chatDisabled.error);
  // Before the turn starts: a browser key continues a session only with its grant
  // (no grant: a fresh session; a bad grant: 403).
  const sessionId = chatSessionForRequest(getRequestActor(c), { projectId, sessionId: body.sessionId, sessionToken: body.sessionToken });
  const deferred = await deferredRequestContext(c, projectId);
  if ("response" in deferred) return deferred.response;
  // This route knows whether the answer reached the client, so it owns the
  // chat turn's bill. A nested grounded call joins the agent's turn instead.
  const turn = beginChatTurn({ speedBoost: parsed.data.speedBoost });
  const signal = c.req.raw.signal;
  let response: Awaited<ReturnType<typeof chatProject>>;
  try {
    response = await turn.run(() => withDeferredContext(deferred.context, () => chatProject({ projectId, userId, scope: authorized.scope,
      query: body.q, sessionId, sessionToken: body.sessionToken, model: body.model, tier: body.tier, reasoning: body.reasoning, speedBoost: body.speedBoost,
      actor: getRequestActor(c), signal,
      ...(mode === "grounded"
        ? { allowAgentTools: false, allowConfiguration: false }
        : { allowAgentTools: env.publicChatAgentEnabled, ...(body.agent ? { agent: body.agent } : {}) }),
      ...(body.retrieval ? { retrieval: body.retrieval } : {}),
      ...(body.filters ? { filters: body.filters } : {}) })));
  } catch (error) {
    const usage = await failChatTurn(turn, chatTurnFailureReason(error, signal));
    if (error instanceof ChatModelNotAllowedError) return modelNotAllowed(c);
    if (error instanceof SpeedBoostUnavailableError) return apiErrorResponse(c, 400, "speed_boost_unavailable", error.message);
    if (error instanceof ProjectChatDisabledError) return apiErrorResponse(c, 403, "chat_disabled", error.message);
    const failure = expectedSearchFailure(error);
    if (failure) return apiErrorResponse(c, failure.status, failure.apiCode, failure.message, usage ? { usage } : undefined);
    throw usage ? withApiErrorDetails(error, { usage }) : error;
  }
  // The answer was generated for this client: it is charged even if the
  // client has already left (it is persisted to the chat session, and a
  // refund here would make disconnecting a way to get answers for free).
  turn.delivered();
  return c.json(response);
}

/** Refund an undelivered turn; the usage goes in the error body when this request owns the turn. */
async function failChatTurn(turn: ChatTurn, reason: string): Promise<ChatTurnUsage | null> {
  if (!turn.owned) return null;
  try {
    return await turn.failed(reason);
  } catch (error) {
    // A failed refund must not replace the turn's own error; the turn stays charged.
    reportPublicError(error);
    return turn.usage();
  }
}

const projectChatHandler = (c: Context) => handleProjectChat(c, "public");

export const projectChatRoutes = new Hono()
  .route("/operations", chatOperationRoutes)
  .use("*", nativeApiErrors)
  .post("/", projectChatHandler)
  .get("/stream", projectChatStreamHandler)
  // The question travels in the body, not the URL, where proxies, logs and history keep it.
  .post("/stream", projectChatStreamHandler);
/** Internal tool target only. Never mount this router as a public agent entrypoint. */
export const groundedProjectChatRoutes = new Hono().use("*", nativeApiErrors).post("/", (c: Context) => handleProjectChat(c, "grounded"));

/**
 * `POST /v1/chat/stream` (and `GET /v1/chat/stream`, kept for browsers that
 * can only open an EventSource): the cited chat answer as server-sent events.
 * The POST carries the same JSON body as `POST /v1/chat`, so the question is
 * never in a URL. The same scoping, chat settings and spend checks apply.
 */
async function projectChatStreamHandler(c: Context) {
  if (process.env.DOCSLURP_DURABLE_CHAT === "1" && getRequestActor(c).type === "session") {
    return c.json({ error: "Use POST /v1/chat/operations with Idempotency-Key, then resume the operation" }, 409);
  }
  const fromBody = c.req.method === "POST";
  // Paid GET turns from cookie sessions require same-origin browser evidence; a POST is covered by the CSRF/origin checks every POST gets.
  if (!fromBody && getRequestActor(c).type === "session" && !sameOriginBrowserRequest(c)) {
    return apiErrorResponse(c, 403, "forbidden", "Cross-site request rejected");
  }
  let input: unknown;
  if (fromBody) {
    const body: unknown = await c.req.json().catch(() => null);
    input = body && typeof body === "object" && !Array.isArray(body)
      ? { ...body, sessionToken: c.req.header(CHAT_SESSION_TOKEN_HEADER)?.trim() || (body as { sessionToken?: unknown }).sessionToken }
      : null;
  } else {
    let filters: unknown;
    const rawFilters = c.req.query("filters");
    if (rawFilters !== undefined) {
      try {
        if (rawFilters.length > 16384) throw new Error("Filters too large");
        filters = JSON.parse(rawFilters);
      } catch { return apiErrorResponse(c,400,"invalid_request","Invalid chat filters"); }
    }
    input = { filters, q: c.req.query("q"),
      project: c.req.query("project") || undefined, orgId: c.req.query("orgId") || undefined,
      sessionId: c.req.query("sessionId"),
      sessionToken: c.req.header(CHAT_SESSION_TOKEN_HEADER)?.trim() || undefined,
      model: c.req.query("model"), tier: c.req.query("tier") || undefined, reasoning: c.req.query("reasoning") || undefined, speedBoost: c.req.query("speedBoost") === undefined ? false : c.req.query("speedBoost") === "true" ? true : c.req.query("speedBoost") === "false" ? false : c.req.query("speedBoost") };
  }
  const parsed = projectChatRequestSchema.safeParse(input);
  if (!parsed.success) return apiErrorResponse(c, 400, "invalid_request", "Invalid chat input", { issues: parsed.error.issues });
  const { q: query, sessionToken, model } = parsed.data;

  const userId = c.get("sessionUser").id;
  const projectId = await resolveActorProjectId(getRequestActor(c), parsed.data.project, parsed.data.orgId);
  const authorized = await authorizeProject(c, projectId, "chat");
  if (authorized instanceof Response) return authorized;
  // Checked before the stream opens so a disabled chat is a real 403, not an error event.
  const chatDisabled = await projectChatDisabledBody(projectId, userId);
  if (chatDisabled) return apiErrorResponse(c, 403, "chat_disabled", chatDisabled.error);
  if (await chatModelRefused(getRequestActor(c), model, projectId)) return modelNotAllowed(c);
  const sessionId = chatSessionForRequest(getRequestActor(c), { projectId, sessionId: parsed.data.sessionId, sessionToken });
  // Refuse before the stream opens, so a blocked spend is a 402.
  // Pre-check only: chatProject takes the interactive hold.
  await assertCanSpend(authorized.scope.orgId, projectId, { kind: "interactive", hold: false });
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");

  // Validated before the stream opens, so a bad capability is a real 401/403.
  // Events are chained so they reach the client in order, ahead of `message`.
  let pendingEvents: Promise<unknown> = Promise.resolve();
  let sink: (event: MaterializeEvent) => void = () => undefined;
  const deferred = await deferredRequestContext(c, projectId, (event) => sink(event));
  if ("response" in deferred) return deferred.response;

  const turn = beginChatTurn({ speedBoost: parsed.data.speedBoost });
  return streamSSE(c, (stream) => turn.run(async () => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    deferred.context.signal = abort.signal;
    sink = (event) => {
      pendingEvents = pendingEvents
        .then(() => stream.writeSSE({ event: event.type, data: JSON.stringify({ documentId: event.documentId, pages: event.pages }) }))
        .catch(() => undefined);
    };
    await stream.writeSSE({
      event: "status",
      data: JSON.stringify({
        stage: "retrieval",
        message: "Retrieving project context"
      })
    });

    let response: Awaited<ReturnType<typeof chatProject>>;
    try {
      response = await withDeferredContext(deferred.context, () => chatProject({
        projectId,
        userId,
        scope: authorized.scope,
        query,
        actor: getRequestActor(c), allowAgentTools: env.publicChatAgentEnabled, signal: AbortSignal.any([c.req.raw.signal, abort.signal]),
        sessionId, sessionToken,
        model, tier: parsed.data.tier, reasoning: parsed.data.reasoning, speedBoost: parsed.data.speedBoost, filters: parsed.data.filters,
        // Answer text as the model writes it. The final `message` frame still carries the whole answer: clients that
        // ignore `delta` (or a moderated turn, whose text arrives as one delta after the check) lose nothing.
        onTextDelta: async (text) => {
          if (!text || abort.signal.aborted) return;
          pendingEvents = pendingEvents
            .then(() => stream.writeSSE({ event: "delta", data: JSON.stringify({ text }) }))
            .catch(() => undefined);
          await pendingEvents;
        },
      }));
      await pendingEvents;
      await stream.writeSSE({
        event: "message",
        data: JSON.stringify(response)
      });
    } catch (error) {
      await failChatTurn(turn, chatTurnFailureReason(error, abort.signal.aborted ? abort.signal : c.req.raw.signal));
      throw error;
    }
    // Generated for this client: charged, whether or not it is still connected.
    turn.delivered();
    await stream.writeSSE({
      event: "done",
      data: JSON.stringify({
        id: response.id,
        sessionId: response.sessionId,
        ...(response.sessionToken ? { sessionToken: response.sessionToken } : {}),
        searchSessionId: response.searchSessionId
      })
    });
  }));
}

type SearchData = ReturnType<typeof publicSearchResponse>;
type BatchResult = { ok: true; data: SearchData } | { ok: false; error: { code: string; message: string; status: number } };
type SearchFailure = { code: string; apiCode: ApiErrorCode; message: string; status: 400 | 403 | 404 | 409 | 503 };
/** `code` is the per-item batch code; `apiCode` is the envelope code of a whole-request failure. */
function expectedSearchFailure(error: unknown): SearchFailure | null {
  if (error instanceof GeoSearchError) return {code:"GEO_UNAVAILABLE",apiCode:"invalid_request",message:error.message,status:error.status};
  if (error instanceof InvalidRetrievalQueryError) {
    return { code: "INVALID_RETRIEVAL_QUERY", apiCode: "invalid_request", message: error.message, status: 400 };
  }
  if (error instanceof ProjectAccessError) {
    if (error.status === 400) return { code: "INVALID_PROJECT", apiCode: "invalid_request", message: error.message, status: 400 };
    return error.status === 403
      ? { code: "FORBIDDEN", apiCode: "forbidden", message: error.message, status: 403 }
      : { code: "PROJECT_NOT_FOUND", apiCode: "project_not_found", message: error.message, status: 404 };
  }
  if (error instanceof MissingProjectScopeError || error instanceof CrossProjectScopeError) {
    return { code: "INVALID_SEARCH_SCOPE", apiCode: "invalid_search_scope", message: error.message, status: 400 };
  }
  if (error instanceof ProjectNotFoundError) {
    return { code: "PROJECT_NOT_FOUND", apiCode: "project_not_found", message: error.message, status: 404 };
  }
  return null;
}
function searchError(error: unknown): { code: string; message: string; status: 400 | 403 | 404 | 409 | 429 | 499 | 500 | 503 } {
  // Load shedding and disconnects are expected outcomes, not internal failures: keep them out of error reports.
  if (error instanceof SearchCapacityError) return { code: "SEARCH_UNAVAILABLE", message: "Search capacity is full; retry shortly", status: 503 };
  if (error instanceof SearchModeLimitError) return { code: "SEARCH_LIMIT_EXCEEDED", message: PUBLIC_ERROR_MESSAGES.searchLimit, status: 429 };
  if (error instanceof Error && error.name === "AbortError") return { code: "REQUEST_ABORTED", message: "Request aborted before search finished", status: 499 };
  return expectedSearchFailure(error) ?? { code: "SEARCH_FAILED", message: reportPublicError(error), status: 500 };
}
/** The API key a request authenticated with, null for a session, undefined when the caller is unknown (never cached). */
function requestApiKeyId(c: Context): string | null | undefined {
  const actor = getRequestActor(c) as ReturnType<typeof getRequestActor> | undefined;
  if (!actor) return undefined;
  return actor.type === "apiKey" ? actor.apiKey.keyId : null;
}

/**
 * Runs one search, reusing a recent identical answer when the response cache
 * (search/response-cache.ts) allows it. Callers authorize the project and the
 * API key's scopes first; the cache never serves a request that has not passed them.
 * `memo` shares access and privacy lookups across the searches of one request or batch.
 */
async function lookupRetrieve(body: SearchInput & { projectId: string }, scope: SearchAccessScope, userId: string, actorApiKeyId: string | null | undefined, deferred: DeferredRequestContext | undefined, memo: CacheScopeMemo): Promise<SearchLookup> {
  // A capability changes the policy a cached answer was produced under: never share across it.
  const ttl = deferred?.policy || body.geo ? 0 : searchResponseCacheTtlMs();
  const apiKeyId = cacheableApiKeyId(actorApiKeyId, currentRequestApiKeyId());
  // Keyed on the exact request, query as sent: the search runs on that same text.
  const ticket = ttl > 0 && apiKeyId !== undefined
    ? await responseCacheTicket({ userId, apiKeyId, projectIds: [body.projectId], request: { ...body, searchCeiling: currentRequestSearchCeiling() }, memo })
    : null;
  const cached = ticket ? readCachedResponse(ticket, ttl) as SearchData | undefined : undefined;
  if (cached) {
    return { hit: {
      ...cached,
      usage: { ...cached.usage, inputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0, costSource: "none" },
      timings: { cachedMs: 0, totalMs: 0 },
    }, run: async () => { throw new Error("cached search has nothing to run"); } };
  }
  return { run: async () => {
    const search = () => hybridSearch(searchQueryText(body.q), userId, searchOptions(body), scope);
    const data = publicSearchResponse(await (deferred ? withDeferredContext(deferred, search) : search()));
    // A response with pages still materializing must not be replayed as final.
    if (ticket && data.availability?.status === "complete" && !(data.deferred && data.deferred.pendingPages > 0)) {
      await storeResponse(ticket, data, data.availability?.scope?.projectId);
    }
    return data;
  } };
}

async function retrieve(body: SearchInput & { projectId: string }, scope: SearchAccessScope, userId: string, actorApiKeyId: string | null | undefined, deferred: DeferredRequestContext | undefined, memo: CacheScopeMemo): Promise<SearchData> {
  const lookup = await lookupRetrieve(body, scope, userId, actorApiKeyId, deferred, memo);
  return lookup.hit ?? lookup.run();
}

/** A single-query search that passed every up-front check; `GET`/`POST /v1/search` and the stream run it identically. */
interface PreparedSearch {
  userId: string;
  projectId: string;
  /** Hits per leg event: the request's effective `limit`. */
  limit: number;
  deferred: DeferredRequestContext;
  /** The response-cache read (POST only: GET never uses the cache). A hit is a ready body; otherwise `run` searches. */
  lookup(): Promise<SearchLookup>;
}
type SearchLookup = { hit?: SearchData; run: () => Promise<SearchData> };
const DEFAULT_SEARCH_LIMIT = 20;

/** GET input checks and project authorization, answered before anything runs. */
async function prepareGetSearch(c: Context): Promise<PreparedSearch | Response> {
  const query = c.req.query("q");
  if (!query) {
    return apiErrorResponse(c, 400, "invalid_request", "Missing query parameter 'q'");
  }

  const userId = c.get("sessionUser")?.id;
  if (!userId) {
    return apiErrorResponse(c, 401, "unauthorized", "Missing session");
  }
  const projectId = await resolveActorProjectId(
    getRequestActor(c),
    c.req.query("project"),
    c.req.query("orgId"),
  );
  const authorized = await authorizeProject(c, projectId);
  if (authorized instanceof Response) return authorized;
  const runId = c.req.query("runId");
  const limit = c.req.query("limit");
  const variant = c.req.query("variant");

  // Retrieval flags are tri-state: omitted flags fall back to the project's
  // Retrieval Controls (provider-backed enhancements default off there).
  let flags: ReturnType<typeof parseRetrievalQueryFlags>;
  try {
    flags = parseRetrievalQueryFlags((name) => c.req.query(name));
  } catch (error) {
    if (error instanceof InvalidRetrievalQueryError) return apiErrorResponse(c, 400, "invalid_request", error.message);
    throw error;
  }

  const filters = parseFilters({
    documentId: c.req.query("documentId") ?? "",
    runId: runId ?? "",
    projectId,
    filenameContains: c.req.query("filenameContains") ?? "",
    mimeTypes: c.req.query("mimeTypes") ?? "",
    tags: c.req.query("tags") ?? "",
    pageFrom: c.req.query("pageFrom") ?? "",
    pageTo: c.req.query("pageTo") ?? "",
    language: c.req.query("language") ?? "",
    heading: c.req.query("heading") ?? "",
    dateFrom: c.req.query("dateFrom") ?? "",
    dateTo: c.req.query("dateTo") ?? "",
  });

  const rawGeo = c.req.query("geo");
  if (rawGeo !== undefined) {
    try {
      if (rawGeo.length > 262144) throw new Error("too large");
      filters.geo = geoPredicateSchema.parse(JSON.parse(rawGeo));
    } catch { return apiErrorResponse(c,400,"invalid_request","Invalid spatial predicate"); }
  }

  const deferred = await deferredRequestContext(c, projectId);
  if ("response" in deferred) return deferred.response;
  const effectiveLimit = clampSearchLimit(limit ? Number(limit) : undefined);
  return { userId, projectId, limit: effectiveLimit ?? DEFAULT_SEARCH_LIMIT, deferred: deferred.context,
    lookup: async () => ({ run: async () => publicSearchResponse(await withDeferredContext(deferred.context, () => hybridSearch(query, userId, {
      runId: runId || undefined,
      limit: effectiveLimit,
      ...flags,
      filters,
      variant: variant || undefined,
    }, authorized.scope))) }) };
}

/** POST input checks (already-parsed single-query body) and project authorization, answered before anything runs. */
async function preparePostSearch(c: Context, input: SearchInput): Promise<PreparedSearch | Response> {
  const userId = c.get("sessionUser")?.id;
  if (!userId) return apiErrorResponse(c, 401, "unauthorized", "Missing session");
  const projectId = await resolveActorProjectId(getRequestActor(c), input.project, input.orgId);
  const authorized = await authorizeProject(c, projectId);
  if (authorized instanceof Response) return authorized;
  const deferred = await deferredRequestContext(c, projectId);
  if ("response" in deferred) return deferred.response;
  // The route's access read stands in for the response cache's ticket lookup (same query, same request).
  const memo = createCacheScopeMemo();
  primeCacheScope(memo, userId, authorized.access);
  return { userId, projectId, limit: input.limit ?? DEFAULT_SEARCH_LIMIT, deferred: deferred.context,
    lookup: () => lookupRetrieve({ ...input, projectId }, authorized.scope, userId, requestApiKeyId(c), deferred.context, memo) };
}

/** An expected failure as the JSON response it always was; anything else is rethrown for the error envelope. */
function expectedFailureResponse(c: Context, error: unknown): Response {
  const failure = expectedSearchFailure(error);
  if (failure) return apiErrorResponse(c, failure.status, failure.apiCode, failure.message);
  throw error;
}

/** `stats` as a query value: absent is false, `true`/`1` and `false`/`0` are accepted, anything else is invalid. */
function parseStatsFlag(value: unknown): boolean | undefined {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

/**
 * `GET`/`POST /v1/search/stream`: the same search as `GET`/`POST /v1/search`,
 * as server-sent events (contract: packages/shared/src/search-stream.ts).
 *
 * Every refusal the JSON endpoint makes happens before the stream opens, with
 * the same status and body. The search starts before the stream does and the
 * stream opens at its first event (or when the search settles, whichever is
 * first), so a refusal the search itself raises before reporting anything
 * (a mode limit, no capacity, a bad scope) is still a real status, never a
 * 200 stream. Only a failure after the first event becomes `search.error`.
 */
async function searchStreamHandler(c: Context) {
  const handlerStart = performance.now();
  const fromBody = c.req.method === "POST";
  // A GET carries a cookie without any CSRF check, so a cross-site page could start (and bill) a search: same guard as GET /v1/chat/stream.
  if (!fromBody && getRequestActor(c).type === "session" && !sameOriginBrowserRequest(c)) {
    return apiErrorResponse(c, 403, "forbidden", "Cross-site request rejected");
  }
  let statsValue: unknown;
  let prepared: PreparedSearch | Response;
  if (fromBody) {
    const input = await c.req.json().catch(() => null);
    if (!input || typeof input !== "object" || Array.isArray(input)) return apiErrorResponse(c, 400, "invalid_request", "Invalid search input");
    if ("queries" in input) return apiErrorResponse(c, 400, "invalid_request", "Streaming search takes one query (q); use POST /v1/search for a queries batch.");
    const formError = searchFormError(input as Record<string, unknown>);
    if (formError) return apiErrorResponse(c, 400, "invalid_request", formError);
    const { stats, ...rest } = input as Record<string, unknown>;
    statsValue = stats;
    const parsed = searchInputSchema.safeParse(rest);
    if (!parsed.success) return apiErrorResponse(c, 400, "invalid_request", "Invalid search input", { issues: parsed.error.issues });
    if (parseStatsFlag(statsValue) === undefined) return apiErrorResponse(c, 400, "invalid_request", "Invalid search input: stats must be a boolean");
    prepared = await preparePostSearch(c, parsed.data);
  } else {
    statsValue = c.req.query("stats");
    if (parseStatsFlag(statsValue) === undefined) return apiErrorResponse(c, 400, "invalid_request", "Invalid stats: expected true or false");
    prepared = await prepareGetSearch(c);
  }
  if (prepared instanceof Response) return prepared;
  const stats = parseStatsFlag(statsValue) === true;
  const { projectId, deferred } = prepared;

  let lookup: SearchLookup;
  try {
    lookup = await prepared.lookup();
  } catch (error) {
    return expectedFailureResponse(c, error);
  }

  const searchId = randomUUID();
  const stamp = <T extends object>(event: T) => ({ ...event, searchId, seq: seq++, elapsedMs: Math.round(performance.now() - handlerStart) });
  let seq = 0;
  const started = stamp({ type: "search.started" as const, protocol: SEARCH_STREAM_PROTOCOL, projectId, cached: Boolean(lookup.hit) });

  type Outcome = { ok: true; data: SearchData } | { ok: false; error: unknown };
  type StreamEvent = Record<string, unknown> & { type: string; seq: number };
  // Aborts the search itself. A client disconnect aborts it only while nothing has been delivered (see onClientGone).
  const abort = new AbortController();
  // Events stamped before the stream is attached wait here; after it, each is written in order.
  const buffered: StreamEvent[] = [];
  let writeEvent: ((event: StreamEvent) => void) | null = null;
  let clientGone = false;
  // The search function has returned or thrown: no further event is stamped or kept.
  let settled = false;
  // A `search.hits` event with hits has been written: the client has seen passages, so the search must finish (and be charged).
  let contentDelivered = false;
  let detachTimer: ReturnType<typeof setTimeout> | undefined;
  let opened!: () => void;
  const firstEvent = new Promise<void>((resolve) => { opened = resolve; });

  const onClientGone = () => {
    if (clientGone) return;
    clientGone = true;
    if (settled) return;
    if (!contentDelivered) { abort.abort(); return; }
    // Delivered content is billed: let the search finish detached from the client, under an overall bound.
    detachTimer = setTimeout(() => abort.abort(), searchStreamDetachedTimeoutMs());
  };

  let outcome: Promise<Outcome>;
  if (lookup.hit) {
    settled = true;
    outcome = Promise.resolve({ ok: true, data: lookup.hit });
  } else {
    deferred.signal = abort.signal;
    const sink: SearchStreamSink = {
      stats,
      hitLimit: prepared.limit,
      emit(body) {
        if (settled || clientGone) return;
        const event = stamp(body) as StreamEvent;
        if (writeEvent) writeEvent(event);
        else { buffered.push(event); opened(); }
      },
    };
    outcome = withSearchStreamSink(sink, () => withSearchSignal(abort.signal, lookup.run))
      .then((data): Outcome => ({ ok: true, data }), (error: unknown): Outcome => ({ ok: false, error }))
      .then((result) => { settled = true; if (detachTimer) clearTimeout(detachTimer); return result; });
    const rawSignal = c.req.raw.signal;
    if (rawSignal.aborted) onClientGone();
    else rawSignal.addEventListener("abort", onClientGone, { once: true });
  }

  if (!lookup.hit) {
    // Opens at the first event, or once the search has settled. A failure before any event is the JSON endpoint's refusal.
    const first = await Promise.race([firstEvent.then(() => null), outcome]);
    if (first && !first.ok) {
      abort.abort();
      return expectedFailureResponse(c, first.error);
    }
  }

  const response = streamSSE(c, async (stream) => {
    const cached = Boolean(lookup.hit);
    let eventCount = 0;
    let bytes = 0;
    let ttfhMs: number | undefined;
    let sessionId: string | undefined;
    let label: "done" | "error" | "aborted" | "detached" = "aborted";
    let stalled = false;
    let pending = 0;
    let chain: Promise<unknown> = Promise.resolve();
    const enqueue = (frame: string, event?: StreamEvent) => {
      pending++;
      chain = chain.then(async () => {
        if (clientGone || stalled) return;
        if (event?.type === "search.hits" && Array.isArray(event.hits) && event.hits.length > 0 && ttfhMs === undefined) {
          contentDelivered = true;
          ttfhMs = Math.round(performance.now() - handlerStart);
        }
        await stream.write(frame);
        bytes += Buffer.byteLength(frame);
        if (event) eventCount++;
      }).catch(() => undefined).finally(() => { pending--; });
    };
    const send = (event: StreamEvent, retry?: number) => {
      enqueue(`event: ${event.type}\ndata: ${JSON.stringify(event)}\nid: ${event.seq}${retry === undefined ? "" : `\nretry: ${retry}`}\n\n`, event);
    };
    // Waits for queued writes, but not for a reader that has stopped reading.
    const flush = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flushed = await Promise.race([chain.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), SEARCH_STREAM_FLUSH_TIMEOUT_MS); })]);
      if (timer) clearTimeout(timer);
      if (!flushed && !clientGone) { stalled = true; stream.abort(); }
      return flushed;
    };
    stream.onAbort(onClientGone);
    const keepalive = setInterval(() => { if (pending === 0 && !clientGone && !stalled) enqueue(": keepalive\n\n"); }, SEARCH_STREAM_KEEPALIVE_MS);
    try {
      send(started);
      for (const event of buffered.splice(0)) send(event);
      writeEvent = send;
      const result = await outcome;
      writeEvent = null;
      if (clientGone) {
        // Nobody is listening. A detached search that failed is reported once, never written.
        if (!result.ok) await publicStreamError(c, result.error).catch(() => undefined);
        else sessionId = result.data.sessionId;
        label = contentDelivered ? "detached" : "aborted";
        return;
      }
      // Leg events first, in emission order, then the authoritative list.
      if (!await flush()) return;
      if (!result.ok) {
        send(stamp({ type: "search.error" as const, error: await publicStreamError(c, result.error) }), SEARCH_STREAM_RETRY_MS);
        if (await flush()) label = "error";
        return;
      }
      const data = result.data;
      sessionId = data.sessionId;
      try {
        const ids = data.results.map((item) => searchResultId(item));
        send(stamp({ type: "search.results" as const, ids, response: data }));
        const timings = stats && data.timings && typeof data.timings === "object"
          ? Object.fromEntries(Object.entries(data.timings as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number"))
          : undefined;
        send(stamp({ type: "search.done" as const, sessionId: data.sessionId, resultCount: data.results.length, ...(timings ? { timings } : {}) }), SEARCH_STREAM_RETRY_MS);
      } catch (error) {
        send(stamp({ type: "search.error" as const, error: await publicStreamError(c, error) }), SEARCH_STREAM_RETRY_MS);
        if (await flush()) label = "error";
        return;
      }
      if (await flush()) label = "done";
    } finally {
      clearInterval(keepalive);
      if (detachTimer) clearTimeout(detachTimer);
      c.req.raw.signal.removeEventListener("abort", onClientGone);
      const totalMs = Math.round(performance.now() - handlerStart);
      console.info(`[search-stream] searchId=${searchId} sessionId=${sessionId ?? "-"} requestId=${getRequestId(c) ?? "-"} outcome=${label} cached=${cached} ttfhMs=${ttfhMs ?? "-"} events=${eventCount} bytes=${bytes} totalMs=${totalMs}`);
    }
  });
  response.headers.set("Cache-Control", "no-cache, no-transform");
  response.headers.set("X-Accel-Buffering", "no");
  return response;
}

/** Quiet-stream comment cadence: proxies and load balancers close idle connections. */
const SEARCH_STREAM_KEEPALIVE_MS = 15_000;
/** Longest wait for queued writes to a reader that is not reading, once the search has settled. */
const SEARCH_STREAM_FLUSH_TIMEOUT_MS = 15_000;
/** SSE `retry:` on the closing frame: a native EventSource that forgets to close() waits a day, not 3 s, before re-running (and re-billing) the search. */
const SEARCH_STREAM_RETRY_MS = 24 * 60 * 60 * 1000;

/**
 * Overall bound on a search that outlives its client (it was billed once passages went out).
 * Statement timeouts and the slot limiter bound its parts but not the whole, so this aborts the remainder.
 */
function searchStreamDetachedTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SEARCH_STREAM_DETACHED_TIMEOUT_MS);
  return env.SEARCH_STREAM_DETACHED_TIMEOUT_MS?.trim() && Number.isFinite(parsed) && parsed >= 1000 ? Math.min(600_000, Math.trunc(parsed)) : 120_000;
}

/**
 * The code, public message and status the JSON endpoint would answer with for
 * this error. Raw error text goes to telemetry only.
 */
async function publicStreamError(c: Context, error: unknown): Promise<{ code: string; message: string; status: number }> {
  const expected = expectedSearchFailure(error);
  let response: Response;
  if (expected) {
    response = apiErrorResponse(c, expected.status, expected.apiCode, expected.message);
  } else {
    // Load shedding and disconnects are expected outcomes: keep them out of error reports (as searchError does).
    const quiet = error instanceof SearchCapacityError || error instanceof SearchModeLimitError || (error instanceof Error && error.name === "AbortError");
    if (!quiet) reportPublicError(error);
    const status = error instanceof SearchCapacityError ? 503 : error instanceof SearchModeLimitError ? 429
      : (error as { statusCode?: unknown } | null)?.statusCode;
    response = envelopeForError(c, error, typeof status === "number" ? status : 500);
  }
  const body = await response.clone().json().catch(() => null) as { error?: { code?: unknown; message?: unknown } } | null;
  return { code: typeof body?.error?.code === "string" ? body.error.code : "internal_error",
    message: typeof body?.error?.message === "string" ? body.error.message : PUBLIC_ERROR_MESSAGES.unexpected, status: response.status };
}

export const searchRoutes = new Hono()
  .use("*", nativeApiErrors)
  .get("/", async (c) => {
    const prepared = await prepareGetSearch(c);
    if (prepared instanceof Response) return prepared;
    try {
      return c.json(await (await prepared.lookup()).run());
    } catch (error) {
      return expectedFailureResponse(c, error);
    }
  })
  .get("/stream", searchStreamHandler)
  // The query travels in the body, not the URL, where proxies, logs and history keep it.
  .post("/stream", searchStreamHandler)
  .post("/", async (c) => {
    const input = await c.req.json().catch(() => null);
    // One query (`q`) or up to 20 (`queries`): the same endpoint serves both, never mixed.
    const formError = input && typeof input === "object" && !Array.isArray(input) ? searchFormError(input) : undefined;
    if (formError) return apiErrorResponse(c, 400, "invalid_request", formError);
    if (input && typeof input === "object" && "queries" in input) {
      const batch = batchSearchInputSchema.safeParse(input);
      if (!batch.success) return apiErrorResponse(c, 400, "invalid_request", "Invalid search input", { issues: batch.error.issues });
      const userId = c.get("sessionUser")?.id;
      if (!userId) return apiErrorResponse(c, 401, "unauthorized", "Missing session");
      return c.json({ results: await runSearchBatch(c, batch.data, userId) });
    }
    const parsed = searchInputSchema.safeParse(input);
    if (!parsed.success) {
      return apiErrorResponse(c, 400, "invalid_request", "Invalid search input", { issues: parsed.error.issues });
    }
    const prepared = await preparePostSearch(c, parsed.data);
    if (prepared instanceof Response) return prepared;
    try {
      const lookup = await prepared.lookup();
      return c.json(lookup.hit ?? await lookup.run());
    } catch (error) {
      return expectedFailureResponse(c, error);
    }
  })
  .post("/aggregate", async (c) => {
    const parsed = aggregateProjectRagSearchRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return apiErrorResponse(c, 400, "invalid_request", "Invalid search input", { issues: parsed.error.issues });
    }

    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorCanSearch(actor)) {
      return apiErrorResponse(c, 403, "forbidden", "Forbidden");
    }
    // A generated answer is a model call billed like chat, so it needs the
    // chat scope as well (the same scope /v1/chat checks). Refuse before any
    // project lookup or retrieval runs.
    // Browser keys never get aggregate answers: the answer path has no output
    // moderation and fans out across projects, which a public key must not reach.
    if (parsed.data.generateAnswer && actor.type === "apiKey" && (actor.apiKey.keyType !== "server" || !actorHasAnyApiKeyScope(actor, ["chat"]))) {
      return apiErrorResponse(c, 403, "forbidden", "Forbidden");
    }

    // An answer is a chat turn: it spends the chat-ai allowance and holds a
    // chat slot like /v1/chat (the path alone classifies it as search).
    let slot: { release: () => void } | "uncapped" = "uncapped";
    if (parsed.data.generateAnswer) {
      const limited = await enforceActorCategoryRateLimit(c, "chat-ai");
      if (limited) return limited;
      const acquired = await acquireChatSlot(c);
      if (acquired === "full" || acquired === "unavailable") return chatSlotRefusedResponse(c, acquired);
      slot = acquired;
    }

    try {
      // Each listed project may be a UUID, slug, former slug, name or
      // `default`; one that matches nothing answers 404 naming its slug.
      // One organization per search: the key's, else the one the session names, else its personal one.
      const orgId = actor.type === "apiKey" ? actor.apiKey.orgId : parsed.data.orgId ?? (await resolveDefaultOrganization(actor.userId)).id;
      if (actor.type === "apiKey" && parsed.data.orgId && parsed.data.orgId !== orgId) {
        return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      }
      const projects = await Promise.all(
        parsed.data.projects.map((project) => resolveActorProjectId(actor, project, orgId)),
      );
      const response = await aggregateProjectRagSearch({
        userId: actor.userId,
        orgId,
        request: { ...parsed.data, projects },
        apiKey: actor.type === "apiKey" ? actor.apiKey : null,
      });
      return c.json(response);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        return apiErrorResponse(c, 404, "project_not_found", "Project not found");
      }
      throw error;
    } finally {
      if (slot && slot !== "uncapped") slot.release();
    }
  })
  .post("/:sessionId/feedback", async (c) => {
    const { sessionId } = c.req.param();
    const body = await c.req.json<{ clickedChunkId?: string } | null>().catch(() => null);

    if (!body?.clickedChunkId) {
      return apiErrorResponse(c, 400, "invalid_request", "Missing clickedChunkId");
    }

    const userId = c.get("sessionUser")?.id;
    if (!userId) {
      return apiErrorResponse(c, 401, "unauthorized", "Missing session");
    }
    const actor = getRequestActor(c);
    const apiKey = actor.type === "apiKey" ? actor.apiKey : null;
    if (actor.type === "apiKey" && !actorCanSearch(actor)) {
      return apiErrorResponse(c, 403, "forbidden", "Forbidden");
    }

    // A write-behind search answers before its result rows commit.
    await awaitSearchSessionWrites(sessionId);
    await sql`
      update search_session_results
      set clicked = true
      where session_id = ${sessionId}
        and chunk_id = ${body.clickedChunkId}
        and exists (
          select 1
          from search_sessions s
          where s.id = search_session_results.session_id
            and s.user_id = ${userId}
            and (
              ${apiKey?.orgId ?? null}::text is null
              or exists (
                select 1
                from projects w
                where w.id = s.project_id
                  and w.org_id = ${apiKey?.orgId ?? null}
              )
            )
        )
    `;

    return c.json({ ok: true });
  });

/**
 * Non-streaming fallback for deferred search: the candidate pages of a past
 * search session and where each stands in the page ledger. Poll this when
 * `GET /v1/chat/stream` is unavailable or a search returned with pages
 * still materializing (`deferred.stoppedBy === "deadline"`).
 */
export const searchesRoutes = new Hono().get("/:sessionId/materialization", async (c) => {
  if (!deferredProfilesEnabled()) return apiErrorResponse(c, 404, "not_found", "Not found");
  const userId = c.get("sessionUser")?.id;
  if (!userId) return apiErrorResponse(c, 401, "unauthorized", "Missing session");
  const { sessionId } = c.req.param();
  await awaitSearchSessionWrites(sessionId);
  const [row] = await sql<{ project_id: string | null; candidates: unknown; deferred: unknown }[]>`
    select project_id,
           metadata -> 'diagnostics' -> 'deferredCandidates' as candidates,
           metadata -> 'deferred' as deferred
    from search_sessions
    where id = ${sessionId} and user_id = ${userId}
  `;
  if (!row?.project_id) return apiErrorResponse(c, 404, "not_found", "Search session not found");
  const forbidden = await assertApiKeyProjectAccess(c, row.project_id, "search");
  if (forbidden) return forbidden;
  const candidates = (Array.isArray(row.candidates) ? row.candidates : [])
    .filter((p): p is { documentId: string; page: number } =>
      typeof p?.documentId === "string" && Number.isInteger(p?.page))
    .map((p) => ({ documentId: p.documentId, page: p.page }));
  const states = await defaultMaterializeDeps.loadPageStates(candidates);
  const pages = candidates.map((p) => {
    const page = states.get(pageKey(p.documentId, p.page));
    // A page the worker refused because its document predates the current scan (PR #339): stable reason, never raw text.
    const rescan = page?.state === "failed" && page.failureReason === "source-unscanned";
    return { ...p, state: page?.state ?? "unseen", ...(rescan ? { reason: PARSE_SOURCE_RESCAN_REASON } : {}) };
  });
  const failed = pages.filter((p) => p.state === "failed" || p.state === "blocked-pii").length;
  const ready = pages.filter((p) => p.state === "indexed").length;
  return c.json({
    sessionId,
    deferred: row.deferred ?? null,
    pages,
    ready,
    failed,
    pending: pages.length - ready - failed,
    complete: pages.length - ready - failed === 0,
  });
});

acceptApiKeys(searchRoutes);
acceptApiKeys(searchesRoutes);
acceptApiKeys(projectChatRoutes, ["POST /", "GET /stream", "POST /stream"]);
