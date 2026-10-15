/**
 * Runtime degeneracy detection for decision-model answers.
 *
 * On 2026-10-12 a hosted decision model silently began returning one identical
 * probability for every question while its status page said operational. A real
 * request asks many DISTINCT questions (different attributes of different
 * pages), so a model that is actually reading the state cannot answer them all
 * with (nearly) the same number, nor with all-0.5 "no information" outputs.
 * Detection is input-free: it only looks at the answers.
 */

export type DegenerateKind = "constant" | "all-half";

export interface DegenerateVerdict {
  kind: DegenerateKind;
  count: number;
  min: number;
  max: number;
  std: number;
}

export interface DegenerateOptions {
  /** Fewer answers than this cannot be judged (a lone question may legitimately be anything). */
  minAnswers?: number;
  /** Population standard deviation below this counts as "the same answer for every question". */
  maxStd?: number;
  /** Every answer within this distance of 0.5 counts as an uninformative all-0.5 output. */
  halfBand?: number;
}

export const DEGENERATE_DEFAULTS = { minAnswers: 6, maxStd: 0.005, halfBand: 0.03 } as const;

export function detectDegenerate(values: readonly number[], options: DegenerateOptions = {}): DegenerateVerdict | null {
  const { minAnswers, maxStd, halfBand } = { ...DEGENERATE_DEFAULTS, ...options };
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < minAnswers) return null;
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const std = Math.sqrt(finite.reduce((a, b) => a + (b - mean) ** 2, 0) / finite.length);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const base = { count: finite.length, min, max, std };
  if (finite.every((v) => Math.abs(v - 0.5) <= halfBand)) return { kind: "all-half", ...base };
  if (std < maxStd) return { kind: "constant", ...base };
  return null;
}

export function describeDegenerate(verdict: DegenerateVerdict): string {
  const range = `${verdict.min.toFixed(4)}..${verdict.max.toFixed(4)}`;
  return verdict.kind === "all-half"
    ? `degenerate: ${verdict.count} answers all ~0.5 (${range})`
    : `degenerate: ${verdict.count} distinct questions answered identically (${range}, std ${verdict.std.toExponential(1)})`;
}

export class DecisionDegenerateError extends Error {
  readonly code = "DECISION_MODEL_DEGENERATE";
  constructor(readonly modelId: string, readonly verdict: DegenerateVerdict) {
    super(`${modelId} ${describeDegenerate(verdict)}`);
    this.name = "DecisionDegenerateError";
  }
}

/** The noul probabilities and the top-choice confidences of an answers record, as comparable numbers. */
export function answerSignals(
  answers: Record<string, { type: string; noul?: number; confidence?: number }>,
): number[] {
  const out: number[] = [];
  for (const answer of Object.values(answers)) {
    if (answer.type === "noul" && typeof answer.noul === "number") out.push(answer.noul);
  }
  return out;
}
