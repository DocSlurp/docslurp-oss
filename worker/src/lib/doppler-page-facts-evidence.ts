/**
 * Routing evidence built from Doppler page facts (`doppler-page-facts/1`, validated by lib/doppler-page-facts.ts) for a PDF the
 * sandboxed provider extracted. That route never runs the host's Poppler probes (page facts' `pdfimages -list` and `pdftotext`,
 * page triage's `pdfimages -list` and `pdfinfo`), so without this it goes without page-image evidence and without the ingest
 * report's per-page source rows. Pure: no I/O, no clock, no command.
 *
 * Rules:
 * - All or nothing. The facts must cover every page of the host's own count with the families the evidence reads
 *   (`dopplerFactsCoverEvidence`): a complete stream, nothing dropped, no document error or lock, and per page `text` plus a
 *   complete `images` list. Anything less is a refusal with a reason, and the caller keeps today's behaviour (no evidence);
 *   nothing is guessed or filled in.
 * - Same rules as the probes. Sparse pages, significant images and repeated page furniture follow page-image-evidence.ts and
 *   PAGE_RASTER_ROUTING; text-layer quality is assessed on the extracted page text, as the host does when it has no layer.
 * - Never billing. Page counts stay the host's (pdfpagecount); the facts' own `pageCount` is never read. The per-page rows carry
 *   no size and no read, and a caller must not write them for a run that bills scanned pages from page facts at completion
 *   (page-base-fee.ts runBillsScansAtCompletion).
 */
import { MIN_SIGNIFICANT_IMAGE_COVERAGE, MIN_SIGNIFICANT_IMAGE_PIXELS, SPARSE_PAGE_WORDS, pageEvidenceWordCount, type PageImageEvidence } from "./page-image-evidence.js";
import { dopplerPageFactsLowConfidence, type DopplerPageFacts, type DopplerPageFactsDocument } from "./doppler-page-facts.js";
import { isFurnitureShare } from "./page-evidence.js";
import { PAGE_FACTS_MAX_PAGES, plainTextBytes, type PageFactUpsert } from "../pipeline/page-facts.js";

/** `document_page_facts.facts_source` and the page-image evidence artifact's `source` for facts-built evidence. */
export const DOPPLER_FACTS_EVIDENCE_SOURCE = "doppler-facts";

export type DopplerFactsCoverage =
  | { covered: true; pages: number }
  | { covered: false; reason: string };

/** Pages of facts a document's evidence reads at most (the facts reader bounds lines by the host count; this bounds work). */
const MAX_EVIDENCE_PAGES = 100_000;

type CoveredPage = DopplerPageFacts & { geometry: NonNullable<DopplerPageFacts["geometry"]>; text: NonNullable<DopplerPageFacts["text"]>; images: NonNullable<DopplerPageFacts["images"]> & { items: NonNullable<NonNullable<DopplerPageFacts["images"]>["items"]> } };

function coveredPage(page: DopplerPageFacts | undefined): page is CoveredPage {
  if (!page || page.failed || !page.text || !page.images || !page.geometry) return false;
  const images = page.images;
  return !images.truncated && !images.itemsTruncated && Array.isArray(images.items) && images.items.length >= images.imageCount;
}

/**
 * Whether `facts` cover every page 1..`pageCount` (the host's own count) with what the evidence needs. A refusal names the
 * first reason, for the log; the caller then keeps the probes' behaviour.
 */
export function dopplerFactsCoverEvidence(facts: DopplerPageFactsDocument | undefined, pageCount: number): DopplerFactsCoverage {
  if (!facts) return { covered: false, reason: "no-facts" };
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_EVIDENCE_PAGES) return { covered: false, reason: "page-count" };
  if (facts.summary.pageCount !== pageCount) return { covered: false, reason: "page-count-mismatch" };
  if (!facts.summary.complete) return { covered: false, reason: "incomplete" };
  if (facts.summary.linesDropped > 0) return { covered: false, reason: "lines-dropped" };
  if (facts.summary.pagesFailed > 0) return { covered: false, reason: "pages-failed" };
  if (facts.doc.error) return { covered: false, reason: "doc-error" };
  if (facts.doc.locked) return { covered: false, reason: "locked" };
  if (facts.pages.size !== pageCount) return { covered: false, reason: "pages-missing" };
  for (let page = 1; page <= pageCount; page += 1) {
    const entry = facts.pages.get(page);
    if (!entry || entry.failed) return { covered: false, reason: "pages-missing" };
    if (!entry.text) return { covered: false, reason: "text-family-missing" };
    if (!entry.geometry) return { covered: false, reason: "geometry-missing" };
    if (!coveredPage(entry)) return { covered: false, reason: "images-family-incomplete" };
    // A page whose facts may come from an object the file holds twice (an earlier page rebuilt the xref) is low confidence:
    // its image sizes, and so the furniture rule other pages share with it, are unknown. All or nothing, as above.
    if (dopplerPageFactsLowConfidence(entry)) return { covered: false, reason: "xref-repaired-earlier" };
  }
  return { covered: true, pages: pageCount };
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/**
 * An item's share of its page, never more than its own box allows: the reported `coverage` capped by the validated `bbox` over
 * the validated page size, so a forged coverage on a small box cannot pass for a full-page scan.
 */
function itemCoverage(item: CoveredPage["images"]["items"][number], page: CoveredPage): number {
  const pageArea = page.geometry.widthPt * page.geometry.heightPt;
  if (!(pageArea > 0)) return 0;
  // Clipped to the page first (either orientation, so a rotated page's box is never cut short): a box outside it covers nothing.
  const side = Math.max(page.geometry.widthPt, page.geometry.heightPt);
  const clip = (n: number) => Math.min(side, Math.max(0, n));
  const [x0, y0, x1, y1] = item.bbox.map(clip) as [number, number, number, number];
  const boxShare = (Math.abs(x1 - x0) * Math.abs(y1 - y0)) / pageArea;
  return Math.max(0, Math.min(1, item.coverage, boxShare));
}

/** Pages whose image listing the probe reads for furniture beyond the sparse pages (page-image-evidence.ts LISTING_SCOPE_PAGES). */
const LISTING_SCOPE_PAGES = 1000;

/** An item's share of its page when it is significant as the probe judges a listed image (readable pixels, placed share), else null. */
function significantShare(item: CoveredPage["images"]["items"][number], page: CoveredPage): number | null {
  const share = itemCoverage(item, page);
  return Math.min(item.px[0], item.px[1]) < MIN_SIGNIFICANT_IMAGE_PIXELS || !(share >= MIN_SIGNIFICANT_IMAGE_COVERAGE) ? null : share;
}

/**
 * Furniture as the probe finds it (summarizeImageListing): an image object whose significant placements fall on at least
 * repeatedImageMinPages pages, and on at least repeatedImageMinShare of the `scope` pages listed (pages 1..scope).
 */
function repeatedSignificantObjects(facts: DopplerPageFactsDocument, scope: number): Set<number> {
  const pagesOf = new Map<number, Set<number>>();
  for (let pageNumber = 1; pageNumber <= scope; pageNumber += 1) {
    const page = facts.pages.get(pageNumber) as CoveredPage;
    for (const item of page.images.items) {
      if (item.obj === undefined || significantShare(item, page) === null) continue;
      const set = pagesOf.get(item.obj) ?? new Set<number>();
      set.add(pageNumber);
      pagesOf.set(item.obj, set);
    }
  }
  const out = new Set<number>();
  for (const [obj, set] of pagesOf) {
    if (isFurnitureShare(set.size, scope)) out.add(obj);
  }
  return out;
}

/**
 * The first page whose facts call it sparse (fewer than SPARSE_PAGE_WORDS words in its text layer) while the winning
 * extraction read SPARSE_PAGE_WORDS or more words from it without OCR, or null when every page agrees. Such a page is
 * either a counting gap in the facts or facts that do not describe this file; either way they are not evidence. A page the
 * provider says it OCR'd is exempt: its words came from the pixels, not the layer (as the probe reads such a page).
 */
export function dopplerFactsTextDisagreement(
  facts: DopplerPageFactsDocument,
  pageTexts: readonly string[],
  ocrPages: ReadonlySet<number> = new Set(),
): number | null {
  for (const [index, text] of pageTexts.entries()) {
    const pageNumber = index + 1;
    const words = facts.pages.get(pageNumber)?.text?.wordCount;
    if (words === undefined || words >= SPARSE_PAGE_WORDS || ocrPages.has(pageNumber)) continue;
    if (pageEvidenceWordCount(text) >= SPARSE_PAGE_WORDS) return pageNumber;
  }
  return null;
}

/** Facts that passed every gate (`checkDopplerFactsEvidence`): the evidence builders read only these. */
export interface CheckedDopplerFacts {
  facts: DopplerPageFactsDocument;
  pageCount: number;
  pageTexts: readonly string[];
  ocrPages: ReadonlySet<number>;
}

export type DopplerFactsEvidenceCheck =
  | { ok: true; checked: CheckedDopplerFacts }
  | { ok: false; reason: string; page?: number };

/**
 * The one check facts pass before any evidence is built from them, run once per document: they cover every page of the
 * host's count (`dopplerFactsCoverEvidence`), the extracted text is page-aligned to that count, and no page's facts
 * disagree with it (`dopplerFactsTextDisagreement`, reason `words-disagree` with the page). `pageTexts`: the winning
 * extraction's page-aligned texts (or a function giving them, called only for covering facts), null when the text has no
 * reliable page breaks; `ocrPages`: pages the provider (or a
 * model) read, whose words came from the pixels.
 */
export function checkDopplerFactsEvidence(args: {
  facts: DopplerPageFactsDocument | undefined;
  pageCount: number;
  pageTexts: readonly string[] | null | (() => readonly string[] | null);
  ocrPages?: ReadonlySet<number>;
}): DopplerFactsEvidenceCheck {
  const coverage = dopplerFactsCoverEvidence(args.facts, args.pageCount);
  if (!coverage.covered) return { ok: false, reason: coverage.reason };
  // Split the text only for facts that cover the document.
  const pageTexts = typeof args.pageTexts === "function" ? args.pageTexts() : args.pageTexts;
  if (!pageTexts || pageTexts.length !== args.pageCount) return { ok: false, reason: "text-not-page-aligned" };
  const ocrPages = args.ocrPages ?? new Set<number>();
  const disagreement = dopplerFactsTextDisagreement(args.facts!, pageTexts, ocrPages);
  if (disagreement !== null) return { ok: false, reason: "words-disagree", page: disagreement };
  return { ok: true, checked: { facts: args.facts!, pageCount: args.pageCount, pageTexts, ocrPages } };
}

/**
 * Page-image evidence for classify-route from facts that cover the document (`dopplerFactsCoverEvidence`), the same shape the
 * `pdfimages` probe writes: sparse pages (fewer than SPARSE_PAGE_WORDS words in the text layer, invisible OCR words
 * included, as `pdftotext` reads them) with their significant, non-repeated image totals. No text-layer verdict (the facts
 * carry no layer text). Null when the facts fail the check (`checkDopplerFactsEvidence`), or when no page needs evidence
 * (as the probe returns).
 */
export function pageImageEvidenceFromDopplerFacts(args: {
  facts: DopplerPageFactsDocument | undefined;
  pageCount: number;
  pageTexts: string[];
  ocrPages?: ReadonlySet<number>;
}): PageImageEvidence[] | null {
  const check = checkDopplerFactsEvidence(args);
  return check.ok ? pageImageEvidenceFromCheckedFacts(check.checked) : null;
}

/** pageImageEvidenceFromDopplerFacts for facts that already passed the check. */
export function pageImageEvidenceFromCheckedFacts(checked: CheckedDopplerFacts): PageImageEvidence[] | null {
  const { facts, pageCount } = checked;
  const sparse = [...facts.pages.values()].filter((page) => (page.text?.wordCount ?? 0) < SPARSE_PAGE_WORDS).map((page) => page.page);
  if (sparse.length === 0) return null;
  // The probe's furniture rule and scope: significant placements only, over the pages it lists (the first 1,000, or up to the
  // last sparse page when that is later).
  const scope = Math.min(Math.max(Math.max(...sparse), Math.min(pageCount, LISTING_SCOPE_PAGES)), pageCount);
  const repeated = repeatedSignificantObjects(facts, scope);
  const evidence = new Map<number, PageImageEvidence>();
  for (const pageNumber of sparse.sort((a, b) => a - b)) {
    const page = facts.pages.get(pageNumber) as CoveredPage;
    const words = page.text.wordCount;
    let imageCount = 0;
    let repeatedImageCount = 0;
    let coverage = 0;
    let largest = 0;
    for (const item of page.images.items) {
      // Significant as the probe judges a listed image: readable size in pixels and a placed share of the page.
      const share = significantShare(item, page);
      if (share === null) continue;
      if (item.obj !== undefined && repeated.has(item.obj)) { repeatedImageCount += 1; continue; }
      imageCount += 1;
      coverage += share;
      largest = Math.max(largest, share);
    }
    evidence.set(pageNumber, {
      pageNumber,
      wordCount: words,
      imagesKnown: true,
      anyImageCount: page.images.items.length,
      repeatedImageCount,
      imageCount,
      imageCoverage: round(Math.min(1, coverage)),
      largestImageCoverage: round(Math.min(1, largest)),
      // Facts never read an image stream: its stored size is unknown, never zero.
      embeddedImageBytes: null,
    });
  }
  // No text-layer verdict: the probe judges the PDF's own layer, which the facts do not carry, and judging the extracted
  // Markdown or OCR text instead would call math, tables or OCR output garbled and authorize reads the probe never would.
  return [...evidence.values()].sort((a, b) => a.pageNumber - b.pageNumber);
}

/**
 * The ingest report's per-page source rows (document_page_facts word_count, image_count, text_bytes) from facts that cover the
 * document, as the probes' `pdftotext`/`pdfimages -list` rows would hold them. `textBytes` is 0 for a page with no text
 * layer; otherwise the whitespace-collapsed bytes of the extracted page (the facts count characters, never bytes), or null
 * when the extraction read nothing from a page the facts say has text. Empty when the facts disagree with the extracted text
 * (`dopplerFactsTextDisagreement`).
 * `imageCount` counts images as `pdfimages -list` lists `image` rows: every drawn image, masks and stencils left out.
 * Rows stop at PAGE_FACTS_MAX_PAGES, the table's ceiling per document (the probes stop earlier, at
 * WORKER_PAGE_FACTS_MAX_PAGES, because each page costs them a command; facts cost nothing more per page). Empty when the
 * facts fail the check (`checkDopplerFactsEvidence`).
 */
export function pageFactRowsFromDopplerFacts(args: {
  facts: DopplerPageFactsDocument | undefined;
  pageCount: number;
  pageTexts: string[];
  ocrPages?: ReadonlySet<number>;
  documentId: string;
  runId: string;
}): PageFactUpsert[] {
  const check = checkDopplerFactsEvidence(args);
  return check.ok ? pageFactRowsFromCheckedFacts(check.checked, args) : [];
}

/** pageFactRowsFromDopplerFacts for facts that already passed the check. */
export function pageFactRowsFromCheckedFacts(checked: CheckedDopplerFacts, ids: { documentId: string; runId: string }): PageFactUpsert[] {
  const { facts, pageCount, pageTexts, ocrPages } = checked;
  const rows: PageFactUpsert[] = [];
  for (let pageNumber = 1; pageNumber <= Math.min(pageCount, PAGE_FACTS_MAX_PAGES); pageNumber += 1) {
    const page = facts.pages.get(pageNumber) as CoveredPage;
    rows.push({
      documentId: ids.documentId,
      runId: ids.runId,
      pageNumber,
      // A page a model read holds OCR text, not its layer: its layer size is unknown.
      textBytes: page.text.charCount === 0 ? 0 : ocrPages.has(pageNumber) ? null : plainTextBytes(pageTexts[pageNumber - 1] ?? "") || null,
      wordCount: page.text.wordCount,
      imageCount: page.images.items.filter((item) => !item.imageMask).length,
      factsSource: DOPPLER_FACTS_EVIDENCE_SOURCE,
    });
  }
  return rows;
}
