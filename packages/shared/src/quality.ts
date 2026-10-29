import { z } from "zod";
import type { ParserPlaybookKey } from "./embedding.js";

/**
 * Processing quality: the one public extraction knob. `fast` reads the text layer only and keeps pages without one
 * as page images (no OCR, no vision model). `auto` routes each page the cheapest faithful way (text layer, or a
 * vision model for scans and complex layouts). `good` reads every page with a vision model.
 *
 * The parser playbook catalog stays internal: the worker derives the playbook from `quality`, and classify-route may
 * still suggest a playbook per document inside `auto`.
 */
export const qualityModeSchema = z.enum(["fast", "auto", "good"]);
export type QualityMode = z.infer<typeof qualityModeSchema>;
export const DEFAULT_QUALITY_MODE: QualityMode = "auto";

const QUALITY_PLAYBOOK: Record<QualityMode, ParserPlaybookKey> = {
  fast: "fast",
  auto: "balanced",
  good: "review-grade",
};

/** Internal parser playbook a quality mode runs. */
export function parserPlaybookForQuality(quality: QualityMode | null | undefined): ParserPlaybookKey {
  return QUALITY_PLAYBOOK[quality ?? DEFAULT_QUALITY_MODE];
}

/** True when the mode reads every page with a vision model (the former `vision.forceAllPages`). */
export function qualityReadsEveryPage(quality: QualityMode | null | undefined): boolean {
  return quality === "good";
}

/** True when the mode may send any page to OCR or a vision model. */
export function qualityAllowsPageReading(quality: QualityMode | null | undefined): boolean {
  return quality !== "fast";
}

export const QUALITY_RANK: Record<QualityMode, number> = { fast: 0, auto: 1, good: 2 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Quality implied by the retired `parserPlaybook` and `vision.forceAllPages` keys, or null when neither says
 * anything. `forceAllPages: true` or `review-grade` mean good, `fast` means fast, any other playbook means auto.
 * `forceAllPages: false` alone implies nothing (it was the default).
 */
export function legacyQualityMode(source: unknown): QualityMode | null {
  if (!isRecord(source)) return null;
  const vision = source.vision;
  if (isRecord(vision) && vision.forceAllPages === true) return "good";
  const playbook = source.parserPlaybook;
  if (typeof playbook !== "string") return null;
  if (playbook === "fast") return "fast";
  if (playbook === "review-grade") return "good";
  return "auto";
}

/**
 * Rewrites a stored pipeline or a request override that may carry the retired keys: an explicit `quality` wins,
 * otherwise the legacy keys are mapped, and both legacy keys are removed. Returns the input unchanged when it has
 * neither key, so callers can apply it to every source cheaply.
 */
export function migrateLegacyQualitySettings<T>(source: T): T {
  if (!isRecord(source)) return source;
  const vision = source.vision;
  const hasVisionKey = isRecord(vision) && "forceAllPages" in vision;
  if (!("parserPlaybook" in source) && !hasVisionKey) return source;
  const legacy = legacyQualityMode(source);
  const { parserPlaybook: _playbook, ...rest } = source as Record<string, unknown>;
  const next: Record<string, unknown> = rest;
  if (hasVisionKey) {
    const { forceAllPages: _force, ...visionRest } = vision as Record<string, unknown>;
    next.vision = visionRest;
  }
  if (next.quality === undefined && legacy) next.quality = legacy;
  return next as T;
}

/** Export-relative path of a page image (`images/page-0001.png`, the document export layout). */
export function pageImageExportPath(pageNumber: number): string {
  return `images/page-${String(pageNumber).padStart(4, "0")}.png`;
}

/** Alt text for a page Fast kept as an image: names the page and says its text was not extracted. */
export function pageImageReferenceAlt(pageNumber: number): string {
  return `Page ${pageNumber}: scanned page image, no text layer`;
}

/**
 * Markdown for a page without a usable text layer in Fast mode: a reference to its stored page image instead of
 * OCR text. Fast never reads such a page, so the page has no text and produces no chunks.
 */
export function pageImageReferenceMarkdown(pageNumber: number): string {
  return `![${pageImageReferenceAlt(pageNumber)}](${pageImageExportPath(pageNumber)})`;
}

const PAGE_IMAGE_REFERENCE_LINE = /!\[Page \d+: scanned page image, no text layer\]\(images\/page-\d{4,}\.png\)/g;

/** True when a page's Markdown is only a Fast page-image reference (no extracted text). */
export function isPageImageReferenceMarkdown(markdown: string): boolean {
  const trimmed = markdown.trim();
  return trimmed.length > 0 && trimmed.replace(PAGE_IMAGE_REFERENCE_LINE, "").trim().length === 0;
}

/** Text with Fast page-image references removed, for chunking and search: they carry no document text. */
export function stripPageImageReferences(text: string): string {
  return text.replace(PAGE_IMAGE_REFERENCE_LINE, "");
}
