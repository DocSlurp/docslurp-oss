import { AsyncLocalStorage } from "node:async_hooks";
import { OpenTelemetry } from "@ai-sdk/otel";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { initializeObservability, installObservabilitySignalHandlers, emitTelemetryLog } from "@docslurp/shared/observability";
import { PostHogSpanProcessor } from "@posthog/ai/otel";
import { registerTelemetry } from "ai";

/** Langfuse content opt-in is private to Langfuse, never PostHog ingestion. */
export class LangfuseExcludingPostHogProcessor {
  constructor(private readonly inner: PostHogSpanProcessor) {}
  private allowed(span: Parameters<PostHogSpanProcessor["onEnd"]>[0]): boolean {
    return span.instrumentationScope.name !== "langfuse-sdk" &&
      !Object.keys(span.attributes).some(key => key.startsWith("langfuse.observation."));
  }
  onStart(...args: Parameters<PostHogSpanProcessor["onStart"]>): void {
    if (this.allowed(args[0])) this.inner.onStart(...args);
  }
  onEnd(...args: Parameters<PostHogSpanProcessor["onEnd"]>): void {
    if (this.allowed(args[0])) this.inner.onEnd(...args);
  }
  forceFlush(): Promise<void> { return this.inner.forceFlush(); }
  shutdown(): Promise<void> { return this.inner.shutdown(); }
}

export interface AiObservabilityContext {
  distinctId?: string;
  sessionId?: string;
  traceName?: string;
}

const observabilityContext = new AsyncLocalStorage<AiObservabilityContext>();
const projectToken = process.env.PUBLIC_POSTHOG_PROJECT_TOKEN?.trim();
// Opt-in: PostHog export needs both the project token and an explicit POSTHOG_HOST (the first-party
// ingestion proxy in hosted deployments). There is no default host, so self-hosted installs send nothing.
const host = process.env.POSTHOG_HOST?.trim();
const otlpLogsConfigured = Boolean(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim() || process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim());

export function emitPostHogApiLog(args: {
  severityText: "info" | "warn" | "error";
  body: string;
  eventName?: string;
  attributes?: Record<string, string | number | boolean>;
}): void {
  emitTelemetryLog(args);
}

if (projectToken && host) {
  const posthogSpanProcessor = new LangfuseExcludingPostHogProcessor(new PostHogSpanProcessor({
    projectToken,
    host,
  }));
  const posthogLogProcessor = new BatchLogRecordProcessor({
    exporter: new OTLPLogExporter({
      url: new URL("/i/v1/logs", host).toString(),
      headers: {
        Authorization: `Bearer ${projectToken}`,
      },
    }),
  });
  initializeObservability({ serviceName: "docslurp-api", spanProcessors: [posthogSpanProcessor], logRecordProcessors: otlpLogsConfigured ? [] : [posthogLogProcessor], nativeAiTelemetry: true });

  registerTelemetry(
    new OpenTelemetry({
      enrichSpan: ({ runtimeContext }) => {
        const properties = runtimeContext?.properties;
        const environment =
          typeof properties === "object" &&
          properties !== null &&
          "environment" in properties &&
          typeof properties.environment === "string"
            ? properties.environment
            : undefined;
        const provider =
          typeof properties === "object" &&
          properties !== null &&
          "provider" in properties &&
          typeof properties.provider === "string"
            ? properties.provider
            : undefined;

        return {
          environment,
          "$ai_provider": provider,
          "posthog.distinct_id":
            typeof runtimeContext?.distinctId === "string"
              ? runtimeContext.distinctId
              : undefined,
          "$ai_session_id":
            typeof runtimeContext?.sessionId === "string"
              ? runtimeContext.sessionId
              : undefined,
          "$ai_trace_name":
            typeof runtimeContext?.traceName === "string"
              ? runtimeContext.traceName
              : undefined,
        };
      },
    }),
  );
}

initializeObservability({ serviceName: "docslurp-api" });
installObservabilitySignalHandlers();

export function runWithAiObservability<T>(
  context: AiObservabilityContext,
  run: () => Promise<T>,
): Promise<T> {
  return observabilityContext.run(context, run);
}

export function posthogAiTelemetry(args: {
  functionId: string;
  provider: string;
  context?: AiObservabilityContext;
}) {
  const context = args.context ?? observabilityContext.getStore();

  return {
    runtimeContext: {
      ...(context?.distinctId ? { distinctId: context.distinctId } : {}),
      ...(isAiSessionId(context?.sessionId)
        ? { sessionId: context.sessionId }
        : {}),
      ...(context?.traceName ? { traceName: context.traceName } : {}),
      properties: {
        environment: process.env.NODE_ENV ?? "development",
        provider: args.provider,
      },
    },
    telemetry: {
      functionId: args.functionId,
      includeRuntimeContext: {
        distinctId: true,
        sessionId: true,
        traceName: true,
        properties: true,
      },
      // Keep tenant prompts, document excerpts, and generated text out of PostHog.
      recordInputs: false,
      recordOutputs: false,
    },
  };
}

function isAiSessionId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9\-_~.@()!':|]+$/.test(value)
  );
}
