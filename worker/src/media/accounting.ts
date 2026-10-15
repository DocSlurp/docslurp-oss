/** Monetary evidence is never silently coerced between provider API families. */
export interface MediaAccounting {
  state: "estimated" | "disputed" | "reconciled";
  basis: "input-seconds" | "tokens" | "host-seconds";
  rateVersion: string;
  rateSource: string;
  reportedCostUsd?: number;
  estimatedCostUsd: number;
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
