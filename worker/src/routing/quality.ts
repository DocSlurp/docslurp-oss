/**
 * Cheap output-quality proxy for plan validation. No ground truth exists at run time, so this
 * measures plausibility (the worker's existing extraction-plausibility signals) and whether the
 * output survives the free cascade checks. It is a proxy, not extraction accuracy: the method id
 * is stored beside every value so consumers never mistake it for a labeled score.
 */

import type { AssignmentRole } from "@docslurp/shared";

import { scoreExtractionPlausibility } from "../lib/extracted-markdown.js";
import { freeCascadeTrigger } from "./cascade.js";

export const PLAN_QUALITY_METHOD = "output-plausibility@v1";

/** Plausibility at or above this reads as text-like output. */
export const PLAUSIBILITY_PASS_THRESHOLD = 0.3;

/** Roles whose output is page prose, where char-yield style plausibility is meaningful. */
const PROSE_ROLES = new Set<AssignmentRole>(["accept-text", "extract-text", "ocr", "math", "table"]);

export interface OutputQuality {
  /** Plausibility in [0,1] for prose roles; null for short scoped outputs (captions, chart data). */
  quality: number | null;
  passed: boolean;
}

export function scoreOutputQuality(args: { text: string; role: AssignmentRole; finishReason?: string | null }): OutputQuality {
  const trigger = freeCascadeTrigger({ text: args.text, finishReason: args.finishReason });
  if (trigger !== null) {
    const quality = PROSE_ROLES.has(args.role) ? scoreExtractionPlausibility(args.text, 1).plausibilityScore : null;
    return { quality, passed: false };
  }
  if (!PROSE_ROLES.has(args.role)) return { quality: null, passed: true };
  const quality = scoreExtractionPlausibility(args.text, 1).plausibilityScore;
  return { quality, passed: quality >= PLAUSIBILITY_PASS_THRESHOLD };
}
