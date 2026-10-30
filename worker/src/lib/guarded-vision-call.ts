import type { VisionConfig } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { UsageEvent } from "../models.js";
import type { WorkerAiUsageInput } from "./ai-usage.js";
import {
  configuredVisionServedRoute,
  findVisionPrimaryFailure,
  rejectedVisionUsageInput,
  type VisionExecutionResult,
  type VisionPrimaryFailure,
} from "../tools/vision-runtime.js";
import { findVisionBilledUsage, findVisionOutputRejected } from "../tools/vision-stream.js";
import { findVisionServedRoute, priceVisionServedUsage, type VisionServedRoute } from "./vision-pricing.js";
import {
  findVisionGuardStop,
  withVisionCall,
  type VisionAttemptTarget,
  type VisionCallGate,
  type VisionGuardHost,
  type VisionGuardStop,
} from "./vision-attempt-guard.js";

type PricingConfig = Pick<Config, "openAiBaseUrl" | "costPer1kInputTokens" | "costPer1kOutputTokens">;

/** Provider cost of a successful vision result, on the route that served it. */
export function priceVisionResult(
  result: Pick<VisionExecutionResult, "route" | "inputTokens" | "outputTokens" | "costCents">,
  cfg: PricingConfig,
): number {
  return priceVisionServedUsage(result.route, cfg, result);
}

/** A billed vision failure's usage, priced and labelled on the route that was billed. */
export interface VisionFailureUsage {
  kind: "rejected" | "billed";
  route: VisionServedRoute;
  input: WorkerAiUsageInput;
}

/**
 * Usage of every billed request behind a failed vision call: its own route's rejected output or billed failure,
 * and the primary route's when the call failed on its fallback. Each is priced on the route that was billed
 * (`findVisionServedRoute`); `vision` is only the label for an error raised before any route was chosen.
 */
export function visionFailureUsages(
  error: unknown,
  vision: VisionConfig,
  cfg: PricingConfig,
  metadata: Record<string, unknown> = {},
): VisionFailureUsage[] {
  const own = billedFailureUsage(error, findVisionServedRoute(error) ?? configuredVisionServedRoute(vision, cfg), cfg, metadata);
  const primary = findVisionPrimaryFailure(error);
  return [...(primary ? primaryFailureUsages(primary, cfg, metadata) : []), ...(own ? [own] : [])];
}

/** The primary route's billed failure behind a result the fallback served (empty when there is none). */
export function primaryFailureUsages(
  primary: VisionPrimaryFailure | undefined,
  cfg: PricingConfig,
  metadata: Record<string, unknown> = {},
): VisionFailureUsage[] {
  if (!primary) return [];
  const usage = billedFailureUsage(primary.error, primary.route, cfg, { ...metadata, fallbackPrimary: true });
  return usage ? [usage] : [];
}

function billedFailureUsage(
  error: unknown,
  route: VisionServedRoute,
  cfg: PricingConfig,
  metadata: Record<string, unknown>,
): VisionFailureUsage | null {
  const rejected = findVisionOutputRejected(error);
  if (rejected) {
    const costCents = priceVisionServedUsage(route, cfg, {
      inputTokens: rejected.inputTokens, outputTokens: rejected.outputTokens,
      ...(rejected.costCents !== undefined ? { costCents: rejected.costCents } : {}),
    });
    const input = rejectedVisionUsageInput(rejected, costCents, route);
    return { kind: "rejected", route, input: { ...input, metadata: { ...input.metadata, runtime: route.runtime, ...metadata } } };
  }
  const billed = findVisionBilledUsage(error);
  if (!billed) return null;
  const costCents = priceVisionServedUsage(route, cfg, billed);
  return {
    kind: "billed",
    route,
    input: {
      provider: route.provider,
      model: route.model,
      metric: "page-analysis-attempt",
      amount: 1,
      unit: "attempt",
      costCents,
      inputTokens: billed.inputTokens,
      outputTokens: billed.outputTokens,
      metadata: {
        runtime: route.runtime,
        ...metadata,
        outcome: "failure",
        reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        usageSource: billed.usageSource ?? (billed.costCents !== undefined ? "provider" : "estimated"),
        providerCostCents: costCents,
        billable: false,
      },
    },
  };
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
  const record = (usages: VisionFailureUsage[]) => {
    for (const usage of usages) args.record({ ...usage.input, metadata: { ...usage.input.metadata, ...args.metadata, ...page } });
  };
  return await withVisionCall(args.host, args.target, async (gate) => {
    let result: T;
    try {
      result = await args.call(gate);
    } catch (error) {
      const stop = findVisionGuardStop(error);
      // A request refused after earlier ones were sent still records what those were billed.
      record(visionFailureUsages(error, args.vision, args.cfg));
      if (stop) return { admitted: false as const, stop };
      throw error;
    }
    // A fallback-served result: the primary route's billed failure is ours too.
    record(primaryFailureUsages((result as { primaryFailure?: VisionPrimaryFailure }).primaryFailure, args.cfg));
    args.onResult?.(result, gate);
    return { admitted: true as const, result };
  });
}
