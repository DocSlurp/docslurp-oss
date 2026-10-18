import { context, trace } from "@opentelemetry/api";
import { startDependencySpan } from "./telemetry.js";

export function usageTraceContext(): Record<string, string> {
  const active = trace.getSpan(context.active())?.spanContext();
  return active ? { traceId: active.traceId, spanId: active.spanId } : {};
}

/** Stable ledger ID is the deduplication key; parent spans are never charged again. */
export function recordUsageReceipt(event: { id?: string; provider: string; model: string; metric: string; costCents: number;
  inputTokens?: number; outputTokens?: number; metadata?: Record<string, unknown> }, scope: Record<string, unknown> = {}): void {
  const metadata = { ...event.metadata, ...scope };
  const providerCost = metadata.providerCostCents;
  const attributes: Record<string, string | number> = {
    "docslurp.dependency.type": "usage", "docslurp.dependency.provider": event.provider,
    "docslurp.dependency.operation": event.metric, "docslurp.usage.event_id": event.id ?? "",
    "docslurp.usage.metric": event.metric, "docslurp.usage.model": event.model,
    "docslurp.usage.billable_credits": metadata.billable === false ? 0 : event.costCents,
    "docslurp.usage.cost_source": typeof metadata.costSource === "string" ? metadata.costSource : "configured",
    "docslurp.usage.state": "recorded", // Database ledger remains authoritative for committed charges.
  };
  if (typeof event.inputTokens === "number") attributes["docslurp.usage.input_tokens"] = event.inputTokens;
  if (typeof event.outputTokens === "number") attributes["docslurp.usage.output_tokens"] = event.outputTokens;
  if (typeof providerCost === "number" && Number.isFinite(providerCost)) attributes["docslurp.usage.provider_cost_usd"] = providerCost / 100;
  for (const key of ["requestId", "runId", "documentId", "workspaceId", "orgId", "sessionId", "providerRequestId", "generationId", "traceId", "spanId"]) {
    if (typeof metadata[key] === "string") attributes[`docslurp.${key}`] = metadata[key];
  }
  startDependencySpan("usage.receipt", attributes).end();
}
