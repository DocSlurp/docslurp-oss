import {
  buildPricedAiUsageLedgerEvent,
  formatAiUsageConsoleLog,
  hasAiUsageLedgerTokens,
  priceAiUsageEvent,
  type AiUsageLedgerEvent,
  type AiUsagePricing,
} from "@docslurp/shared";
import type { JsonMap } from "../models.js";

export type WorkerAiUsageEvent = AiUsageLedgerEvent;

export interface WorkerAiUsageInput {
  provider: string;
  model: string;
  metric: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  amount?: number;
  unit?: string;
  costCents?: number;
  pricing?: AiUsagePricing;
  metadata?: JsonMap;
  logOutputTokens?: boolean;
}

export function buildWorkerAiUsageEvent(
  input: WorkerAiUsageInput,
): WorkerAiUsageEvent {
  return priceAiUsageEvent(buildPricedAiUsageLedgerEvent(input, {
    fallback: input.pricing,
  }));
}

export function hasWorkerAiUsage(event: WorkerAiUsageEvent): boolean {
  return hasAiUsageLedgerTokens(event);
}

/** Recording goes through `PipelineUsageEventLedger`; this only formats the log line. */
export function logWorkerAiUsage(
  event: WorkerAiUsageEvent,
  options: { includeOutputTokens?: boolean } = {},
): void {
  console.log(formatAiUsageConsoleLog(event, options));
}
