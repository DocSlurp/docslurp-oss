import { z } from "zod";
import type { ParserPlaybookKey } from "./embedding.js";
import type { DocumentExtractionConfig } from "./extraction.js";

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

export const DIGITAL_IMAGE_TARGETS = ["document/media-map", "page/embedded-image", "page/embedded-image-set"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

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

/**
 * Extractors that only read a file's own text layer or structure: no OCR, no model. Fast may run only these.
 * `kreuzberg` qualifies for text-layer formats only: @kreuzberg/node 4.10.2 drops `disableOcr` and `ocr.enabled`
 * (normalizeExtractionConfig) and OCRs every image, so the worker's extractor registry refuses image inputs to
 * Kreuzberg under Fast (its config carries the `disableOcr` marker). `liteparse` runs without OCR.
 */
export const TEXT_LAYER_EXTRACTORS: ReadonlySet<string> = new Set([
  "kreuzberg", "native-pdf", "poppler-text", "pandoc", "json", "doppler", "liteparse",
]);

/** Kreuzberg options that turn OCR on; Fast removes them and sets the `disableOcr` marker (not a Kreuzberg switch). */
const KREUZBERG_OCR_KEYS = ["ocr", "forceOcr", "forceOcrPages", "disableOcr"] as const;

/**
 * The document extraction policy Fast runs with, fail closed: `order` keeps only text-layer extractors (a format
 * left with none falls back to the defaults, which are all text-layer), extractor options keep only text-layer
 * extractors' entries, Kreuzberg loses every OCR option (no `ocr`, `forceOcr` or `forceOcrPages`) and gets the
 * `disableOcr: true` marker, which Kreuzberg itself ignores: the worker reads it to refuse image inputs to Kreuzberg,
 * the one format Kreuzberg OCRs without being asked. Artifact-graph
 * enrichment that can OCR is off; explicit image preservation remains (the worker requires a Doppler-only VM route), an explicit voting secondary outside the text-layer set falls back to
 * next-in-order, and `forceOcr` is false. `removed` lists what was dropped, for a loud log line.
 * Other quality modes return the config unchanged.
 */
export function documentExtractionForQuality(
  config: DocumentExtractionConfig,
  quality: QualityMode | null | undefined,
): { config: DocumentExtractionConfig; removed: string[] } {
  if (qualityAllowsPageReading(quality)) return { config, removed: [] };
  const removed: string[] = [];
  const order: DocumentExtractionConfig["order"] = {};
  for (const [format, ids] of Object.entries(config.order ?? {})) {
    const kept = ids.filter((id) => TEXT_LAYER_EXTRACTORS.has(id));
    for (const id of ids) if (!TEXT_LAYER_EXTRACTORS.has(id)) removed.push(`order.${format}:${id}`);
    if (kept.length > 0) order[format] = kept;
  }
  const options: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(config.options ?? {})) {
    if (!TEXT_LAYER_EXTRACTORS.has(id)) { removed.push(`options.${id}`); continue; }
    options[id] = value;
  }
  const kreuzberg = isRecord(options.kreuzberg) ? { ...options.kreuzberg } : {};
  for (const key of KREUZBERG_OCR_KEYS) {
    if (key in kreuzberg && !(key === "disableOcr" && kreuzberg[key] === true)) removed.push(`options.kreuzberg.${key}`);
    delete kreuzberg[key];
  }
  // Nested `kreuzberg` options are not ours to model: drop any other key that names OCR.
  for (const key of Object.keys(kreuzberg)) {
    if (/ocr/i.test(key)) { removed.push(`options.kreuzberg.${key}`); delete kreuzberg[key]; }
  }
  // The marker the worker reads to keep images away from Kreuzberg (it ignores disableOcr and OCRs images anyway).
  options.kreuzberg = { ...kreuzberg, disableOcr: true };
  const enrich = (config.enrich ?? []).filter(target => (DIGITAL_IMAGE_TARGETS as readonly string[]).includes(target));
  if (enrich.length !== (config.enrich ?? []).length) removed.push("enrich");
  const secondary = config.voting?.secondary ?? "next-in-order";
  const votingSecondary = secondary === "next-in-order" || TEXT_LAYER_EXTRACTORS.has(secondary) ? secondary : "next-in-order";
  if (votingSecondary !== secondary) removed.push(`voting.secondary:${secondary}`);
  if (config.forceOcr) removed.push("forceOcr");
  return {
    config: {
      ...config,
      order,
      options,
      enrich,
      voting: { ...config.voting, secondary: votingSecondary },
      forceOcr: false,
    },
    removed,
  };
}

export const QUALITY_RANK: Record<QualityMode, number> = { fast: 0, auto: 1, good: 2 };

/**
 * Quality implied by the retired `parserPlaybook` and `vision.forceAllPages` keys, or null when neither says
 * anything. Only `forceAllPages: true` (vision on every page) means good; `fast` means fast; every other playbook,
 * including `review-grade` and `agentic`, means auto. Those playbooks never read every page, so mapping them to
 * good would multiply a workspace's spend. `forceAllPages: false` alone implies nothing (it was the default).
 */
export function legacyQualityMode(source: unknown): QualityMode | null {
  if (!isRecord(source)) return null;
  const vision = source.vision;
  if (isRecord(vision) && vision.forceAllPages === true) return "good";
  const playbook = source.parserPlaybook;
  if (typeof playbook !== "string") return null;
  return playbook === "fast" ? "fast" : "auto";
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

/** Image formats a stored page image can have; PDFs render PNG, image files keep their own format. */
const PAGE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "tif", "tiff", "bmp", "avif", "heic"]);

/**
 * File extension of a stored page image from its key or URI (`png`, `jpg`, `webp`, ...), or `png` when the key has
 * none. The document export names `images/` entries the same way, so a reference built from it resolves.
 */
export function pageImageExtension(keyOrUri: string | null | undefined): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec((keyOrUri ?? "").split("?")[0] ?? "");
  const extension = match?.[1]?.toLowerCase();
  return extension && PAGE_IMAGE_EXTENSIONS.has(extension) ? extension : "png";
}

/** Export-relative path of a page image (`images/page-0001.png`, the document export layout). */
export function pageImageExportPath(pageNumber: number, extension = "png"): string {
  return `images/page-${String(pageNumber).padStart(4, "0")}.${extension}`;
}

/** Alt text for a page Fast kept as an image: names the page and says its text was not extracted. */
export function pageImageReferenceAlt(pageNumber: number): string {
  return `Page ${pageNumber}: scanned page image, no text layer`;
}

/**
 * Markdown for a page without a usable text layer in Fast mode: a reference to its stored page image instead of
 * OCR text. Fast never reads such a page, so the page has no text and produces no chunks. `extension` is the stored
 * image's format (pageImageExtension), so the link matches the exported file.
 */
export function pageImageReferenceMarkdown(pageNumber: number, extension = "png"): string {
  return `![${pageImageReferenceAlt(pageNumber)}](${pageImageExportPath(pageNumber, extension)})`;
}

/** Canonical block `metadata.extractor` (the reconciliation source adapter) of a Fast page-image reference. */
export const PAGE_IMAGE_REFERENCE_ADAPTER = "page-image";

/**
 * True when a canonical block is a Fast page-image reference. Recognized structurally, by the adapter the worker
 * stamped when it wrote the reference, never by its text: a document whose text layer contains the exact reference
 * string stays searchable.
 */
export function isPageImageReferenceBlock(block: { metadata?: Record<string, unknown> | null } | null | undefined): boolean {
  return block?.metadata?.extractor === PAGE_IMAGE_REFERENCE_ADAPTER;
}

/**
 * Pages whose content is only a Fast page-image reference: every block on the page is a reference block. Blocks
 * without a page number count as page 1.
 */
export function pageImageReferencePages(
  blocks: ReadonlyArray<{ pageNumber?: number | null; text: string; metadata?: Record<string, unknown> | null }>,
): Set<number> {
  const reference = new Set<number>();
  const content = new Set<number>();
  for (const block of blocks) {
    const page = block.pageNumber ?? 1;
    if (isPageImageReferenceBlock(block)) reference.add(page);
    else if (block.text.trim()) content.add(page);
  }
  for (const page of content) reference.delete(page);
  return reference;
}

/**
 * Page-separated (`\f`) text with the pages in `referencePages` emptied, for chunking and search: a Fast reference
 * page carries no document text. Pages are 1-based.
 */
export function blankPages(text: string, referencePages: ReadonlySet<number>): string {
  if (referencePages.size === 0) return text;
  return text.split("\f").map((page, index) => (referencePages.has(index + 1) ? "" : page)).join("\f");
}
