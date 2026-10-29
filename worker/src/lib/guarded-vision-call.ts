import { resolveVisionRoute, visionListPriceCents, type VisionConfig } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { UsageEvent } from "../models.js";
import type { WorkerAiUsageInput } from "./ai-usage.js";
import { rejectedVisionUsageInput, type VisionExecutionResult } from "../tools/vision-runtime.js";
import { findVisionBilledUsage, findVisionOutputRejected } from "../tools/vision-stream.js";
import { isBillableVisionRuntime, visionReserveCents } from "./vision-reserve.js";
import { readPngFileFacts } from "./page-image-evidence.js";
import { visionGuardFor, type VisionGuardHost, type VisionGuardStop, type VisionSettlement } from "./vision-spend-guard.js";

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
 * One vision provider call outside vision-extract (document-map OCR, self-critique, deferred page
 * materialization) under the run's vision guard (lib/vision-spend-guard.ts): admits a reservation
 * at the call's own model price over this image's size, runs it, and settles once. A refused call
 * makes no provider call. A rejected or failed call records its billed spend here (unbilled, once)
 * and rethrows. A successful call's usage stays with the caller, which `price`s it for the
 * settlement.
 */
export async function guardedVisionCall<T = VisionExecutionResult>(args: {
  host: VisionGuardHost;
  vision: VisionConfig;
  cfg: PricingConfig;
  /** The image the call sends, for its size; absent when the call renders it (reserves for the largest raster). */
  imagePath?: string;
  /** The full prompt when the caller replaces the route's (self-critique). */
  prompt?: string;
  page: { documentId: string; pageNumber: number };
  record: (input: WorkerAiUsageInput) => UsageEvent | null;
  /** Merged into the usage of a rejected or failed call. */
  metadata?: Record<string, unknown>;
  call: () => Promise<T>;
  /** Provider cost of a successful call, as the caller records it. */
  price: (result: T) => number;
}): Promise<GuardedVisionOutcome<T>> {
  const size = args.imagePath ? await readPngFileFacts(args.imagePath).catch(() => null) : null;
  const reserveCents = visionReserveCents(args.vision, args.cfg, size, args.prompt !== undefined ? { prompt: args.prompt } : {});
  const admission = await visionGuardFor(args.host).admit(reserveCents);
  if (!admission.admitted) return admission;
  let settlement: VisionSettlement = { costCents: reserveCents, billable: false, page: { ...args.page, rejected: false } };
  try {
    let result: T;
    try {
      result = await args.call();
    } catch (error) {
      const recorded = recordFailure(args, error);
      settlement = { costCents: recorded.costCents, billable: false, page: { ...args.page, rejected: recorded.rejected } };
      throw error;
    }
    settlement = { costCents: args.price(result), billable: true, page: { ...args.page, rejected: false } };
    return { admitted: true, result };
  } finally {
    await admission.settle(settlement);
  }
}

function recordFailure(
  args: { vision: VisionConfig; cfg: PricingConfig; page: { documentId: string; pageNumber: number };
    record: (input: WorkerAiUsageInput) => UsageEvent | null; metadata?: Record<string, unknown> },
  error: unknown,
): { costCents: number; rejected: boolean } {
  const route = resolveVisionRoute(args.vision);
  const rejected = findVisionOutputRejected(error);
  if (rejected) {
    const costCents = priceVisionUsage(args.vision, args.cfg, {
      inputTokens: rejected.inputTokens, outputTokens: rejected.outputTokens,
      ...(rejected.costCents !== undefined ? { costCents: rejected.costCents } : {}),
    });
    const input = rejectedVisionUsageInput(rejected, costCents, route.model);
    args.record({ ...input, metadata: { ...input.metadata, ...args.metadata, ...args.page } });
    return { costCents, rejected: true };
  }
  const billed = findVisionBilledUsage(error);
  if (!billed) return { costCents: 0, rejected: false };
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
      usageSource: billed.costCents !== undefined ? "provider" : "estimated",
      providerCostCents: costCents,
      billable: false,
    },
  });
  return { costCents, rejected: false };
}
