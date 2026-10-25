import { hasSharedLogProvider } from "./telemetry-state.js";
import { isCancellation } from "./cancellation.js";

export { isCancellation };
// Server-only: exceptions belong in telemetry, never in response payloads.
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";

/** Scrub credentials without discarding the actionable cause or stack. */
export function redactExceptionText(value: string): string {
  return value
    .replace(/(?:Bearer|Basic)\s+\S+/gi, "[authorization redacted]")
    .replace(/\b(?:sk|sk-or-v1|sk_live|sk_test|rk_live|rk_test)[-_][A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/((?:password|secret|api[ _-]?key|token|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,"'}&]+/gi, "$1[redacted]")
    .replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@")
    .slice(0, 16000);
}

export function exceptionDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (depth >= 6) return { message: "[cause depth limit]" };
  if (!(error instanceof Error)) return { message: redactExceptionText(String(error)) };
  return {
    type: redactExceptionText(error.name),
    message: redactExceptionText(error.message),
    stacktrace: redactExceptionText(error.stack ?? ""),
    ...(error.cause !== undefined ? { cause: exceptionDetails(error.cause, depth + 1) } : {}),
    ...("code" in error ? { code: redactExceptionText(String(error.code)) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.slice(0, 10).map(cause => exceptionDetails(cause, depth + 1)) } : {}),
  };
}

let workerLoggerProvider: LoggerProvider | undefined;
/** API uses its existing OTLP provider; standalone workers initialise their own. */
export function initializeWorkerErrorReporting(): void {
  if (hasSharedLogProvider() || workerLoggerProvider || process.env.NODE_ENV === "test") return;
  const token = process.env.PUBLIC_POSTHOG_PROJECT_TOKEN?.trim();
  const endpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim() || process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  // PostHog log ingestion is opt-in: it needs both the project token and an explicit POSTHOG_HOST.
  // There is no default host, so a fresh or self-hosted install never reports to a DocSlurp-owned endpoint.
  const posthogHost = process.env.POSTHOG_HOST?.trim();
  if (!endpoint && !(token && posthogHost)) return;
  try {
    workerLoggerProvider = new LoggerProvider({
      resource: resourceFromAttributes({ "service.name": "docslurp-worker" }),
      processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter(endpoint ? {} : {
        url: new URL("/i/v1/logs", posthogHost).toString(), headers: { Authorization: `Bearer ${token}` },
      }) })],
    });
    process.once("beforeExit", () => { void workerLoggerProvider?.shutdown().catch(() => {}); });
  } catch { console.warn("[telemetry] exception exporter unavailable"); }
}

export async function flushErrorReporting(): Promise<void> {
  try { await workerLoggerProvider?.forceFlush(); } catch { /* best effort */ }
}

/** `signal` is the caller's request signal: an error that is its abort reason is a cancel, not a failure. */
export function reportException(error: unknown, attributes: Record<string, string | number | boolean> = {}, signal?: AbortSignal): void {
  const details = exceptionDetails(error);
  const safeAttributes = Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, typeof value === "string" ? redactExceptionText(value) : value]));
  if (isCancellation(error, signal)) return reportCancellation(safeAttributes);
  try { console.error("[public-error]", { ...safeAttributes, exception: details }); } catch { /* best effort */ }
  try {
    const span = trace.getActiveSpan();
    span?.recordException({ name: String(details.type ?? "Error"), message: String(details.message), stack: String(details.stacktrace ?? "") });
    span?.setStatus({ code: SpanStatusCode.ERROR });
    const logger = hasSharedLogProvider() ? logs.getLogger("docslurp.errors")
      : workerLoggerProvider?.getLogger("docslurp.errors") ?? logs.getLogger("docslurp.errors");
    logger.emit({ severityNumber: 17, severityText: "ERROR", body: "public_operation_failed", attributes: {
      ...safeAttributes,
      "exception.type": String(details.type ?? "Error"),
      "exception.message": String(details.message),
      "exception.stacktrace": String(details.stacktrace ?? ""),
      "exception.causes": JSON.stringify(details.cause ?? null).slice(0, 64000),
      "exception.details": JSON.stringify(details).slice(0, 64000),
    } });
  } catch { /* telemetry must never replace the original failure */ }
}

/** The caller cancelled: an INFO outcome with its own span attribute, never an ERROR status or exception. */
function reportCancellation(attributes: Record<string, string | number | boolean>): void {
  try { console.info("[public-info] operation cancelled by caller", attributes); } catch { /* best effort */ }
  try {
    trace.getActiveSpan()?.setAttribute("docslurp.outcome", "cancelled");
    const logger = hasSharedLogProvider() ? logs.getLogger("docslurp.errors")
      : workerLoggerProvider?.getLogger("docslurp.errors") ?? logs.getLogger("docslurp.errors");
    logger.emit({ severityNumber: 9, severityText: "INFO", body: "public_operation_cancelled", attributes: { ...attributes, "docslurp.outcome": "cancelled" } });
  } catch { /* telemetry must never replace the original outcome */ }
}
