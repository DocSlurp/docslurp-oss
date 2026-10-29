import { resolveVisionRoute, visionListPriceCents, type VisionConfig } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { UsageEvent } from "../models.js";
import type { WorkerAiUsageInput } from "./ai-usage.js";
import { rejectedVisionUsageInput, type VisionExecutionResult } from "../tools/vision-runtime.js";
import { findVisionBilledUsage, findVisionOutputRejected } from "../tools/vision-stream.js";
import { isBillableVisionRuntime } from "./vision-pricing.js";
import {
  findVisionGuardStop,
  withVisionCall,
  type VisionAttemptTarget,
  type VisionCallGate,
  type VisionGuardHost,
  type VisionGuardStop,
} from "./vision-attempt-guard.js";

type PricingConfig = Pick<Config, "openAiBaseUrl" | "costPer1kInputTokens" | "costPer1kOutputTokens">;

/** Provider cost of vision usage on `vision`'s route: the provider charge, else list price, else configured rates. */
export function priceVisionUsage(
  vision: VisionConfig,
  cfg: PricingConfig,
  usage: { inputTokens: number; outputTokens: number; costCents?: number },
): number {
  if (usage.costCents !== undefined) return usage.costCents;
  const route = resolveVisionRoute(vision);
  if (!isBillableVisionRuntime(route, cfg)) return 0;
  return visionListPriceCents(route.model, usage) ??
    (usage.inputTokens / 1000) * cfg.costPer1kInputTokens + (usage.outputTokens / 1000) * cfg.costPer1kOutputTokens;
}

export type GuardedVisionOutcome<T = VisionExecutionResult> =
  | { admitted: true; result: T }
  | { admitted: false; stop: VisionGuardStop };

/**
 * One vision call outside vision-extract (document-map OCR, self-critique, deferred page
 * materialization) under the run's vision attempt guard (lib/vision-attempt-guard.ts): `call` gets the
 * gate that admits each request it sends. A call refused before any request returns the refusal; one
 * refused later, rejected or failed records its billed usage here (once, unbilled) and, unless refused,
 * rethrows. `onResult` records a successful call's usage before its requests settle; record a page read
 * through `recordVisionRead` so a new customer Rich page charge un-counts its request.
 */
export async function guardedVisionCall<T = VisionExecutionResult>(args: {
  host: VisionGuardHost;
  target: VisionAttemptTarget;
  vision: VisionConfig;
  cfg: PricingConfig;
  record: (input: WorkerAiUsageInput) => UsageEvent | null;
  /** Merged into the usage of a rejected or failed call. */
  metadata?: Record<string, unknown>;
  call: (gate: VisionCallGate) => Promise<T>;
  onResult?: (result: T, gate: VisionCallGate) => void;
}): Promise<GuardedVisionOutcome<T>> {
  const page = { documentId: args.target.documentId, pageNumber: args.target.pageNumber };
  return await withVisionCall(args.host, args.target, async (gate) => {
    let result: T;
    try {
      result = await args.call(gate);
    } catch (error) {
      const stop = findVisionGuardStop(error);
      // A request refused after earlier ones were sent still records what those were billed.
      if (!stop || findVisionBilledUsage(error)) recordFailure({ ...args, page }, error);
      if (stop) return { admitted: false as const, stop };
      throw error;
    }
    args.onResult?.(result, gate);
    return { admitted: true as const, result };
  });
}

function recordFailure(
  args: { vision: VisionConfig; cfg: PricingConfig; page: { documentId: string; pageNumber: number };
    record: (input: WorkerAiUsageInput) => UsageEvent | null; metadata?: Record<string, unknown> },
  error: unknown,
): void {
  const route = resolveVisionRoute(args.vision);
  const rejected = findVisionOutputRejected(error);
  if (rejected) {
    const costCents = priceVisionUsage(args.vision, args.cfg, {
      inputTokens: rejected.inputTokens, outputTokens: rejected.outputTokens,
      ...(rejected.costCents !== undefined ? { costCents: rejected.costCents } : {}),
    });
    const input = rejectedVisionUsageInput(rejected, costCents, route.model);
    args.record({ ...input, metadata: { ...input.metadata, ...args.metadata, ...args.page } });
    return;
  }
  const billed = findVisionBilledUsage(error);
  if (!billed) return;
  const costCents = priceVisionUsage(args.vision, args.cfg, billed);
  args.record({
    provider: route.runtime === "remote-openai" ? "openai" : "vision-runtime",
    model: route.model,
    metric: "page-analysis-attempt",
    amount: 1,
    unit: "attempt",
    costCents,
    inputTokens: billed.inputTokens,
    outputTokens: billed.outputTokens,
    metadata: {
      ...args.metadata,
      ...args.page,
      outcome: "failure",
      reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      usageSource: billed.usageSource ?? (billed.costCents !== undefined ? "provider" : "estimated"),
      providerCostCents: costCents,
      billable: false,
    },
  });
}
