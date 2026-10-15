import type { DecisionProbabilities, DecisionQuestionId, ImageKindProbabilities, PageInput } from "@docslurp/shared";

// Optional embedding pre-filter for the decision-model router (W8, H5 inconclusive): a frozen image encoder
// (SigLIP2 / CLIP / MobileCLIP) plus a per-question probe turns a page thumbnail into the same typed
// probabilities a decision model returns; pages it is confident about never reach the paid model. The encoder
// runs outside the worker (sidecar or batch job) and is injected through `EmbeddingProbeProvider`; production
// configures none, so the seam is off unless RoutePagesDeps.embeddingPrefilter is given.

/** One page's output from the embedding probe. */
export interface EmbeddingPageProbe {
  /** Raw per-question probabilities (subset allowed), same ids as decision models. */
  probabilities: DecisionProbabilities;
  /** Optional page-level image_kind distribution (multinomial probe or zero-shot softmax). */
  imageKind?: ImageKindProbabilities;
  /** Local compute cost for this page in USD (CPU worker-seconds x slot price); 0 if unknown. */
  costUsd?: number;
  latencyMs?: number;
}

/** Everything a provider must say about the encoder (for provenance and calibration lookup). */
export interface EmbeddingProbeModel {
  /** Calibration key into PolicyPack.calibrations, e.g. "siglip2-base-patch16-224@probe-v1". */
  id: string;
  /** Input edge of the thumbnail, px (recorded as triage.tilePx). */
  tilePx: number;
}

/** Computes embedding-probe probabilities for pages (in-process, sidecar or precomputed lookup). */
export type EmbeddingProbeProvider = (pages: PageInput[]) => Promise<Map<number, EmbeddingPageProbe>>;

export interface EmbeddingPrefilter {
  provider: EmbeddingProbeProvider;
  model: EmbeddingProbeModel;
  /** A page is uncertain when any content question lies inside [lo, hi]. */
  band: [number, number];
}

/** True when any of `questions` has a probability inside the band (the probe cannot decide). */
export function isUncertain(probs: DecisionProbabilities, band: [number, number], questions: readonly DecisionQuestionId[]): boolean {
  const [lo, hi] = band;
  return questions.some((q) => {
    const p = probs[q];
    return typeof p === "number" && p >= lo && p <= hi;
  });
}
