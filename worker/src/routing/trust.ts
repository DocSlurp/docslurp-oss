/**
 * Trust in the native text layer, decided by free probe signals (TL1).
 *
 * TL1 found that asking a decision model "can the text layer be trusted?" for a whole page hurts: the
 * thumbnail cannot show a small inset or a stale OCR layer. What works is a short cascade of cheap, generic
 * checks, each of which can only remove trust:
 *   1. probe status: `ok` is trusted; `ocr-layer` (text over a page-sized image), `suspect` and `absent` are not;
 *   2. OCR-layer agreement: a band of an `ocr-layer` page is re-OCRed and compared with the layer; an
 *      agreement at or above `ocrLayerAgreementMin` restores trust;
 *   3. math gate: pages with math glyphs keep their text layer out of the accept-text-only path;
 *   4. inset gate (decision model on image crops, see inset-triage.ts) for pages with embedded images
 *      covering part of the page.
 * Steps 1-3 are pure and live here; step 4 needs a model call and is wired in the decision-model router.
 */

import type { PageInput } from "@docslurp/shared";

export const TRUST_RULE = {
  /** Minimum agreement of an OCR layer with a fresh OCR of a band of the page (TL1 tuned on dev+calibration: 0.4). */
  ocrLayerAgreementMin: 0.4,
  /**
   * Pages with at least this share of math-font glyphs are not accept-text-only.
   * PROVISIONAL: chosen after seeing the TL1 development/calibration data (0.01 separated its math pages);
   * it has not been validated on independently collected pages and should be re-fit when more data exists.
   */
  mathGlyphRatio: 0.01,
  /** Insets covering less than this are logos/decoration; no paid question (matches inset-triage minCoverage floor). */
  insetCoverageMin: 0.02,
  /** Insets covering at least this are page scans; the page-level logic owns them. */
  insetCoverageMax: 0.85,
  /** P(inset must be transcribed) at or above this stops the page being accept-text-only. */
  insetNeedsTranscription: 0.4,
} as const;

export type TrustRuleReason =
  | "text-layer-ok"
  | "ocr-layer-agrees"
  | "ocr-layer-disagrees"
  | "ocr-layer-unverified"
  | "text-layer-suspect"
  | "no-text-layer"
  | "garbled-text-layer"
  | "math-glyphs";

export interface FreeTrustVerdict {
  /** Native text layer may stand as the page text (before the inset gate). */
  trusted: boolean;
  reason: TrustRuleReason;
  /** True when trust was withheld only by the math gate. */
  mathGated: boolean;
}

/** Steps 1-3 of the trust cascade. Pure. */
export function freeTrustVerdict(page: PageInput): FreeTrustVerdict {
  const { textFacts: tf, features: f } = page;
  let trusted: boolean;
  let reason: TrustRuleReason;
  if (f.native.garbled || f.native.unmappedGlyphRatio > 0.1) {
    trusted = false;
    reason = "garbled-text-layer";
  } else if (tf.textLayerStatus === "ok") {
    trusted = true;
    reason = "text-layer-ok";
  } else if (tf.textLayerStatus === "ocr-layer") {
    const agreement = tf.ocrLayerAgreement;
    if (agreement === null || agreement === undefined) {
      trusted = false;
      reason = "ocr-layer-unverified";
    } else if (agreement >= TRUST_RULE.ocrLayerAgreementMin) {
      trusted = true;
      reason = "ocr-layer-agrees";
    } else {
      trusted = false;
      reason = "ocr-layer-disagrees";
    }
  } else if (tf.textLayerStatus === "absent") {
    trusted = false;
    reason = "no-text-layer";
  } else {
    trusted = false;
    reason = "text-layer-suspect";
  }
  if (trusted && f.native.mathGlyphRatio >= TRUST_RULE.mathGlyphRatio) {
    return { trusted: false, reason: "math-glyphs", mathGated: true };
  }
  return { trusted, reason, mathGated: false };
}

/** Embedded images the inset gate would look at: covering 2-85% of the page. */
export function insetGateCandidates(page: PageInput): PageInput["images"] {
  return page.images.filter(
    (image) => image.coverage >= TRUST_RULE.insetCoverageMin && image.coverage < TRUST_RULE.insetCoverageMax,
  );
}
