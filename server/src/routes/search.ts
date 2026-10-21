import { reportPublicError } from "../lib/public-errors.js";
import { apiErrorResponse, nativeApiErrors } from "../lib/api-error.js";
import { Hono, type Context } from "hono";
import { batchSearchInputSchema, searchFormError, searchInputSchema, searchOptions, workspaceChatInputSchema, type SearchInput } from "../lib/search-input.js";
import { streamSSE } from "hono/streaming";
import { assertCanSpend } from "../services/billing/spend-guard.js";

import { aggregateWorkspaceRagSearchRequestSchema, deferredProfilesEnabled, type ApiErrorCode } from "@docslurp/shared";

import {
  actorHasAnyApiKeyScope,
  assertApiKeyWorkspaceAccess,
  getRequestActor,
  resolveActorWorkspaceId,
} from "../lib/request-actor.js";
import { withDeferredContext, type DeferredRequestContext, type MaterializeEvent } from "../search/deferred/deferred-context.js";
import { defaultMaterializeDeps, pageKey } from "../search/deferred/materialize-client.js";
import { loadWorkspacePipeline } from "../search/session-setup.js";
import { resolveMaterializationPolicy } from "../services/materialization-policy.js";
import { aggregateWorkspaceRagSearch } from "../services/aggregate-rag.js";
import { WorkspaceAccessError } from "../services/default-workspace.js";
import { hybridSearch, MissingWorkspaceScopeError } from "../services/search.js";
import { chatWorkspace, workspaceChatDisabledBody } from "../services/workspace-chat.js";
import { parseFilters } from "../search/filters.js";
import { InvalidRetrievalQueryError, parseRetrievalQueryFlags } from "../lib/retrieval-query-flags.js";
import { publicSearchResponse } from "../lib/search-usage.js";
import { sql } from "../db.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { currentRequestApiKeyId } from "../lib/request-context.js";
import { SearchCapacityError } from "../search/search-limiter.js";
import { env } from "../config.js";
import { activeTraceparent } from "@docslurp/shared/observability";
import { chatModelRefused, ChatModelNotAllowedError } from "../lib/chat-model-policy.js";

function modelNotAllowed(c: Context): Response {
  return apiErrorResponse(c, 400, "model_not_allowed", new ChatModelNotAllowedError().message);
}

/** Runs each validated query, preserving input order and per-item errors. */
async function runSearchBatch(c: Context, parsed: { queries: SearchInput[]; concurrency: number }, userId: string): Promise<BatchResult[]> {
  const { queries, concurrency } = parsed;
  const signal = c.req.raw.signal;
  const results: BatchResult[] = queries.map(() => ({ ok: false,
    error: { code: "REQUEST_ABORTED", message: "Request aborted before search started", status: 499 } }));
  let next = 0;
  async function worker() {
    while (!signal.aborted && next < queries.length) {
      const index = next++;
      const query = queries[index]!;
      try {
        const input = { ...query, workspaceId: await resolveActorWorkspaceId(getRequestActor(c), query.workspaceId, query.orgId) };
        const forbidden = await assertApiKeyWorkspaceAccess(c, input.workspaceId, "search");
        if (forbidden) {
          results[index] = { ok: false, error: {
            code: forbidden.status === 403 ? "FORBIDDEN" : "WORKSPACE_NOT_FOUND",
            message: forbidden.status === 403 ? "Forbidden" : "Workspace not found", status: forbidden.status } };
        } else if (!signal.aborted) {
          const deferred = await deferredRequestContext(c, input.workspaceId);
          if ("response" in deferred) {
            const status = deferred.response.status;
            results[index] = { ok: false, error: { code: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", message: "Search capability rejected", status } };
          } else {
            results[index] = { ok: true, data: await retrieve(input, userId, deferred.context) };
          }
        }
      } catch (error) {
        results[index] = { ok: false, error: searchError(error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queries.length) }, () => worker()));
  return results;
}

function clampSearchLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.min(100, Math.floor(value)));
}

/** API-key scope and workspace checks, answered in the native error envelope. */
async function denyWorkspaceAccess(c: Context, workspaceId: string): Promise<Response | null> {
  const denied = await assertApiKeyWorkspaceAccess(c, workspaceId, "search");
  if (!denied) return null;
  return denied.status === 403
    ? apiErrorResponse(c, 403, "forbidden", "Forbidden")
    : apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
}

const CAPABILITY_ERRORS = {
  capability_invalid: { status: 401, message: "Search capability is invalid" },
  capability_expired: { status: 401, message: "Search capability has expired" },
  capability_origin: { status: 403, message: "Search capability is not valid for this origin" },
  capability_scope: { status: 403, message: "Search capability does not cover this workspace" },
} as const;

/**
 * Request-scoped deferred-search inputs: the presenting API key (so client-key
 * defaults apply) and, when an `X-DocSlurp-Capability` header is sent, its
 * policy, validated up front so a bad token is a 401/403 and not a silent
 * downgrade. Inert unless DOCSLURP_DEFERRED_PROFILES=1.
 */
async function deferredRequestContext(
  c: Context,
  workspaceId: string,
  onEvent?: (event: MaterializeEvent) => void,
): Promise<{ context: DeferredRequestContext } | { response: Response }> {
  const actor = getRequestActor(c);
  const context: DeferredRequestContext = { apiKey: actor?.type === "apiKey" ? actor.apiKey : null, ...(onEvent ? { onEvent } : {}) };
  const capability = c.req.header("X-DocSlurp-Capability")?.trim();
  if (deferredProfilesEnabled() && capability) {
    const resolved = await resolveMaterializationPolicy({
      workspacePipeline: await loadWorkspacePipeline(workspaceId),
      apiKey: context.apiKey ?? null,
      capabilityHeader: capability,
      origin: c.req.header("Origin") ?? null,
      workspaceId,
    });
    if ("error" in resolved) {
      const { status, message } = CAPABILITY_ERRORS[resolved.error];
      return { response: apiErrorResponse(c, status, status === 401 ? "unauthorized" : "forbidden", message, { category: resolved.error }) };
    }
    context.policy = resolved.policy;
  }
  return { context };
}

/** `grounded` is the nested MCP tool target: retrieval-only, never another agent or a settings change. */
async function handleWorkspaceChat(c: Context, mode: "public" | "grounded") {
  // Lets clients join a turn to its trace (the trace id is the second field).
  const traceparent = activeTraceparent();
  if (traceparent) c.header("traceparent", traceparent);
  const parsed = workspaceChatInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return apiErrorResponse(c, 400, "invalid_request", "Invalid chat input", { issues: parsed.error.issues });
  const body = parsed.data;
  const userId = c.get("sessionUser")?.id;
  if (!userId) return apiErrorResponse(c, 401, "unauthorized", "Missing session");
  const workspaceId = await resolveActorWorkspaceId(getRequestActor(c), body.workspaceId, body.orgId);
  const forbidden = await denyWorkspaceAccess(c, workspaceId);
  if (forbidden) return forbidden;
  const chatDisabled = await workspaceChatDisabledBody(workspaceId, userId);
  if (chatDisabled) return apiErrorResponse(c, 403, "chat_disabled", chatDisabled.error);
  const deferred = await deferredRequestContext(c, workspaceId);
  if ("response" in deferred) return deferred.response;
  let response: Awaited<ReturnType<typeof chatWorkspace>>;
  try {
    response = await withDeferredContext(deferred.context, () => chatWorkspace({ workspaceId, userId,
      query: body.q, sessionId: body.sessionId, model: body.model,
      actor: getRequestActor(c), signal: c.req.raw.signal,
      ...(mode === "grounded"
        ? { allowAgentTools: false, allowConfiguration: false }
        : { allowAgentTools: env.publicChatAgentEnabled, ...(body.agent ? { agent: body.agent } : {}) }),
      ...(body.retrieval ? { retrieval: body.retrieval } : {}),
      ...(body.filters ? { filters: body.filters } : {}) }));
  } catch (error) {
    if (error instanceof ChatModelNotAllowedError) return modelNotAllowed(c);
    throw error;
  }
  return c.json(response);
}

const workspaceChatHandler = (c: Context) => handleWorkspaceChat(c, "public");

export const workspaceChatRoutes = new Hono().use("*", nativeApiErrors).post("/", workspaceChatHandler);
/** Internal tool target only. Never mount this router as a public agent entrypoint. */
export const groundedWorkspaceChatRoutes = new Hono().use("*", nativeApiErrors).post("/", (c: Context) => handleWorkspaceChat(c, "grounded"));

type SearchData = ReturnType<typeof publicSearchResponse>;
type BatchResult = { ok: true; data: SearchData } | { ok: false; error: { code: string; message: string; status: number } };
type SearchFailure = { code: string; apiCode: ApiErrorCode; message: string; status: 400 | 403 | 404 };
/** `code` is the per-item batch code; `apiCode` is the envelope code of a whole-request failure. */
function expectedSearchFailure(error: unknown): SearchFailure | null {
  if (error instanceof InvalidRetrievalQueryError) {
    return { code: "INVALID_RETRIEVAL_QUERY", apiCode: "invalid_request", message: error.message, status: 400 };
  }
  if (error instanceof WorkspaceAccessError) {
    return error.status === 403
      ? { code: "FORBIDDEN", apiCode: "forbidden", message: error.message, status: 403 }
      : { code: "WORKSPACE_NOT_FOUND", apiCode: "workspace_not_found", message: error.message, status: 404 };
  }
  if (error instanceof MissingWorkspaceScopeError || (error instanceof Error && error.message === "Search scope must stay within a single workspace")) {
    return { code: "INVALID_SEARCH_SCOPE", apiCode: "invalid_search_scope", message: error.message, status: 400 };
  }
  if (error instanceof Error && error.message === "Workspace not found") {
    return { code: "WORKSPACE_NOT_FOUND", apiCode: "workspace_not_found", message: error.message, status: 404 };
  }
  return null;
}
function searchError(error: unknown): { code: string; message: string; status: 400 | 403 | 404 | 499 | 500 | 503 } {
  // Load shedding and disconnects are expected outcomes, not internal failures: keep them out of error reports.
  if (error instanceof SearchCapacityError) return { code: "SEARCH_UNAVAILABLE", message: "Search capacity is full; retry shortly", status: 503 };
  if (error instanceof Error && error.name === "AbortError") return { code: "REQUEST_ABORTED", message: "Request aborted before search finished", status: 499 };
  return expectedSearchFailure(error) ?? { code: "SEARCH_FAILED", message: reportPublicError(error), status: 500 };
}
/**
 * Identical searches repeat constantly (type-ahead, popular questions), so a
 * complete answer is reused for a short window instead of re-running
 * embedding, vector and text retrieval. The key holds the user, the API key and
 * the whole normalized request, so answers never cross callers, workspaces or
 * options. Workspace and key checks still run on every request (route), and a
 * reused answer reports no new usage. SEARCH_RESPONSE_CACHE_TTL_MS=0 disables it.
 */
const SEARCH_CACHE_MAX = 500;
const searchCache = new Map<string, { at: number; data: SearchData }>();
function searchCacheTtlMs(): number {
  const value = Number.parseInt(process.env.SEARCH_RESPONSE_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(value) && value >= 0) return value;
  return process.env.NODE_ENV === "test" ? 0 : 30_000;
}

export function clearSearchResponseCacheForTests(): void {
  searchCache.clear();
}

async function retrieve(body: SearchInput & { workspaceId: string }, userId: string, deferred?: DeferredRequestContext): Promise<SearchData> {
  // A capability changes the policy a cached answer was produced under: never share across it.
  const ttl = deferred?.policy ? 0 : searchCacheTtlMs();
  const key = JSON.stringify([userId, currentRequestApiKeyId(), { ...body, q: body.q.trim().replace(/\s+/g, " ") }]);
  const cached = ttl > 0 ? searchCache.get(key) : undefined;
  if (cached && Date.now() - cached.at < ttl) {
    searchCache.delete(key);
    searchCache.set(key, cached);
    return {
      ...cached.data,
      usage: { ...cached.data.usage, inputTokens: 0, outputTokens: 0, totalTokens: 0, costCents: 0, costSource: "none" },
      timings: { cachedMs: 0, totalMs: 0 },
    };
  }
  const search = () => hybridSearch(body.q, userId, searchOptions(body));
  const data = publicSearchResponse(await (deferred ? withDeferredContext(deferred, search) : search()));
  // A response with pages still materializing must not be replayed as final.
  if (ttl > 0 && data.availability?.status === "complete" && !(data.deferred && data.deferred.pendingPages > 0)) {
    searchCache.set(key, { at: Date.now(), data });
    if (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value!);
  }
  return data;
}

export const searchRoutes = new Hono()
  .use("*", nativeApiErrors)
  .get("/chat/stream", async (c) => {
    const parsed = workspaceChatInputSchema.safeParse({ q: c.req.query("q"),
      workspaceId: c.req.query("workspaceId") || undefined, orgId: c.req.query("orgId") || undefined,
      sessionId: c.req.query("sessionId"), model: c.req.query("model") });
    if (!parsed.success) return apiErrorResponse(c, 400, "invalid_request", "Invalid chat input", { issues: parsed.error.issues });
    const { q: query, sessionId, model } = parsed.data;

    const userId = c.get("sessionUser").id;
    const workspaceId = await resolveActorWorkspaceId(getRequestActor(c), parsed.data.workspaceId, parsed.data.orgId);
    const forbidden = await denyWorkspaceAccess(c, workspaceId);
    if (forbidden) return forbidden;
    const chatDisabled = await workspaceChatDisabledBody(workspaceId, userId);
    if (chatDisabled) return apiErrorResponse(c, 403, "chat_disabled", chatDisabled.error);
    if (await chatModelRefused(getRequestActor(c), model, workspaceId)) return modelNotAllowed(c);
    // Refuse before the stream opens, so a blocked spend is a 402.
    // Pre-check only: chatWorkspace takes the interactive hold.
    await assertCanSpend(null, workspaceId, { kind: "interactive", hold: false });
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");

    // Validated before the stream opens, so a bad capability is a real 401/403.
    // Events are chained so they reach the client in order, ahead of `message`.
    let pendingEvents: Promise<unknown> = Promise.resolve();
    let sink: (event: MaterializeEvent) => void = () => undefined;
    const deferred = await deferredRequestContext(c, workspaceId, (event) => sink(event));
    if ("response" in deferred) return deferred.response;

    return streamSSE(c, async (stream) => {
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
          message: "Retrieving workspace context"
        })
      });

      const response = await withDeferredContext(deferred.context, () => chatWorkspace({
        workspaceId,
        userId,
        query,
        actor: getRequestActor(c), allowAgentTools: env.publicChatAgentEnabled, signal: c.req.raw.signal,
        sessionId,
        model
      }));
      await pendingEvents;

      await stream.writeSSE({
        event: "message",
        data: JSON.stringify(response)
      });
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          id: response.id,
          sessionId: response.sessionId,
          searchSessionId: response.searchSessionId
        })
      });
    });
  })
  .post("/chat", workspaceChatHandler)
  .get("/", async (c) => {
    const query = c.req.query("q");
    if (!query) {
      return apiErrorResponse(c, 400, "invalid_request", "Missing query parameter 'q'");
    }

    const userId = c.get("sessionUser")?.id;
    if (!userId) {
      return apiErrorResponse(c, 401, "unauthorized", "Missing session");
    }
    const workspaceId = await resolveActorWorkspaceId(
      getRequestActor(c),
      c.req.query("workspaceId"),
      c.req.query("orgId"),
    );
    const forbidden = await denyWorkspaceAccess(c, workspaceId);
    if (forbidden) return forbidden;
    const runId = c.req.query("runId");
    const limit = c.req.query("limit");
    const variant = c.req.query("variant");

    // Retrieval flags are tri-state: omitted flags fall back to the workspace's
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
      workspaceId,
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

    const deferred = await deferredRequestContext(c, workspaceId);
    if ("response" in deferred) return deferred.response;
    try {
      const response = await withDeferredContext(deferred.context, () => hybridSearch(query, userId, {
        runId: runId || undefined,
        limit: clampSearchLimit(limit ? Number(limit) : undefined),
        ...flags,
        filters,
        variant: variant || undefined,
      }));
      return c.json(publicSearchResponse(response));
    } catch (error) {
      const failure = expectedSearchFailure(error);
      if (failure) return apiErrorResponse(c, failure.status, failure.apiCode, failure.message);
      throw error;
    }
  })
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
    const userId = c.get("sessionUser")?.id;
    if (!userId) return apiErrorResponse(c, 401, "unauthorized", "Missing session");
    const workspaceId = await resolveActorWorkspaceId(getRequestActor(c), parsed.data.workspaceId, parsed.data.orgId);
    const forbidden = await denyWorkspaceAccess(c, workspaceId);
    if (forbidden) return forbidden;
    const deferred = await deferredRequestContext(c, workspaceId);
    if ("response" in deferred) return deferred.response;
    try {
      return c.json(await retrieve({ ...parsed.data, workspaceId }, userId, deferred.context));
    } catch (error) {
      const failure = expectedSearchFailure(error);
      if (failure) return apiErrorResponse(c, failure.status, failure.apiCode, failure.message);
      throw error;
    }
  })
  .post("/aggregate", async (c) => {
    const parsed = aggregateWorkspaceRagSearchRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return apiErrorResponse(c, 400, "invalid_request", "Invalid search input", { issues: parsed.error.issues });
    }

    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["search"])) {
      return apiErrorResponse(c, 403, "forbidden", "Forbidden");
    }

    try {
      // Each listed reference may be a UUID, slug, former slug or `default`;
      // unknown ones pass through so the service answers 404.
      const workspaceIds = await Promise.all(
        parsed.data.workspaceIds.map((workspaceId) => resolveActorWorkspaceId(actor, workspaceId)),
      );
      const response = await aggregateWorkspaceRagSearch({
        userId: actor.userId,
        request: { ...parsed.data, workspaceIds },
        apiKey: actor.type === "apiKey" ? actor.apiKey : null,
      });
      return c.json(response);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Workspace not found")) {
        return apiErrorResponse(c, 404, "workspace_not_found", "Workspace not found");
      }
      throw error;
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
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["search"])) {
      return apiErrorResponse(c, 403, "forbidden", "Forbidden");
    }

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
                from workspaces w
                where w.id = s.metadata ->> 'workspaceId'
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
 * `GET /v1/search/chat/stream` is unavailable or a search returned with pages
 * still materializing (`deferred.stoppedBy === "deadline"`).
 */
export const searchesRoutes = new Hono().get("/:sessionId/materialization", async (c) => {
  if (!deferredProfilesEnabled()) return apiErrorResponse(c, 404, "not_found", "Not found");
  const userId = c.get("sessionUser")?.id;
  if (!userId) return apiErrorResponse(c, 401, "unauthorized", "Missing session");
  const { sessionId } = c.req.param();
  const [row] = await sql<{ workspace_id: string | null; candidates: unknown; deferred: unknown }[]>`
    select metadata ->> 'workspaceId' as workspace_id,
           metadata -> 'diagnostics' -> 'deferredCandidates' as candidates,
           metadata -> 'deferred' as deferred
    from search_sessions
    where id = ${sessionId} and user_id = ${userId}
  `;
  if (!row?.workspace_id) return apiErrorResponse(c, 404, "not_found", "Search session not found");
  const forbidden = await assertApiKeyWorkspaceAccess(c, row.workspace_id, "search");
  if (forbidden) return forbidden;
  const candidates = (Array.isArray(row.candidates) ? row.candidates : [])
    .filter((p): p is { documentId: string; page: number } =>
      typeof p?.documentId === "string" && Number.isInteger(p?.page))
    .map((p) => ({ documentId: p.documentId, page: p.page }));
  const states = await defaultMaterializeDeps.loadPageStates(candidates);
  const pages = candidates.map((p) => ({ ...p, state: states.get(pageKey(p.documentId, p.page))?.state ?? "unseen" }));
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
acceptApiKeys(workspaceChatRoutes, ["POST /"]);
