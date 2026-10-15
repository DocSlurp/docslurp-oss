import { errorContext } from "./error-context.js";
import { withObservation, addTraceMetadata, withHttpSpan } from "@docslurp/shared/observability";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { routePath } from "hono/route";

import type { Context } from "hono";
import type { MiddlewareHandler } from "hono";
import { sql } from "../db.js";
import { emitPostHogApiLog } from "./posthog-ai-observability.js";
import { httpResponseStats } from "./http-response-stats.js";
import { clientIpFromHeaders, isInProcessEnv } from "./client-ip.js";
import { redactFileTokenPath } from "./file-token-path.js";

const REQUEST_ID_HEADER = "X-Request-ID";
const requestContextStorage = new AsyncLocalStorage<{
  requestId: string;
  requestStartedAt: number;
  userId: string | null;
  apiKeyId?: string | null;
  /** The Better Auth session behind a cookie-authenticated request; file URLs bind to it. */
  sessionId?: string | null;
  /** The API key actor's workspace allowlist; null when unrestricted or not a key. */
  apiKeyWorkspaceIds?: readonly string[] | null;
  performanceEvents: Array<{
    scope: string;
    stageName: string;
    metric: string;
    value: number;
    unit: string;
    tags: string[];
    metadata?: Record<string, unknown>;
  }>;
}>();

// Request diagnostics are best effort, unlike the durable AI usage ledger. Bound
// both response delay and concurrent writes if the diagnostics database stalls.
const PERFORMANCE_FLUSH_DEADLINE_MS = 100;
const MAX_PENDING_PERFORMANCE_FLUSHES = 10;
let pendingPerformanceFlushes = 0;

async function flushPerformanceEvents(
  userId: string,
  requestId: string,
  events: NonNullable<ReturnType<typeof requestContextStorage.getStore>>["performanceEvents"],
): Promise<string> {
  if (pendingPerformanceFlushes >= MAX_PENDING_PERFORMANCE_FLUSHES) return "capacity-skipped";
  pendingPerformanceFlushes += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = sql`
      insert into performance_log (
        id, user_id, run_id, document_id, scope, stage_name, metric,
        page_number, value, unit, tags, metadata
      )
      select id, ${userId}, null, null, scope, stage_name, metric,
        null, value, unit, tags, metadata
      -- sql.json: a JSON.stringify'd string is re-encoded as a JSON *string*, which
      -- jsonb_to_recordset rejects ("non-array"), silently dropping every flush.
      from jsonb_to_recordset(${sql.json(events.map(event => ({
        id: randomUUID(),
        scope: event.scope,
        stage_name: event.stageName,
        metric: event.metric,
        value: event.value,
        unit: event.unit,
        tags: event.tags,
        metadata: { ...(event.metadata ?? {}), requestId },
      })) as never)}::jsonb) as event(
        id text, scope text, stage_name text, metric text, value double precision,
        unit text, tags text[], metadata jsonb
      )
    `;
    // Keep the slot until the write actually settles, including after timeout.
    // Never cancel the query on timeout: a Postgres cancel request targets the
    // backend process, not this statement. The pool pipelines queries from many
    // requests on one connection, so by the time the cancel arrives the backend
    // is usually running another request's statement, which then fails with
    // "canceling statement due to user request" (burst-upload HTTP 500s and
    // orphan queued runs in the 2026-10-09 load test). The pending cap bounds
    // abandoned writes instead.
    const completion = Promise.resolve(query).then(
      () => "persisted",
      (error: unknown) => {
        console.error("[api] request performance flush failed:", error instanceof Error ? error.message : String(error));
        return "failed";
      },
    ).finally(() => { pendingPerformanceFlushes -= 1; });
    return await Promise.race([
      completion,
      new Promise<string>(resolve => {
        timer = setTimeout(() => resolve("timeout"), PERFORMANCE_FLUSH_DEADLINE_MS);
      }),
    ]);
  } catch (error) {
    pendingPerformanceFlushes -= 1;
    console.error("[api] request performance flush failed:", error instanceof Error ? error.message : String(error));
    return "failed";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getRequestId(c: Context): string | null {
  const value = c.get("requestId");
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function currentRequestId(): string | null {
  return requestContextStorage.getStore()?.requestId ?? null;
}

export function setCurrentRequestUserId(userId: string | null | undefined): void {
  const store = requestContextStorage.getStore();
  if (!store) {
    return;
  }
  store.userId = userId?.trim() || null;
  const reportContext = errorContext.getStore();
  if (reportContext) reportContext.userId = store.userId ?? undefined;
  addTraceMetadata({ userId: store.userId });
}

/** Records the authenticating API key so usage recorded during this request is attributed to it. */
export function setCurrentRequestApiKeyId(apiKeyId: string | null | undefined): void {
  const store = requestContextStorage.getStore();
  if (store) store.apiKeyId = apiKeyId ?? null;
}

export function currentRequestApiKeyId(): string | null {
  return requestContextStorage.getStore()?.apiKeyId ?? null;
}

/** Records the cookie session so file URLs minted in this request are bound to it. */
export function setCurrentRequestSessionId(sessionId: string | null | undefined): void {
  const store = requestContextStorage.getStore();
  if (store) store.sessionId = sessionId || null;
}

export function currentRequestSessionId(): string | null {
  return requestContextStorage.getStore()?.sessionId ?? null;
}

export function currentRequestUserId(): string | null {
  return requestContextStorage.getStore()?.userId ?? null;
}

/**
 * Records the request's API key workspace allowlist (empty = unrestricted).
 * Workspace access queries (organizations.ts) intersect with it, so services
 * that only take a userId still honor a key bound to specific workspaces.
 */
export function setCurrentRequestApiKeyWorkspaceIds(workspaceIds: readonly string[] | null | undefined): void {
  const store = requestContextStorage.getStore();
  if (store) store.apiKeyWorkspaceIds = workspaceIds?.length ? [...workspaceIds] : null;
}

export function currentRequestApiKeyWorkspaceIds(): readonly string[] | null {
  return requestContextStorage.getStore()?.apiKeyWorkspaceIds ?? null;
}

export function pushRequestPerformanceEvent(event: {
  scope: string;
  stageName: string;
  metric: string;
  value: number;
  unit: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): void {
  const store = requestContextStorage.getStore();
  if (!store) {
    return;
  }

  store.performanceEvents.push({
    scope: event.scope,
    stageName: event.stageName,
    metric: event.metric,
    value: event.value,
    unit: event.unit,
    tags: event.tags ?? [],
    metadata: event.metadata
  });
}

/** The edge-derived client address (see `clientIpFromHeaders`). */
export function requestIp(c: Context): string | null {
  return clientIpFromHeaders((name) => c.req.header(name), { trustedInternal: isInProcessEnv(c.env) });
}

export function requestUserAgent(c: Context): string | null {
  return c.req.header("user-agent") ?? null;
}

const INFRA_PROBE_ROUTES = new Set(["/health", "/ready", "/metrics", "/fly-scaler-metrics"]);

export const requestContextMiddleware: MiddlewareHandler = async (c, next) => {
  const requestId = c.req.header(REQUEST_ID_HEADER)?.trim() || c.req.header("x-request-id")?.trim() || randomUUID();
  const startedAt = Date.now();
  const cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  // File proxy tokens never reach logs or telemetry.
  const pathname = redactFileTokenPath(new URL(c.req.url).pathname);
  // The current route is this middleware's wildcard; the final match is the
  // endpoint template, including prefixes from mounted routers.
  const matchedPath = routePath(c, -1);
  const route = matchedPath && matchedPath !== "*" && matchedPath !== "/*" ? matchedPath : "unmatched";
  // Status polling and SSE connection lifetimes are ordinary HTTP telemetry,
  // not AI work. Their duration must not pollute Langfuse latency observations.
  // Infrastructure probes (Fly checks, autoscaler scrapes) would otherwise flood it.
  const pollingRequest = c.req.method === "GET" && (
    /\/runs\/:[^/]+(?:\/(?:progress|events))?$/.test(route)
    || /\/ai-operations\/:[^/]+$/.test(route)
    || INFRA_PROBE_ROUTES.has(route)
  );

  await errorContext.run({ requestId }, () => withHttpSpan({ method: c.req.method, route,
    headers: { traceparent: c.req.header("traceparent") ?? "", tracestate: c.req.header("tracestate") ?? "" },
    status: () => c.res.status,
  }, () => requestContextStorage.run({ requestId, requestStartedAt: startedAt, userId: null, performanceEvents: [] }, async () => {
    c.set("requestId", requestId);
    c.set("requestStartedAt", startedAt);
    c.header(REQUEST_ID_HEADER, requestId);

    let thrownError: unknown = null;

    try {
      if (pollingRequest) await next();
      else await withObservation({ name: `api.${c.req.method}.${route}`,
        metadata: { requestId, method: c.req.method, path: pathname, route },
        result: () => ({ metadata: { status: c.res.status }, ...(c.res.status >= 500 ? { level: "ERROR" as const } : {}) }),
      }, next);
    } catch (error) {
      thrownError = error;
      throw error;
    } finally {
      const status =
        thrownError && typeof thrownError === "object" && "status" in thrownError && typeof thrownError.status === "number"
          ? thrownError.status
          : thrownError
            ? 500
            : c.res.status;
      httpResponseStats.record(status);
      const durationMs = Date.now() - startedAt;
      const cpu = process.cpuUsage(cpuStart);
      const rssDeltaBytes = process.memoryUsage().rss - rssStart;

      pushRequestPerformanceEvent({
        scope: "request",
        stageName: route,
        metric: "request-handler-duration",
        value: durationMs,
        unit: "ms",
        tags: ["api", "request"],
        metadata: { method: c.req.method, status, requestId, path: pathname, route, measurement: "handler-before-telemetry" }
      });
      pushRequestPerformanceEvent({
        scope: "request",
        stageName: route,
        metric: "request-cpu-user",
        value: cpu.user / 1000,
        unit: "ms",
        tags: ["api", "request", "cpu", "process-shared"],
        metadata: { method: c.req.method, status, requestId, path: pathname, route }
      });
      pushRequestPerformanceEvent({
        scope: "request",
        stageName: route,
        metric: "request-cpu-system",
        value: cpu.system / 1000,
        unit: "ms",
        tags: ["api", "request", "cpu", "process-shared"],
        metadata: { method: c.req.method, status, requestId, path: pathname, route }
      });
      pushRequestPerformanceEvent({
        scope: "request",
        stageName: route,
        metric: "request-rss-delta",
        value: rssDeltaBytes,
        unit: "byte",
        tags: ["api", "request", "memory", "rss", "process-shared"],
        metadata: { method: c.req.method, status, requestId, path: pathname, route }
      });

      const store = requestContextStorage.getStore();
      const flushStartedAt = Date.now();
      let flushOutcome = "not-applicable";
      if (store?.userId && store.performanceEvents.length > 0) {
        flushOutcome = await flushPerformanceEvents(store.userId, requestId, store.performanceEvents);
      }
      const flushDurationMs = Date.now() - flushStartedAt;
      const finalDurationMs = Date.now() - startedAt;

      const level = status >= 500 ? console.error : status >= 400 ? console.warn : console.log;
      level(`[api] requestId=${requestId} method=${c.req.method} path=${pathname} status=${status} duration_ms=${finalDurationMs} handler_duration_ms=${durationMs} telemetry_flush_ms=${flushDurationMs} telemetry_flush=${flushOutcome}`);
      emitPostHogApiLog({
        severityText: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        body: "api_request_completed",
        attributes: {
          http_request_method: c.req.method,
          http_route: route,
          http_response_status_code: status,
          duration_ms: finalDurationMs,
          handler_duration_ms: durationMs,
          telemetry_flush_ms: flushDurationMs,
          telemetry_flush: flushOutcome,
        },
      });
    }
  })));
};
