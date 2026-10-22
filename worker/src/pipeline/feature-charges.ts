import {
  DOCUMENT_FEATURE_METRICS,
  UNIT_CHARGE_PROVIDER,
  featureCredits,
  unitChargeMetadata,
  type DocumentFeature,
} from "@docslurp/shared";

import type { Document } from "../models.js";
import type { WorkflowState } from "./pipeline.js";

/**
 * Pages an optional feature is priced on: the document's pages, or for a media
 * file its Rich-equivalent pages (minutes x factor, recorded by the media stage).
 */
export function featurePages(state: WorkflowState, document: Pick<Document, "id" | "pageCount">): number {
  const media = Number(state.artifactLedger.read(`media-charge:${document.id}`));
  if (Number.isFinite(media) && media > 0) return media;
  return Math.max(1, Number(document.pageCount) || 0);
}

/**
 * Charge one optional per-document feature (PRICE_CARD: summary, structured
 * fields, knowledge graph, propositions) once per document per run. Called by
 * the feature's stage after it actually did the work, so a partial reprocess
 * that skips the stage pays nothing for it. The id makes a retried checkpoint
 * a no-op; the model tokens themselves are provider cost (billed 0).
 */
export function chargeDocumentFeature(state: WorkflowState, document: Pick<Document, "id" | "pageCount">, feature: DocumentFeature): void {
  const slot = `feature-charge:${feature}:${document.id}`;
  if (state.artifactLedger.read(slot)) return;
  const pages = featurePages(state, document);
  const credits = featureCredits(feature, pages);
  state.usageLedger.enqueue({
    id: `feature:${feature}:${state.run.id}:${document.id}`,
    provider: UNIT_CHARGE_PROVIDER,
    model: "price-card",
    metric: DOCUMENT_FEATURE_METRICS[feature],
    amount: 1,
    unit: "document",
    costCents: credits,
    inputTokens: 0,
    outputTokens: 0,
    metadata: unitChargeMetadata({ documentId: document.id, feature, pages }),
  });
  state.artifactLedger.record(slot, String(credits));
}
