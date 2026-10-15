/**
 * Inset gate (TL1 + TL2): for a page whose text layer passed the free trust checks but which carries embedded
 * images covering 2-85% of it, a decision model looks at each image as a crop and says what it is. Insets that
 * must be transcribed (scanned text, table or equation images, handwriting) mean the page is no longer
 * accept-text-only; every inset becomes an image-scoped plan entry routed by its kind.
 */

import type { BBox, DecisionModel, ImageFact, PageInput } from "@docslurp/shared";

import type { DecisionClient } from "./decision-client.js";
import {
  DEFAULT_INSET_TRIAGE_CONFIG,
  adjustPageTrust,
  triageInsets,
  type InsetAssessment,
  type InsetTriageConfig,
  type InsetTriageResult,
  type InsetTrustAdjustment,
} from "./inset-triage.js";
import type { PageNeeds } from "./planner.js";
import { TRUST_RULE } from "./trust.js";

export interface InsetGate {
  /** Decision model asked about the crops (id recorded in the plan). */
  readonly model: DecisionModel;
  /** Null when the gate could not run for this page (no render, model error): the caller must not trust the page. */
  assess(page: PageInput, candidates: readonly ImageFact[]): Promise<InsetTriageResult | null>;
}

export interface InsetGateDeps {
  client: DecisionClient;
  model: DecisionModel;
  /** Page render (path or encoded bytes) large enough to crop insets from; null when unavailable. */
  renderPage: (pageNumber: number) => Promise<string | Uint8Array | null>;
  /**
   * Native clip render of one padded inset box (PDF points) of a page, or null when unavailable. When set, insets are cut
   * from clips and the full-page render is only requested if a clip fails (PDF_RASTER_ENGINE=native-pdf).
   */
  renderClip?: (pageNumber: number, box: BBox) => Promise<Uint8Array | null>;
  config?: Partial<InsetTriageConfig>;
  signal?: AbortSignal;
}

export const INSET_GATE_CONFIG: InsetTriageConfig = {
  ...DEFAULT_INSET_TRIAGE_CONFIG,
  needsTranscriptionThreshold: TRUST_RULE.insetNeedsTranscription,
};

export function createInsetGate(deps: InsetGateDeps): InsetGate {
  const config: InsetTriageConfig = { ...INSET_GATE_CONFIG, ...deps.config };
  return {
    model: deps.model,
    async assess(page, candidates) {
      if (!deps.model.modalities.image || candidates.length === 0) return null;
      const pageNumber = page.features.pageNumber;
      let render: string | Uint8Array | null = null;
      if (!deps.renderClip) {
        render = await deps.renderPage(pageNumber);
        if (!render) return null;
      }
      return triageInsets(
        deps.client,
        deps.model,
        {
          images: candidates,
          pageSizePt: { widthPt: page.features.geometry.widthPt, heightPt: page.features.geometry.heightPt },
          pageRender: render ?? (() => deps.renderPage(pageNumber)),
          ...(deps.renderClip ? { renderClip: (box: BBox) => deps.renderClip!(pageNumber, box) } : {}),
        },
        config,
        { signal: deps.signal },
      );
    },
  };
}

/** Page-level reading of an inset triage result. */
export function insetVerdict(result: InsetTriageResult, config: Partial<InsetTriageConfig> = {}): InsetTrustAdjustment {
  return adjustPageTrust(result.assessments, { ...INSET_GATE_CONFIG, ...config });
}

/** Image-scoped needs from inset assessments: each assessed inset takes the model's kind and confidence. */
export function withInsetAssessments(needs: PageNeeds, assessments: readonly InsetAssessment[]): PageNeeds {
  if (assessments.length === 0) return needs;
  const byIndex = new Map(assessments.map((a) => [a.imageIndex, a]));
  return {
    ...needs,
    images: needs.images.map((image) => {
      const a = byIndex.get(image.index);
      if (!a) return image;
      return { ...image, kind: a.kind, confidence: a.kindProbabilities[a.kind] ?? 0.5 };
    }),
  };
}
