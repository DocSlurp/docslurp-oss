/**
 * Known-answer health probe for decision models.
 *
 * A decision model can degrade silently (2026-10-12: one hosted model started
 * returning the same probability for every question while its status page said
 * operational). The canary asks questions about a fixed, generic synthetic
 * text state whose correct answers differ sharply, and is healthy only if the
 * answers separate by a margin in the expected direction. Text-only, no
 * fixture content, ~150 input tokens (fractions of a cent).
 */

import type { DecisionModel } from "@docslurp/shared";

import type { DecisionCallResult, DecisionClient, DecisionQuestion } from "../decision-client.js";

export const CANARY_STATE =
  "Synthetic health-check page. It reads: Let x and y satisfy x^2 + y^2 = z^2. Then the integral of 2x dx " +
  "from 0 to 1 equals 1. This page is a short passage of printed algebra. It contains no pictures.";

export const CANARY_QUESTIONS: Record<string, DecisionQuestion> = {
  has_math: { type: "noul", instructions: "Does the state contain a mathematical equation?" },
  mentions_cat: { type: "noul", instructions: "Does the state mention a cat?" },
  // The expected option is deliberately not first: a model that always returns the first option must fail.
  subject: {
    type: "choice",
    instructions: "Which subject is the state about?",
    criteria: {
      animals: "Animals or pets",
      mathematics: "Mathematics, equations or algebra",
      cooking: "Food or cooking",
    },
  },
};

export interface CanaryThresholds {
  /** Minimum has_math - mentions_cat probability gap. */
  minGap: number;
  /** has_math must be at least this. */
  minPositive: number;
  /** mentions_cat must be at most this. */
  maxNegative: number;
  /** Expected choice must be picked with at least this probability. */
  minChoiceProbability: number;
  /** Expected choice must beat the runner-up option by at least this probability. */
  minChoiceMargin: number;
}

export const DEFAULT_CANARY_THRESHOLDS: CanaryThresholds = {
  minGap: 0.3,
  minPositive: 0.5,
  maxNegative: 0.5,
  minChoiceProbability: 0.5,
  minChoiceMargin: 0.2,
};

export interface CanaryReading {
  hasMath: number | null;
  mentionsCat: number | null;
  subject: string | null;
  subjectProbability: number | null;
  /** Probability gap between the picked option and the runner-up; null when probabilities are absent. */
  subjectMargin: number | null;
}

/** Health of one question type; PPLX-style failures are type-specific (noul degenerate, choice fine). */
export interface CanaryPart {
  healthy: boolean;
  reason: string;
}

export interface CanaryVerdict {
  /** noul AND choice both healthy. */
  healthy: boolean;
  reason: string;
  noul: CanaryPart;
  choice: CanaryPart;
  reading: CanaryReading;
}

function judgeNoul(reading: CanaryReading, t: CanaryThresholds): CanaryPart {
  if (reading.hasMath === null || reading.mentionsCat === null) return { healthy: false, reason: "noul canary answers missing or mistyped" };
  const gap = reading.hasMath - reading.mentionsCat;
  if (Math.abs(gap) < 1e-6) {
    return { healthy: false, reason: `canary degenerate: has_math and mentions_cat both ${reading.hasMath.toFixed(4)} (identical for different questions)` };
  }
  if (gap < t.minGap) {
    return { healthy: false, reason: `canary answers do not separate: has_math ${reading.hasMath.toFixed(3)} vs mentions_cat ${reading.mentionsCat.toFixed(3)} (gap ${gap.toFixed(3)} < ${t.minGap})` };
  }
  if (reading.hasMath < t.minPositive) return { healthy: false, reason: `canary has_math ${reading.hasMath.toFixed(3)} below ${t.minPositive}` };
  if (reading.mentionsCat > t.maxNegative) return { healthy: false, reason: `canary mentions_cat ${reading.mentionsCat.toFixed(3)} above ${t.maxNegative}` };
  return { healthy: true, reason: `ok gap=${gap.toFixed(3)}` };
}

function judgeChoice(reading: CanaryReading, t: CanaryThresholds): CanaryPart {
  if (reading.subject === null) return { healthy: false, reason: "choice canary answer missing or mistyped" };
  if (reading.subject !== "mathematics") return { healthy: false, reason: `canary subject chose "${reading.subject}", expected "mathematics"` };
  const p = reading.subjectProbability ?? 0;
  if (p < t.minChoiceProbability) return { healthy: false, reason: `canary subject probability ${p.toFixed(3)} below ${t.minChoiceProbability}` };
  if (reading.subjectMargin !== null && reading.subjectMargin < t.minChoiceMargin) {
    return { healthy: false, reason: `canary subject margin ${reading.subjectMargin.toFixed(3)} below ${t.minChoiceMargin} (options not separated)` };
  }
  return { healthy: true, reason: `ok p=${p.toFixed(3)}` };
}

/** Pure judgement of one canary response. Noul and choice questions are judged separately. */
export function judgeCanary(
  answers: DecisionCallResult["answers"],
  thresholds: CanaryThresholds = DEFAULT_CANARY_THRESHOLDS,
): CanaryVerdict {
  const math = answers.has_math;
  const cat = answers.mentions_cat;
  const subject = answers.subject;
  let margin: number | null = null;
  if (subject?.type === "choice") {
    const sorted = Object.values(subject.probabilities).sort((x, y) => y - x);
    if (sorted.length >= 2) margin = sorted[0]! - sorted[1]!;
  }
  const reading: CanaryReading = {
    hasMath: math?.type === "noul" ? math.noul : null,
    mentionsCat: cat?.type === "noul" ? cat.noul : null,
    subject: subject?.type === "choice" ? subject.choice : null,
    subjectProbability: subject?.type === "choice" ? (subject.probabilities[subject.choice] ?? subject.confidence) : null,
    subjectMargin: margin,
  };
  const noul = judgeNoul(reading, thresholds);
  const choice = judgeChoice(reading, thresholds);
  const healthy = noul.healthy && choice.healthy;
  const reason = healthy
    ? noul.reason
    : [!noul.healthy ? `noul: ${noul.reason}` : null, !choice.healthy ? `choice: ${choice.reason}` : null].filter(Boolean).join("; ");
  // Keep the historical reason text when only the noul part fails (callers and logs match on "canary degenerate").
  return { healthy, reason: !noul.healthy && choice.healthy ? noul.reason : reason, noul, choice, reading };
}

export interface CanaryResult extends CanaryVerdict {
  modelId: string;
  latencyMs: number;
  inputTokens: number;
  costCents: number;
}

/** Sends the canary through `client` (which records usage) and judges the response. Throws on transport errors. */
export async function runCanary(
  client: DecisionClient,
  model: DecisionModel,
  options: { signal?: AbortSignal; thresholds?: CanaryThresholds } = {},
): Promise<CanaryResult> {
  const result = await client.ask(model, CANARY_STATE, CANARY_QUESTIONS, { signal: options.signal });
  const verdict = judgeCanary(result.answers, options.thresholds);
  return {
    ...verdict,
    modelId: model.id,
    latencyMs: result.latencyMs,
    inputTokens: result.usage.inputTokens,
    costCents: result.costCents,
  };
}
