// Server-only entry point. Never re-export from the browser-safe shared barrel.
import { AsyncLocalStorage } from "node:async_hooks";
import { SpanStatusCode } from "@opentelemetry/api";
import { performance } from "node:perf_hooks";
import { isCancellation } from "./cancellation.js";
import { initializeObservability, observationTelemetry, mapsObservationAiUsage, withDependencyScope } from "./telemetry.js";
export { initializeObservability, flushObservability, shutdownObservability, installObservabilitySignalHandlers, emitTelemetryLog, exportsOtlpLogs, withHttpSpan, withBackgroundSpan, recordMediaTelemetry, startTelemetrySpan, recordChatAgentTelemetry, evalBaggageAttributes, activeTraceparent, EVAL_BAGGAGE_KEYS, type TelemetrySpan } from "./telemetry.js";
import {
  LangfuseOtelSpanAttributes,
  startActiveObservation,
  propagateAttributes,
  type LangfuseGenerationAttributes,
} from "@langfuse/tracing";

type Metadata = Record<string, unknown>;
type Observation = {
  update(attributes: LangfuseGenerationAttributes): unknown;
  otelSpan?: { setAttribute(key: string, value: string | number): unknown; setStatus?(status: { code: SpanStatusCode }): unknown };
};
const metadataContext = new AsyncLocalStorage<Metadata>();
// The observation that owns each metadata context, so late-bound correlation
// IDs (for example a user resolved by auth middleware) still reach its span.
const contextObservations = new WeakMap<Metadata, Observation>();
/** Bound payload size and exclude credentials, media bytes, and embedding vectors. */
export function sanitizeTraceValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth limit]";
  if (typeof value === "string")
    return value
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, "[media omitted]")
      .slice(0, 16000);
  if (Array.isArray(value))
    return value
      .slice(0, 32)
      .map((item) => sanitizeTraceValue(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 64)
        .filter(
          ([key]) =>
            !/api.?key|secret|password|authorization|cookie|embedding|vectors|^raw$|^config$|^cfg$/i.test(
              key,
            ),
        )
        .map(([key, item]) => [key, sanitizeTraceValue(item, depth + 1)]),
    );
  return value;
}

export function addTraceMetadata(metadata: Metadata): void {
  const active = metadataContext.getStore();
  if (!active) return;
  Object.assign(active, metadata);
  // Observations started later receive these through propagateAttributes; the
  // already-open owner needs them set directly to stay filterable in v4.
  const span = contextObservations.get(active)?.otelSpan;
  for (const [key, attribute] of [
    ["userId", LangfuseOtelSpanAttributes.TRACE_USER_ID],
    ["sessionId", LangfuseOtelSpanAttributes.TRACE_SESSION_ID],
  ] as const) {
    const value = metadata[key];
    if (typeof value !== "string" || !value) continue;
    try {
      span?.setAttribute(attribute, value.slice(0, 200));
    } catch {
      console.warn("[langfuse] attribute update failed");
    }
  }
}

function safeUpdate(
  observation: Observation,
  attributes: LangfuseGenerationAttributes,
): void {
  try {
    observation.update(attributes);
    if (attributes.level === "ERROR") {
      observation.otelSpan?.setStatus?.({ code: SpanStatusCode.ERROR });
      observation.otelSpan?.setAttribute("error.type", "Error");
    }
    const provider = attributes.metadata?.provider;
    if (typeof provider === "string") observation.otelSpan?.setAttribute("gen_ai.provider.name", provider);
    if (attributes.model) observation.otelSpan?.setAttribute("gen_ai.request.model", attributes.model);
    if (mapsObservationAiUsage()) for (const [source, target] of [["input", "gen_ai.usage.input_tokens"], ["output", "gen_ai.usage.output_tokens"]] as const) {
      const value = (attributes.usageDetails as Record<string, unknown> | undefined)?.[source];
      if (typeof value === "number" && Number.isFinite(value)) observation.otelSpan?.setAttribute(target, value);
    }
  } catch {
    console.warn("[langfuse] observation update failed");
  }
}

export interface ObservationOptions<T> {
  name: string;
  type?: "span" | "generation" | "embedding" | "retriever";
  model?: string;
  input?: unknown;
  metadata?: Metadata;
  result?: (result: T) => LangfuseGenerationAttributes;
}

export async function withObservation<T>(
  options: ObservationOptions<T>,
  run: () => Promise<T>,
): Promise<T> {
  if (!initializeObservability()) return run();
  const metadata = { ...metadataContext.getStore(), ...options.metadata };
  const capture = process.env.LANGFUSE_CAPTURE_CONTENT === "true";
  let invoked = false;
  let savedOutcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const execute = (observation: Observation) =>
    metadataContext.run(metadata, async () => {
      const started = performance.now();
      let outcome: "ok" | "error" | "cancelled" = "ok";
      contextObservations.set(metadata, observation);
      safeUpdate(observation, {
        model: options.model,
        metadata: sanitizeTraceValue(metadata) as Metadata,
        ...(capture ? { input: sanitizeTraceValue(options.input) } : {}),
      });
      try {
        if (options.type === "generation" || options.type === "embedding") observation.otelSpan?.setAttribute("gen_ai.operation.name", options.type === "embedding" ? "embeddings" : "chat");
      } catch { /* Best effort metadata. */ }
      try {
        invoked = true;
        const result = await withDependencyScope(metadata, run);
        savedOutcome = { ok: true, value: result };
        try {
          const details = options.result?.(result) ?? {};
          // Include correlation IDs that
          // become available after a provider responds, as well as initial scope.
          Object.assign(metadata, details.metadata ?? {});
          safeUpdate(observation, {
            ...details,
            input: capture
              ? sanitizeTraceValue(details.input ?? options.input)
              : undefined,
            output: capture ? sanitizeTraceValue(details.output) : undefined,
            metadata: sanitizeTraceValue({
              ...metadata,
              ...details.metadata,
            }) as Metadata,
          });
        } catch {
          console.warn("[langfuse] result capture failed");
        }
        return savedOutcome;
      } catch (error) {
        savedOutcome = { ok: false, error };
        if (isCancellation(error)) {
          // The caller gave up (Stop, disconnect): a distinct outcome, not an ERROR span.
          outcome = "cancelled";
          safeUpdate(observation, { level: "WARNING", statusMessage: "cancelled", metadata: sanitizeTraceValue(metadata) as Metadata });
          try { observation.otelSpan?.setAttribute("docslurp.outcome", "cancelled"); } catch { /* Best effort metadata. */ }
          return savedOutcome;
        }
        outcome = "error";
        safeUpdate(observation, {
          level: "ERROR",
          statusMessage: capture
            ? String(
                sanitizeTraceValue(
                  error instanceof Error ? error.message : String(error),
                ),
              )
            : error instanceof Error
              ? error.name
              : "Error",
          metadata: sanitizeTraceValue(metadata) as Metadata,
        });
        // Rethrow outside the SDK callback so its automatic error handler cannot
        // overwrite our content policy with a raw provider error body.
        return savedOutcome;
      } finally {
        observationTelemetry(options.name, options.type ?? "span", (performance.now() - started) / 1000, outcome, metadata);
      }
    });
  let outcome;
  try {
    outcome = await propagateAttributes({
      // Child observations inherit the root name through SDK context. Correlation
      // dimensions must exist on each observation in the v4 data model.
      traceName: metadataContext.getStore() ? undefined : options.name.slice(0, 200),
      userId: typeof metadata.userId === "string" ? metadata.userId.slice(0, 200) : undefined,
      sessionId: typeof metadata.sessionId === "string" ? metadata.sessionId.slice(0, 200) : undefined,
    }, async () => {
      switch (options.type) {
        case "generation":
          return startActiveObservation(options.name, execute, { asType: "generation" });
        case "embedding":
          return startActiveObservation(options.name, execute, { asType: "embedding" });
        case "retriever":
          return startActiveObservation(options.name, execute, { asType: "retriever" });
        default:
          return startActiveObservation(options.name, execute);
      }
    });
  } catch (error) {
    if (savedOutcome) {
      if (!savedOutcome.ok) throw savedOutcome.error;
      return savedOutcome.value;
    }
    if (invoked) throw error; // Never repeat a provider call after it has begun.
    console.warn("[langfuse] span creation failed; continuing without tracing");
    return run();
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** Actual SDK usage only; absent values stay absent rather than becoming zero. */
export function aiResultDetails(result: {
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number; tokens?: number };
}): LangfuseGenerationAttributes {
  const usageDetails = Object.fromEntries(
    Object.entries({
      input: result.usage?.inputTokens ?? result.usage?.tokens,
      output: result.usage?.outputTokens,
    }).filter(
      ([, value]) => typeof value === "number" && Number.isFinite(value),
    ),
  );
  return { output: result.text, usageDetails };
}

export { instrumentPostgres, type PostgresQueryHooks } from "./dependency-postgres.js";
export { startDependencySpan, withDependencySpan } from "./telemetry.js";
export { instrumentFetch } from "./dependency-fetch.js";
export { instrumentS3Client } from "./dependency-s3.js";
export { recordUsageReceipt, usageTraceContext } from "./dependency-usage.js";
