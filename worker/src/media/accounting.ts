/** Monetary evidence is never silently coerced between provider API families. */
export interface MediaAccounting {
  state: "estimated" | "disputed" | "reconciled";
  basis: "input-seconds" | "tokens" | "host-seconds";
  rateVersion: string;
  rateSource: string;
  reportedCostUsd?: number;
  estimatedCostUsd: number;
  /** Which figure `costUsd` holds: the provider's reported cost when it agrees with the rate estimate, else the estimate. */
  recordedFrom?: "provider" | "estimate";
  providerRequestId?: string;
  inputTokens?: number;
  outputTokens?: number;
}
export const MEDIA_RATE_VERSION = "deepinfra-2026-10-13";
export const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
export function tokenCost(input: number, output: number, inputPerMillion: number, outputPerMillion: number): number {
  if (![input, output, inputPerMillion, outputPerMillion].every(nonnegative) || !Number.isInteger(input) || !Number.isInteger(output)) throw new Error("Invalid media token accounting");
  // Nanodollar precision avoids rounding sub-cent calls to zero.
  return Math.round((input * inputPerMillion + output * outputPerMillion) * 1000) / 1e9;
}
export function disputed(reported: number | undefined, estimated: number): boolean {
  return reported !== undefined && Math.abs(reported - estimated) > Math.max(1e-9, estimated * .25);
}

/**
 * The cost to record: the provider-reported figure when it is within the
 * dispute tolerance of the rate estimate (the actual charge), otherwise the
 * estimate. A disputed figure is never recorded; it stays as evidence for
 * reconciliation.
 */
export function recordedMediaCost(reported: number | undefined, estimated: number): { costUsd: number; recordedFrom: "provider" | "estimate" } {
  return reported !== undefined && !disputed(reported, estimated) ? { costUsd: reported, recordedFrom: "provider" } : { costUsd: estimated, recordedFrom: "estimate" };
}
