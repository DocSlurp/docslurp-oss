import { billedPagePageEquivalents, DENSE_PAGE_EQUIVALENTS, imageAreaEquivalents, pageTextEquivalents, pricing } from "@docslurp/shared";

import type { Document } from "../models.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { formatNeedsMeasuredPages } from "./office-page-count.js";
import { authorizeMeasuredPages } from "./measured-page-authorization.js";
import { MAX_MEASURED_PDF_PAGES } from "./pdf-page-count.js";

/** Formats whose pages are real pages (PDF pages, image frames): the dense-page allowance applies to their text. */
const PAGED_FORMATS = new Set(["pdf", "image"]);

/** Pages a document may measure as, in page equivalents; more is refused rather than capped. */
export const MAX_PAGE_EQUIVALENTS = MAX_MEASURED_PDF_PAGES;

export interface ExtractedPageEquivalents {
  /** Pages measured (the extractor's form-feed pages). */
  pages: number;
  /** Sum over pages of max(1, text equivalents, area equivalents): what the pages hold. */
  equivalents: number;
  /** Sum over pages of what they bill: text under the dense-page allowance (paged formats), area in full. */
  billed: number;
  /** Pages whose text counts as more than DENSE_PAGE_EQUIVALENTS pages: possible hidden or stuffed text (ingest report). */
  densePages: number[];
  /** The document's billing_pages after recording, when it changed. */
  billingPages: number | null;
}

/**
 * Measures what each extracted page holds and bills it: the text rule over each form-feed page of the extractor's output
 * (and, for an uploaded image, each frame's decoded area), recorded as page equivalents (db/page-equivalents.ts), which
 * raise billing_pages (PDF pages and image frames: page_count plus each page's extra equivalents; whole-document text formats:
 * the text rule over all of their text, reconciled with page_count, which is that rule over the source); the extra pages are
 * then authorized against the balance. Office, slide, sheet and EPUB formats are
 * measured from their extractor output already (office-page-count.ts) and are left to that. Text that is tiny, invisible or
 * outside the visible box is extracted and indexed like any other, so it is counted here like any other: never dropped.
 * A document that measures above MAX_PAGE_EQUIVALENTS is refused.
 */
export async function recordExtractedPageEquivalents(
  state: WorkflowState,
  document: Document,
  format: string,
  markdown: string,
  frames: ReadonlyArray<{ pageNumber: number; sourceWidth?: number; sourceHeight?: number }> = [],
): Promise<ExtractedPageEquivalents | null> {
  if (formatNeedsMeasuredPages(format)) return null;
  const paged = PAGED_FORMATS.has(format);
  // The installed pricing provider's dense-page allowance (core's default: DEFAULT_PAGE_EQUIVALENT_ALLOWANCE) for paged documents.
  const allowance = paged ? pricing().pageEquivalentAllowance : 1;
  const pages = markdown.replace(/\f\s*$/, "").split("\f");
  const area = new Map(frames.filter((frame) => frame.sourceWidth && frame.sourceHeight)
    .map((frame) => [frame.pageNumber, imageAreaEquivalents(frame.sourceWidth!, frame.sourceHeight!)]));
  const rows = pages.map((text, index) => ({ pageNumber: index + 1, text: pageTextEquivalents(text), area: area.get(index + 1) ?? 1 }));
  // HTML, text, CSV, JSON and LaTeX have no structural pages: the text rule over all of their extracted text is the whole
  // count (the rule their page_count already is), never pages added to page_count.
  const equivalents = paged ? rows.reduce((sum, row) => sum + Math.max(row.text, row.area), 0) : pageTextEquivalents(pages.join("\n"));
  if (equivalents > MAX_PAGE_EQUIVALENTS) {
    console.error(`[page-equivalents] refused document=${document.id}: ${equivalents} page equivalents over ${pages.length} pages exceeds ${MAX_PAGE_EQUIVALENTS}`);
    throw new Error(`document exceeds ${MAX_PAGE_EQUIVALENTS} page equivalents`);
  }
  const densePages = rows.filter((row) => row.text > DENSE_PAGE_EQUIVALENTS).map((row) => row.pageNumber);
  const billed = paged ? rows.reduce((sum, row) => sum + billedPagePageEquivalents(row.text, row.area, allowance), 0) : equivalents;
  const above = rows.filter((row) => row.text > 1 || row.area > 1);
  let billingPages: number | null = null;
  const measuredAbove = paged
    ? above.length > 0
    : equivalents > Math.max(Number(document.billingPages) || 0, Math.trunc(Number(document.pageCount)) || 0);
  if (measuredAbove) {
    if (paged) {
      if (!state.store?.recordPageEquivalents) throw new Error("page equivalents measured but the store cannot persist them");
      billingPages = await state.store.recordPageEquivalents(state.run.id, document.id, above, allowance);
    } else {
      if (!state.store?.recordWholeDocumentPages) throw new Error("page equivalents measured but the store cannot persist them");
      billingPages = await state.store.recordWholeDocumentPages(state.run.id, document.id, equivalents);
    }
    if (billingPages !== null && billingPages > (Number(document.billingPages) || 0)) {
      document.billingPages = billingPages;
      document.billingPagesMethod = "page-equivalents";
    }
    console.log(`[page-equivalents] document=${document.id} pages=${pages.length} equivalents=${equivalents} billed=${billed} allowance=${allowance} dense=${densePages.length}`);
    await authorizeMeasuredPages(state, document);
  }
  return { pages: pages.length, equivalents, billed, densePages, billingPages };
}
