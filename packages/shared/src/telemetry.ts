import { observabilityRuntimeKey } from "./telemetry-state.js";
import { isCancellation } from "./cancellation.js";
import { logs as logsApi } from "@opentelemetry/api-logs";
// Server-only runtime. One provider owns context; exporters never own app lifecycle.
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { context, createContextKey, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Exception, type Histogram } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes, defaultResource } from "@opentelemetry/resources";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, type ReadableSpan, type SpanExporter, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { LoggerProvider, BatchLogRecordProcessor, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";

export interface ObservabilityOptions {
  serviceName?: string;
  spanProcessors?: SpanProcessor[];
  logRecordProcessors?: LogRecordProcessor[];
  nativeAiTelemetry?: boolean;
}

type Runtime = {
  traces: NodeTracerProvider;
  otlpLogs?: boolean;
  metrics?: MeterProvider;
  operationDuration?: Histogram;
  httpDuration?: Histogram;
  dependencyDuration?: Histogram;
  logs?: LoggerProvider;
  shutdown?: Promise<void>;
  signalsInstalled?: boolean;
  nativeAiTelemetry?: boolean;
};
// Astro reloads modules during development. Reuse the process-owned SDK.
const runtimeKey = observabilityRuntimeKey;
const processState = globalThis as typeof globalThis & { [runtimeKey]?: Runtime };
const getRuntime = () => processState[runtimeKey];
let initializationFailed = false;
let warnedMissingOtlp = false;
export const mapsObservationAiUsage = () => !getRuntime()?.nativeAiTelemetry;
function bestEffort(run: () => void): void { try { run(); } catch { /* Telemetry never changes application outcomes. */ } }
const timeoutMillis = 5000;
const correlationKeys = new Set(["requestId", "runId", "documentId", "workspaceId", "orgId", "stageName", "scope"]);

function numberSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  const result = value?.trim() ? Number(value) : fallback;
  if (!Number.isFinite(result) || result < min || result > max) throw new Error("Invalid telemetry numeric setting");
  return result;
}

/** Preserve integration/correlation attributes; strip credentials and explicit content payloads. */
function safeAttributes(attributes: Attributes): Attributes {
  return Object.fromEntries(Object.entries(attributes).filter(([key, value]) =>
    value !== undefined && !/(authorization|cookie|password|secret|api[._-]?key|access[._-]?token|refresh[._-]?token)/i.test(key)
      && !/^(langfuse\.observation\.(input|output)|gen_ai\.(input|output)\.messages|ai\.(prompt|response\.text))$/.test(key),
  ).map(([key, value]) => [key, typeof value === "string"
    ? value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 16000) : value]));
}

/** Error text for spans: credentials scrubbed, length capped. Messages and stacks are what support needs to act on a failure. */
function safeErrorText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(dslp_(?:priv|pub)_|dslp_)[A-Za-z0-9_-]+/g, "$1[redacted]")
    .replace(/((?:password|secret|api[._-]?key|access[._-]?token|refresh[._-]?token)["'\s:=]+)[^\s"',;&]+/gi, "$1[redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]+@/gi, "$1[redacted]@")
    .slice(0, max);
}

/** Records an error on a span: type, message and stack (scrubbed on export too). */
function recordSpanError(span: { recordException(exception: Exception): void; setStatus(status: { code: SpanStatusCode; message?: string }): void } | undefined, error: unknown): void {
  if (!span) return;
  // Scrubbed here as well as on export, so no processor ever sees a credential.
  const message = safeErrorText(error instanceof Error ? error.message : error, 2000);
  const exception: Exception = { name: error instanceof Error ? error.name : "Error", message,
    ...(error instanceof Error && error.stack ? { stack: safeErrorText(error.stack, 8000) } : {}) };
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: message.slice(0, 1000) });
}

/** True while traces are being recorded, so callers can skip work only spans need (call-site capture). */
export function isTracingActive(): boolean {
  const runtime = getRuntime();
  return Boolean(runtime && !runtime.shutdown);
}

class PrivateTraceExporter implements SpanExporter {
  constructor(private readonly exporter: SpanExporter) {}
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.exporter.export(spans.map(span => ({
      ...span,
      name: span.name, kind: span.kind, resource: span.resource,
      instrumentationScope: span.instrumentationScope, parentSpanContext: span.parentSpanContext,
      startTime: span.startTime, endTime: span.endTime, duration: span.duration,
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount, droppedLinksCount: span.droppedLinksCount,
      attributes: safeAttributes(span.attributes),
      // Messages and stacks are kept (scrubbed and capped): without them a failed
      // span cannot be traced back to its cause when servicing a user.
      status: { code: span.status.code, ...(span.status.message ? { message: safeErrorText(span.status.message, 1000) } : {}) },
      events: span.events.filter(event => event.name === "exception").map(event => ({
        ...event, attributes: {
          "exception.type": event.attributes?.["exception.type"] ?? "Error",
          ...(event.attributes?.["exception.message"] ? { "exception.message": safeErrorText(event.attributes["exception.message"], 2000) } : {}),
          ...(event.attributes?.["exception.stacktrace"] ? { "exception.stacktrace": safeErrorText(event.attributes["exception.stacktrace"], 8000) } : {}),
        },
      })),
      links: span.links.map(link => ({ ...link, attributes: safeAttributes(link.attributes ?? {}) })),
      spanContext: () => span.spanContext(),
    })), done);
  }
  shutdown(): Promise<void> { return this.exporter.shutdown(); }
  forceFlush(): Promise<void> { return this.exporter.forceFlush?.() ?? Promise.resolve(); }
}

function exporterOptions(signal: "traces" | "metrics" | "logs") {
  const prefix = `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}`;
  const override = process.env[`${prefix}_ENDPOINT`]?.trim();
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!override && !base) return undefined;
  const url = new URL(override ?? `${base!.replace(/\/$/, "")}/v1/${signal}`);
  if (url.username || url.password || url.search || url.hash) throw new Error("Telemetry URL must not contain credentials or query strings");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    throw new Error("Remote telemetry requires HTTPS");
  const protocol = process.env[`${prefix}_PROTOCOL`] ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol && protocol !== "http/protobuf") throw new Error("Only OTLP HTTP/protobuf is supported");
  const headers: Record<string, string> = {};
  for (const pair of (process.env[`${prefix}_HEADERS`] ?? process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
    if (!pair.trim()) continue;
    const index = pair.indexOf("=");
    if (index <= 0) throw new Error("Invalid OTLP headers");
    headers[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return { url: url.toString(), headers, timeoutMillis };
}

export function initializeObservability(options: ObservabilityOptions = {}): boolean {
  if (process.env.OTEL_SDK_DISABLED === "true" ||
    (process.env.NODE_ENV === "test" && process.env.OTEL_ENABLED !== "true" && process.env.LANGFUSE_ENABLED !== "true")) return false;
  if (getRuntime()) return true;
  if (initializationFailed) return false;
  try {
    const enabled = process.env.OTEL_ENABLED !== "false";
    const tracesOptions = enabled ? exporterOptions("traces") : undefined;
    const metricsOptions = enabled ? exporterOptions("metrics") : undefined;
    const logsOptions = enabled ? exporterOptions("logs") : undefined;
    const ratio = numberSetting(process.env.OTEL_TRACES_SAMPLER_ARG, 1, 0, 1);
    const interval = numberSetting(process.env.OTEL_METRIC_EXPORT_INTERVAL, 30000, 5000, 3600000);
    const sampler = process.env.OTEL_TRACES_SAMPLER;
    if (sampler && sampler !== "parentbased_traceidratio" && sampler !== "parentbased_always_on") throw new Error("Unsupported traces sampler");
    const processors = [...(options.spanProcessors ?? [])];
    const logProcessors = [...(options.logRecordProcessors ?? [])];
    const langfuse = process.env.LANGFUSE_ENABLED !== "false" && process.env.LANGFUSE_PUBLIC_KEY?.trim() && process.env.LANGFUSE_SECRET_KEY?.trim() && process.env.LANGFUSE_BASE_URL?.trim();
    if (langfuse) processors.push(new LangfuseSpanProcessor({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY!.trim(), secretKey: process.env.LANGFUSE_SECRET_KEY!.trim(),
      baseUrl: process.env.LANGFUSE_BASE_URL!.trim(), timeout: 5, flushAt: 32, flushInterval: 2,
      shouldExportSpan: ({ otelSpan }) => isDefaultExportSpan(otelSpan) || otelSpan.instrumentationScope.name.startsWith("docslurp."),
      mediaUploadEnabled: false, additionalHeaders: { "x-langfuse-ingestion-version": "4" },
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    }));

    if (tracesOptions) processors.push(new BatchSpanProcessor(new PrivateTraceExporter(new OTLPTraceExporter(tracesOptions)), {
      maxQueueSize: 1024, maxExportBatchSize: 64, scheduledDelayMillis: 2000, exportTimeoutMillis: timeoutMillis,
    }));
    if (logsOptions) logProcessors.push(new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter(logsOptions), maxQueueSize: 1024, maxExportBatchSize: 64,
      scheduledDelayMillis: 2000, exportTimeoutMillis: timeoutMillis,
    }));
    // Name the destinations so a Langfuse-only process cannot pass for SigNoz export.
    const destinations = [...(langfuse ? ["langfuse"] : []), ...(tracesOptions ? ["otlp-traces"] : []),
      ...(metricsOptions ? ["otlp-metrics"] : []), ...(logsOptions ? ["otlp-logs"] : [])];
    // Once: with no destination at all, every HTTP span re-enters this function.
    if (enabled && !tracesOptions && !metricsOptions && !logsOptions && process.env.NODE_ENV === "production" && !warnedMissingOtlp) {
      warnedMissingOtlp = true;
      console.warn("[observability] OTLP export not configured (OTEL_EXPORTER_OTLP_ENDPOINT unset); SigNoz receives no telemetry from this process");
    }
    if (!processors.length && !logProcessors.length && !metricsOptions) return false;
    const environment = process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? "development";
    const resource = defaultResource().merge(resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME?.trim() || options.serviceName || "docslurp-tools",
      "service.version": process.env.APP_VERSION ?? process.env.GIT_SHA ?? (process.env.NODE_ENV === "production" ? "unknown" : "development"),
      "service.instance.id": process.env.FLY_MACHINE_ID ?? `${hostname()}:${process.pid}`,
      "deployment.environment.name": environment,
      // SigNoz's Services environment filter still reads the pre-1.27 semconv key.
      "deployment.environment": environment,
      "telemetry.sdk.language": "nodejs",
    }));

    const traces = new NodeTracerProvider({ resource, spanProcessors: processors,
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampler === "parentbased_always_on" ? 1 : ratio) }),
      forceFlushTimeoutMillis: timeoutMillis,
    });
    const metrics = metricsOptions ? new MeterProvider({ resource,
      readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(metricsOptions),
        exportIntervalMillis: interval, exportTimeoutMillis: timeoutMillis,
      })], views: [{ instrumentName: "*", aggregationCardinalityLimit: 1000 }],
    }) : undefined;
    const logs = logProcessors.length ? new LoggerProvider({ resource, processors: logProcessors }) : undefined;
    if (logs) logsApi.setGlobalLoggerProvider(logs);
    // Baggage is extracted so allowlisted eval.* keys can label spans (evalBaggageAttributes); nothing injects it outbound.
    traces.register({ contextManager: new AsyncLocalStorageContextManager(),
      propagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }) });
    setLangfuseTracerProvider(traces);
    processState[runtimeKey] = { traces, metrics, logs, otlpLogs: Boolean(logsOptions), nativeAiTelemetry: options.nativeAiTelemetry,
      operationDuration: metrics?.getMeter("docslurp.operations").createHistogram("docslurp.operation.duration", { unit: "s" }),
      dependencyDuration: metrics?.getMeter("docslurp.dependencies").createHistogram("docslurp.dependency.duration", { unit: "s" }),
      httpDuration: metrics?.getMeter("docslurp.http").createHistogram("http.server.request.duration", { unit: "s" }),
    };
    if (metrics) registerRuntimeMetrics(metrics);
    process.once("beforeExit", () => { void shutdownObservability(); });
    console.info(`[observability] enabled destinations=${destinations.join(",") || "none"}`);
    return true;
  } catch {
    initializationFailed = true;
    // SDK error objects can contain endpoint credentials. Never log their body.
    console.warn("[observability] initialization failed; application continues without telemetry");
    return false;
  }
}

function registerRuntimeMetrics(provider: MeterProvider): void {
  const meter = provider.getMeter("docslurp.runtime");
  meter.createObservableGauge("process.memory.usage", { unit: "By" }).addCallback(result => {
    const memory = process.memoryUsage();
    for (const [type, value] of Object.entries({ resident_set: memory.rss, heap_used: memory.heapUsed, external: memory.external }))
      result.observe(value, { "memory.type": type });
  });
  meter.createObservableCounter("process.cpu.time", { unit: "s" }).addCallback(result => {
    const cpu = process.cpuUsage();
    result.observe(cpu.user / 1e6, { "cpu.mode": "user" });
    result.observe(cpu.system / 1e6, { "cpu.mode": "system" });
  });
  meter.createObservableGauge("process.uptime", { unit: "s" }).addCallback(result => result.observe(process.uptime()));
}

export async function flushObservability(): Promise<void> {
  const runtime = getRuntime();
  if (!runtime || runtime.shutdown) return;
  await Promise.allSettled([() => runtime.traces.forceFlush(), () => runtime.metrics?.forceFlush(), () => runtime.logs?.forceFlush({ timeoutMillis })].map(run => Promise.resolve().then(run)));
}

export async function shutdownObservability(): Promise<void> {
  const runtime = getRuntime();
  if (!runtime) return;
  runtime.shutdown ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([() => runtime.traces.shutdown(), () => runtime.metrics?.shutdown(), () => runtime.logs?.shutdown()].map(run => Promise.resolve().then(run))),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMillis); }),
    ]);
    if (timer) clearTimeout(timer);
  })();
  await runtime.shutdown;
}

/** API processes only. Temporal owns activity drain and calls shutdown afterwards. */
export function installObservabilitySignalHandlers(): void {
  const runtime = getRuntime();
  if (!runtime || runtime.signalsInstalled) return;
  runtime.signalsInstalled = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    void shutdownObservability().finally(() => process.kill(process.pid, signal));
  });
}

/** True when application logs reach an OTLP collector (SigNoz), so stdout copies would duplicate them. */
export const exportsOtlpLogs = () => Boolean(getRuntime()?.otlpLogs && !getRuntime()?.shutdown);

/**
 * `eventName` is the stable, queryable identifier; `body` is the human-readable
 * line shown in log lists. Without an `eventName`, `body` doubles as both.
 */
export function emitTelemetryLog(args: { severityText: "info" | "warn" | "error"; body: string; eventName?: string; attributes?: Attributes }): void {
  const runtime = getRuntime();
  if (!runtime || runtime.shutdown) return;
  bestEffort(() => runtime.logs?.getLogger("docslurp.application").emit({
    severityNumber: args.severityText === "error" ? 17 : args.severityText === "warn" ? 13 : 9,
    severityText: args.severityText.toUpperCase(), body: args.body.slice(0, 1000),
    ...(args.eventName ? { eventName: args.eventName } : {}),
    // Mirrored as an attribute: SigNoz filters on attributes, not the LogRecord event_name field.
    attributes: safeAttributes({ ...(args.attributes ?? {}), ...(args.eventName ? { "event.name": args.eventName } : {}) }),
    context: context.active(),
  }));
}

/** Tag the span active in this context (for example the per-document worker span) so SigNoz can filter on it. */
export function setActiveSpanAttributes(attributes: Attributes): void {
  const active = trace.getSpan(context.active());
  if (!active) return;
  bestEffort(() => active.setAttributes(safeAttributes(attributes)));
}

export function observationTelemetry(name: string, type: string, durationSeconds: number, outcome: "ok" | "error" | "cancelled", metadata: Record<string, unknown>): void {
  const failed = outcome === "error";
  const runtime = getRuntime();
  if (!runtime || runtime.shutdown) return;
  const attributes = { "docslurp.operation.name": name.slice(0, 200), "docslurp.operation.type": type, "error.type": failed ? "Error" : "none", "docslurp.outcome": outcome };
  bestEffort(() => runtime.operationDuration?.record(durationSeconds, attributes));
  const correlations = Object.fromEntries(Object.entries(metadata).filter(([key, value]) => correlationKeys.has(key) && typeof value === "string").map(([key, value]) => [`docslurp.${key}`, value as string]));
  const media = Object.fromEntries(Object.entries(metadata).filter(([key, value]) =>
    ["provider", "model", "mediaJobId", "leaseId", "resourceId", "providerRequestId", "costState"].includes(key) && typeof value === "string")
    .map(([key, value]) => [`docslurp.media.${key}`, value as string]));
  const active = trace.getSpan(context.active());
  // Retrieval run by the chat search agent links back to its conversation.
  const chat = typeof metadata.chatSessionId === "string" ? { "docslurp.chat.session_id": metadata.chatSessionId } : {};
  for (const [key, value] of Object.entries({ ...correlations, ...media, ...chat })) bestEffort(() => active?.setAttribute(key, value));
  if (outcome !== "ok" || name.startsWith("worker.stage.")) emitTelemetryLog({
    eventName: "docslurp.operation.completed", severityText: failed ? "error" : "info",
    body: `${name.slice(0, 200)} ${failed ? "failed" : outcome === "cancelled" ? "cancelled" : "completed"} in ${Math.round(durationSeconds * 1000)}ms`,
    attributes: { ...attributes, ...correlations, duration_ms: Math.round(durationSeconds * 1000) },
  });
}

export function recordHttpTelemetry(method: string, route: string, status: number, durationSeconds: number): void {
  const runtime = getRuntime();
  if (!runtime || runtime.shutdown) return;
  const attributes = { "http.request.method": method, "http.route": route, "http.response.status_code": status };
  bestEffort(() => runtime.httpDuration?.record(durationSeconds, attributes));
}

export async function withHttpSpan<T>(options: {
  method: string;
  route: string;
  headers: Record<string, string>;
  status: () => number;
  /** Read when the request ends, once auth has resolved who made it: request, user, org, key and route ids. */
  attributes?: () => Attributes;
}, run: () => Promise<T>): Promise<T> {
  if (!initializeObservability({ serviceName: "docslurp-api" })) return run();
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  let invoked = false;
  try {
    const parent = propagation.extract(ROOT_CONTEXT, options.headers);
    await getRuntime()!.traces.getTracer("docslurp.http").startActiveSpan(`${options.method} ${options.route}`, {
      kind: SpanKind.SERVER, attributes: { "http.request.method": options.method, "http.route": options.route },
    }, parent, async span => {
      const started = performance.now();
      invoked = true;
      try { outcome = { ok: true, value: await run() }; }
      catch (error) { outcome = { ok: false, error }; }
      finally {
        bestEffort(() => {
          const status = outcome?.ok === false ? 500 : options.status();
          span.setAttribute("http.response.status_code", status);
          if (options.attributes) span.setAttributes(safeAttributes(options.attributes()));
          if (outcome?.ok === false) { recordSpanError(span, outcome.error); span.setAttribute("error.type", outcome.error instanceof Error ? outcome.error.name : "Error"); }
          else if (status >= 500) { span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` }); span.setAttribute("error.type", String(status)); }
          recordHttpTelemetry(options.method, options.route, status, (performance.now() - started) / 1000);
        });
        bestEffort(() => span.end());
      }
    });
  } catch (error) {
    if (!invoked) return run();
    if (!outcome) throw error;
  }
  if (!outcome) throw new Error("HTTP callback did not complete");
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * One pass of a background loop (timer tick or LISTEN drain) as its own root
 * span, so its dependency spans share one named trace instead of each starting
 * an anonymous one, and never attach to the request that created the timer.
 */
export async function withBackgroundSpan<T>(task: string, run: () => Promise<T>): Promise<T> {
  let span: ReturnType<ReturnType<NodeTracerProvider["getTracer"]>["startSpan"]> | undefined;
  try {
    span = getRuntime()?.traces.getTracer("docslurp.background").startSpan(task, {
      kind: SpanKind.INTERNAL, root: true, attributes: { "docslurp.background.task": task },
    }, ROOT_CONTEXT);
  } catch { /* Best effort. */ }
  if (!span) return run();
  const active = span;
  try {
    return await context.with(trace.setSpan(ROOT_CONTEXT, active), run);
  } catch (error) {
    bestEffort(() => {
      active.setStatus({ code: SpanStatusCode.ERROR });
      active.setAttribute("error.type", error instanceof Error ? error.name : "Error");
    });
    throw error;
  } finally {
    bestEffort(() => active.end());
  }
}

/** IDs stay on logs/spans; media metric labels are bounded provider/model categories. */
export function recordMediaTelemetry(args: { provider: string; model: string; operation: string; outcome: string;
  durationSeconds: number; audioSeconds?: number; costUsd?: number; costSource?: string; candidateFrames?: number; selectedFrames?: number; inputTokens?: number; outputTokens?: number }): void {
  const meter = getRuntime()?.metrics?.getMeter("docslurp.media");
  if (!meter) return;
  const labels = { provider: args.provider, model: args.model, operation: args.operation, outcome: args.outcome };
  bestEffort(() => {
    meter.createCounter("docslurp.media.requests").add(1, labels);
    meter.createHistogram("docslurp.media.duration", { unit: "s" }).record(args.durationSeconds, labels);
    for (const [name, value] of Object.entries({ candidates: args.candidateFrames, frames: args.selectedFrames, input_tokens: args.inputTokens, output_tokens: args.outputTokens })) {
      if (value !== undefined) meter.createCounter(`docslurp.media.${name}`).add(value, labels);
    }
    if (args.audioSeconds !== undefined) meter.createCounter("docslurp.media.audio", { unit: "s" }).add(args.audioSeconds, labels);
    if (args.costUsd !== undefined) meter.createCounter("docslurp.media.cost", { unit: "USD" }).add(args.costUsd,
      { ...labels, costSource: args.costSource ?? "estimate" });
  });
}

const dependencyScopeKey = createContextKey("docslurp.dependency.scope");
export function withDependencyScope<T>(scope: Record<string, unknown>, run: () => T): T {
  return context.with(context.active().setValue(dependencyScopeKey, scope), run);
}

/**
 * Dependency timing span. Metrics stay low-cardinality (type, operation,
 * provider, phase); spans carry what support needs: correlation ids from the
 * dependency scope plus whatever the caller adds (parameterized SQL, call site).
 * Never keys, request bodies or parameter values.
 */
export function startDependencySpan(name: string, attributes: Attributes) {
  const started = performance.now();
  const scope = context.active().getValue(dependencyScopeKey) as Record<string, unknown> | undefined;
  const correlation = Object.fromEntries(Object.entries(scope ?? {}).filter(([key, value]) =>
    ["requestId", "runId", "documentId", "workspaceId", "orgId", "sessionId", "stageName"].includes(key) && typeof value === "string")
    .map(([key, value]) => [`docslurp.${key}`, value as string]));
  attributes = { ...correlation, ...attributes };
  const runtime = getRuntime();
  let span: ReturnType<ReturnType<NodeTracerProvider["getTracer"]>["startSpan"]> | undefined;
  try { span = runtime?.traces.getTracer("docslurp.dependencies").startSpan(name, { kind: SpanKind.CLIENT, attributes: safeAttributes(attributes) }); } catch { /* Best effort. */ }
  const parent = context.active();
  const active = span ? trace.setSpan(parent, span) : parent;
  let ended = false;
  return {
    run<T>(callback: () => T): T { return context.with(active, callback); },
    set(values: Attributes): void { bestEffort(() => span?.setAttributes(safeAttributes(values))); },
    end(error?: unknown): void {
      if (ended) return;
      ended = true;
      const errorType = error instanceof Error ? error.name : error ? "Error" : undefined;
      bestEffort(() => {
        if (errorType) { recordSpanError(span, error); span?.setAttribute("error.type", errorType); }
        // IDs, server names and model names belong on spans, never metric labels.
        const labels = Object.fromEntries(Object.entries(attributes).filter(([key]) =>
          ["docslurp.dependency.type", "docslurp.dependency.operation", "docslurp.dependency.provider", "docslurp.dependency.phase"].includes(key)));
        runtime?.dependencyDuration?.record((performance.now() - started) / 1000, { ...labels, "error.type": errorType ?? "none" });
      });
      bestEffort(() => span?.end());
    },
  };
}

export async function withDependencySpan<T>(name: string, attributes: Attributes, run: () => Promise<T>): Promise<T> {
  const span = startDependencySpan(name, attributes);
  try { return await span.run(run); }
  catch (error) { span.end(error); throw error; }
  finally { span.end(); }
}

/** A span the caller ends explicitly; every method is a no-op when tracing is off. */
export interface TelemetrySpan {
  run<T>(callback: () => T): T;
  set(values: Attributes): void;
  end(error?: unknown): void;
}

/**
 * Application span on a `docslurp.*` tracer (GenAI agent, model step and tool
 * spans). The parent is `options.parent` when given, else the active context.
 * Attributes must be ids, counts and enums, never prompt, answer or document
 * text; the OTLP exporter still strips credentials and content keys.
 */
export function startTelemetrySpan(tracerName: string, name: string, attributes: Attributes,
  options: { parent?: TelemetrySpan; kind?: "internal" | "client" } = {}): TelemetrySpan {
  const runtime = getRuntime();
  let span: ReturnType<ReturnType<NodeTracerProvider["getTracer"]>["startSpan"]> | undefined;
  const parent = options.parent ? options.parent.run(() => context.active()) : context.active();
  try {
    if (runtime && !runtime.shutdown) span = runtime.traces.getTracer(tracerName).startSpan(name, {
      kind: options.kind === "client" ? SpanKind.CLIENT : SpanKind.INTERNAL, attributes: safeAttributes(attributes) }, parent);
  } catch { /* Best effort. */ }
  const active = span ? trace.setSpan(parent, span) : parent;
  let ended = false;
  return {
    run<T>(callback: () => T): T { return context.with(active, callback); },
    set(values: Attributes): void { bestEffort(() => span?.setAttributes(safeAttributes(values))); },
    end(error?: unknown): void {
      if (ended) return;
      ended = true;
      // A caller giving up (Stop, disconnect) ends the span with its own outcome, not an ERROR status.
      if (error && isCancellation(error)) bestEffort(() => span?.setAttribute("docslurp.outcome", "cancelled"));
      else if (error) bestEffort(() => {
        recordSpanError(span, error);
        span?.setAttribute("error.type", error instanceof Error ? error.name : String(error).slice(0, 64));
      });
      bestEffort(() => span?.end());
    },
  };
}

/** Low-cardinality chat agent metrics: model ids, tool names and stop reasons only, never ids. */
export function recordChatAgentTelemetry(args: { model: string; stopReason: string; durationSeconds: number;
  toolCalls: Readonly<Record<string, number>> }): void {
  const meter = getRuntime()?.metrics?.getMeter("docslurp.chat");
  if (!meter) return;
  bestEffort(() => {
    meter.createHistogram("docslurp.chat.agent.duration", { unit: "s" }).record(args.durationSeconds,
      { "gen_ai.request.model": args.model, "docslurp.chat.stop_reason": args.stopReason });
    const counter = meter.createCounter("docslurp.chat.agent.tool_calls");
    for (const [tool, count] of Object.entries(args.toolCalls)) {
      if (count > 0) counter.add(count, { "gen_ai.request.model": args.model, "gen_ai.tool.name": tool });
    }
  });
}

/** Client-supplied W3C baggage keys copied onto agent spans, so eval harnesses can join runs to traces. */
export const EVAL_BAGGAGE_KEYS = ["eval.run_id", "eval.case_id", "eval.model", "eval.arm"] as const;

/** Allowlisted `eval.*` baggage from the active context, each value capped at 128 characters. */
export function evalBaggageAttributes(): Record<string, string> {
  const attributes: Record<string, string> = {};
  bestEffort(() => {
    const baggage = propagation.getBaggage(context.active());
    for (const key of EVAL_BAGGAGE_KEYS) {
      const value = baggage?.getEntry(key)?.value;
      if (typeof value === "string" && value) attributes[key] = value.slice(0, 128);
    }
  });
  return attributes;
}

/** W3C `traceparent` of the active sampled-or-not span, for response headers; null without a valid span. */
export function activeTraceparent(): string | null {
  const span = trace.getSpan(context.active());
  const spanContext = span?.spanContext();
  if (!spanContext || !trace.isSpanContextValid(spanContext)) return null;
  return `00-${spanContext.traceId}-${spanContext.spanId}-${(spanContext.traceFlags & 1).toString(16).padStart(2, "0")}`;
}
