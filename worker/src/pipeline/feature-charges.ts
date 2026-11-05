import {
  DOCUMENT_FEATURE_METRICS,
  TEXT_PAGE_CHARS,
  TEXT_PAGE_CJK_WEIGHT,
  UNIT_CHARGE_PROVIDER,
  featureCredits,
  featurePagesRead,
  unitChargeMetadata,
  type DocumentFeature,
} from "@docslurp/shared";

import type { Document } from "../models.js";
import type { WorkflowState } from "./pipeline.js";

type FeatureDocument = Pick<Document, "id" | "pageCount"> & Partial<Pick<Document, "billingPages" | "billingPagesMethod">>;

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿ｦ-ﾟ]/gu;

/**
 * Pages of reading in `chars` characters of model-read text under the text rule: TEXT_PAGE_CHARS characters a page, East Asian
 * characters weighing TEXT_PAGE_CJK_WEIGHT each (media-upload-estimate.ts textPageCount). `cjk` is how many of them are such.
 */
export function textReadPages(chars: number, cjk = 0): number {
  const weighted = Math.max(0, chars) + Math.max(0, cjk) * (TEXT_PAGE_CJK_WEIGHT - 1);
  return Math.ceil(weighted / TEXT_PAGE_CHARS);
}

/** How many East Asian characters `text` holds (they weigh TEXT_PAGE_CJK_WEIGHT each toward a page). */
export function cjkCount(text: string): number {
  return text.match(CJK_RE)?.length ?? 0;
}

/** Pages of reading in some text (blank space trimmed), by the same rule. */
export function textPagesOfText(text: string): number {
  const trimmed = text.trim();
  return trimmed ? textReadPages(trimmed.length, cjkCount(trimmed)) : 0;
}

/**
 * Pages an optional feature is priced on: the document's billed pages (the worker's measured count for an Office, slide, sheet or EPUB
 * file, else the page basis), or for a media file its Rich-equivalent pages (minutes x factor, recorded by the media stage).
 *
 * `textPages` is how much text the document holds, when the stage knows it. A count the worker measured (LibreOffice's pages of a
 * Word file, a sheet's rows, an EPUB's chapters, the text rule) is capped by it: a document of thousands of blank pages is thousands
 * of pages of base fee, but a feature reads only text, so it never bills more pages than the text holds. Slides are the exception:
 * a slide is a page whatever it holds. A count guessed from the file's size (`size-estimate`) never prices a feature: it bills the
 * text the stage read, or the intake count when that is unknown.
 */
export function featurePages(state: WorkflowState, document: FeatureDocument, options: { textPages?: number } = {}): number {
  const media = Number(state.artifactLedger.read(`media-charge:${document.id}`));
  if (Number.isFinite(media) && media > 0) return media;
  return documentFeaturePages(document, options);
}

/** featurePages for a paged (non-media) document, for callers outside a run (the graph rebuild job). */
export function documentFeaturePages(document: Omit<FeatureDocument, "id">, options: { textPages?: number } = {}): number {
  const intake = Math.max(1, Number(document.pageCount) || 0);
  const method = document.billingPagesMethod ?? null;
  const billed = Number(document.billingPages) > 0 ? Math.max(1, Math.floor(Number(document.billingPages))) : intake;
  const textPages = options.textPages;
  const knownText = textPages !== undefined && Number.isFinite(textPages);
  if (method === "size-estimate") return knownText ? Math.max(1, Math.floor(textPages)) : intake;
  if (method !== null && method !== "slides" && knownText) return Math.max(1, Math.min(billed, Math.floor(textPages)));
  return billed;
}

/**
 * Bring one feature's charge for this document up to its price on `pages`. The first call enqueues the charge; a later call that
 * prices more pages (a retried stage that read further, a window that finished after the first) enqueues only the difference, with
 * an id that names the new total, so a replayed checkpoint inserts nothing twice and a call that prices no more adds nothing.
 * Run artifacts and usage events commit in one transaction, so the slot below is never ahead of or behind the events it records.
 */
function raiseFeatureCharge(state: WorkflowState, document: FeatureDocument, feature: DocumentFeature, pages: number): number {
  const slot = `feature-charge:${feature}:${document.id}`;
  const billed = Number(state.artifactLedger.read(slot)) || 0;
  const target = featureCredits(feature, pages);
  if (!(target > billed + 1e-9)) return billed;
  const base = `feature:${feature}:${state.run.id}:${document.id}`;
  state.usageLedger.enqueue({
    id: billed > 0 ? `${base}:topup:${target}` : base,
    provider: UNIT_CHARGE_PROVIDER,
    model: "price-card",
    metric: DOCUMENT_FEATURE_METRICS[feature],
    amount: 1,
    unit: "document",
    costCents: target - billed,
    inputTokens: 0,
    outputTokens: 0,
    metadata: unitChargeMetadata({ documentId: document.id, feature, pages, ...(billed > 0 ? { topUpFrom: billed } : {}) }),
  });
  state.artifactLedger.record(slot, String(target));
  return target;
}

/**
 * Charge one optional per-document feature (PRICE_CARD: summary, structured
 * fields, knowledge graph, propositions) once per document per run. Called by
 * the feature's stage after it actually did the work, so a partial reprocess
 * that skips the stage pays nothing for it. The id makes a retried checkpoint
 * a no-op; the model tokens themselves are provider cost (billed 0).
 */
export function chargeDocumentFeature(
  state: WorkflowState,
  document: FeatureDocument,
  feature: DocumentFeature,
  /**
   * How much of the document the feature's model read (pages, or characters), when that is less than all of it:
   * long documents are read in windows. The price is the document's pages pro rata on that share.
   */
  read?: { read: number; total: number },
  options: { textPages?: number } = {},
): void {
  const documentPages = featurePages(state, document, options);
  raiseFeatureCharge(state, document, feature, read ? featurePagesRead(documentPages, read.read, read.total) : documentPages);
}

/**
 * Charge a feature for the text its model actually read: the share of the document's pages the read covered, at least the pages of
 * text read (TEXT_PAGE_CHARS characters a page). A page count says nothing of how much text a 1-page PDF holds, and a window that
 * finished before a later one failed was still read. Calling it again with a larger read raises the charge; it never lowers it.
 * `total` (the document's text) prorates the page floor when only part of it was read; omit it when the whole document was.
 * Spend counts against the run's cost cap the moment it is enqueued (checkpoints.ts runSpentCents).
 */
export function chargeFeatureForTextRead(
  state: WorkflowState,
  document: FeatureDocument,
  feature: DocumentFeature,
  read: { chars: number; cjk?: number; total?: { chars: number; cjk?: number }; floorPages?: boolean; textPages?: number },
): number {
  if (!(read.chars > 0)) return 0;
  const documentPages = featurePages(state, document, { textPages: read.textPages });
  const share = read.floorPages === false
    ? 0
    : read.total && read.total.chars > read.chars
      ? featurePagesRead(documentPages, read.chars, read.total.chars)
      : documentPages;
  return raiseFeatureCharge(state, document, feature, Math.max(share, textReadPages(read.chars, read.cjk)));
}
