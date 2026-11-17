import { z } from "zod";

/**
 * Page extract records (document_page_extracts, migration 0187): labelled provenance of how each page's text was produced.
 * The vocabularies below are closed and enforced by the database's CHECK constraints; keep both in step.
 * No page text, document-supplied value or model id is ever part of a record.
 */

/** The step that wrote or replaced a page's text. */
export const PAGE_EXTRACT_PASSES = ["extract", "scan-ocr", "critique", "vision", "human"] as const;
export type PageExtractPass = (typeof PAGE_EXTRACT_PASSES)[number];

/**
 * How the page's text was produced:
 * - `text-layer`: the document's own text (a PDF text layer, Office, HTML, plain text);
 * - `ocr`: the OCR engine's read of the page image;
 * - `ocr-second-read`: a second read of a page OCR read poorly (the page reader or an escalation read);
 * - `vision`: a vision model read of the page;
 * - `correction`: a correction of earlier text (self-critique or a human);
 * - `kept-as-image`: no text read; the page is kept as its image;
 * - `none`: no text (blank, or a read that failed).
 */
export const PAGE_EXTRACT_METHODS = ["text-layer", "ocr", "ocr-second-read", "vision", "correction", "kept-as-image", "none"] as const;
export type PageExtractMethod = (typeof PAGE_EXTRACT_METHODS)[number];

/** Closed page tags. */
export const PAGE_EXTRACT_TAGS = [
  "scanned", "table", "math", "garbled-text-layer", "drawn", "image-only", "low-confidence", "escalation-capped",
  "escalation-unfunded", "pii-withheld", "blank", "yield-deficit", "ladder-capped", "failed", "truncated", "rejected",
] as const;
export type PageExtractTag = (typeof PAGE_EXTRACT_TAGS)[number];
export const PAGE_EXTRACT_MAX_TAGS = 16;

/** Billed page class, by internal id (fast = Text, ocr = Scan, rich = Vision). */
export const PAGE_EXTRACT_BILLED_CLASSES = ["fast", "ocr", "rich"] as const;
export type PageExtractBilledClass = (typeof PAGE_EXTRACT_BILLED_CLASSES)[number];

export const PAGE_EXTRACT_FINISH_REASONS = ["stop", "length", "refused", "error", "empty", "other"] as const;
export type PageExtractFinishReason = (typeof PAGE_EXTRACT_FINISH_REASONS)[number];

/** Engine route token: an extractor id or a route word, never a model id. */
export const PAGE_EXTRACT_ENGINE_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,47}$/;
export const PAGE_EXTRACT_MEMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,95}$/;
export const PAGE_EXTRACT_REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

const TAG_SET: ReadonlySet<string> = new Set(PAGE_EXTRACT_TAGS);
export function isPageExtractTag(value: unknown): value is PageExtractTag {
  return typeof value === "string" && TAG_SET.has(value);
}

/** Known tags only, deduplicated, in vocabulary order, at most PAGE_EXTRACT_MAX_TAGS. */
export function normalizePageExtractTags(tags: Iterable<unknown>): PageExtractTag[] {
  const seen = new Set<string>();
  for (const tag of tags) if (isPageExtractTag(tag)) seen.add(tag);
  return PAGE_EXTRACT_TAGS.filter((tag) => seen.has(tag)).slice(0, PAGE_EXTRACT_MAX_TAGS);
}

/** One page extract record as the API serves it. */
export const pageExtractRecordSchema = z.object({
  pageNumber: z.number().int().positive(),
  runId: z.string(),
  pass: z.enum(PAGE_EXTRACT_PASSES),
  method: z.enum(PAGE_EXTRACT_METHODS),
  engine: z.string().nullable(),
  memberId: z.string().nullable(),
  region: z.string().nullable(),
  billedClass: z.enum(PAGE_EXTRACT_BILLED_CLASSES).nullable(),
  tags: z.array(z.enum(PAGE_EXTRACT_TAGS)),
  confidence: z.number().min(0).max(1).nullable(),
  plausibility: z.number().min(0).max(1).nullable(),
  textBytes: z.number().int().nonnegative().nullable(),
  finishReason: z.enum(PAGE_EXTRACT_FINISH_REASONS).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  isFinal: z.boolean(),
  supersededByPass: z.enum(PAGE_EXTRACT_PASSES).nullable(),
  createdAt: z.string(),
});
export type PageExtractRecordView = z.infer<typeof pageExtractRecordSchema>;

export const documentPageExtractsSchema = z.object({
  documentId: z.string(),
  /** Records ordered by page, then creation; `nextAfterPage` continues past the last page returned. */
  records: z.array(pageExtractRecordSchema),
  nextAfterPage: z.number().int().positive().nullable(),
});
export type DocumentPageExtractsView = z.infer<typeof documentPageExtractsSchema>;
