import {
  adaptiveRoutingDecisionSurfaceSchema,
  adaptiveRoutingArtifactSchema,
  splitTextIntoPages,
  type AdaptiveDocumentComplexity,
  type AdaptivePageRoute,
  type AdaptivePageRoutingEntry,
  type AdaptiveOcrDecision,
  type AdaptiveRoutingArtifact,
  type AdaptiveRoutingDecisionSurface,
  type AdaptiveSpecializedContentEntry,
  type AdaptiveSpecializedContentKind,
  type AdaptiveSpecializedContentSummary,
  type ParserPlaybookKey
} from "@docslurp/shared";
import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments, } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import { type ArtifactStore, keyFromStorageUri } from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { SPARSE_PAGE_WORDS, pageAlignedTexts, pageEvidenceWordCount, type PageImageEvidence } from "../lib/page-image-evidence.js";
import { pageTextYield } from "../lib/page-yield-evidence.js";
import { resolveRunRoutingV2, routingVersion, type RoutingVersionOptions } from "../lib/vision-routing-v2.js";

// Lightweight document-type classification using filename + extracted/canonical text heuristics.
// Emits a classification artifact and (optionally) a suggested parser playbook override per document.

export class ClassifyRouteStage implements Stage {
  readonly name = "classify-route";

  constructor(private readonly storage: ArtifactStore) {}

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    await runDocuments(healthyDocuments(state), state.docConcurrency, async (document) => {
      const key = `${runArtifactRoot(state.run, document.userId)}/classify/${document.id}.json`;
      const artifactSlot = `${document.id}:classification`;

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "classification ready",
        async () => {
          const evidence = await this.loadEvidence(state, document);
          const structured = await this.loadStructuredComplexity(
            state,
            document.id,
          );
          const imageEvidence = await this.loadPageImageEvidence(state, document.id);
          const routingV2 = resolveRunRoutingV2(state);
          const surface = buildAdaptiveRoutingDecisionSurface({
            documentId: document.id,
            filename: document.filename,
            text: evidence?.text ?? "",
            pageCount: Math.max(1, document.pageCount),
            evidence: evidence
              ? {
                  source: evidence.source,
                  artifactUri: evidence.artifactUri,
                }
              : structured
                ? {
                    source: "liteparse-structured",
                    artifactUri: structured.artifactUri,
                  }
                : imageEvidence
                  ? {
                      source: "page-image-evidence",
                      artifactUri: imageEvidence.artifactUri,
                    }
                  : null,
            structuredComplexity: structured?.pages,
            pageImageEvidence: imageEvidence?.pages,
            drawnBytesPerPage: imageEvidence?.drawnBytesPerPage ?? null,
            routingV2,
          });

          await this.storage.putJson(key, surface);
          if (surface.status === "deferred") {
            return {
              artifactUri: this.storage.uri(key),
              stats: {
                skipped: true,
                reason: "extraction-evidence-unavailable",
                routingVersion: routingVersion(routingV2),
              },
            };
          }

          if (surface.suggestedPlaybook) {
            state.artifactLedger.recordDocument(document.id, "parser-playbook", surface.suggestedPlaybook);
          }

          return {
            artifactUri: this.storage.uri(key),
            stats: {
              label: surface.label,
              confidence: surface.confidence,
              routingVersion: routingVersion(routingV2),
              suggestedPlaybook: surface.suggestedPlaybook,
              documentComplexity: surface.documentComplexity,
              visionPolicy: surface.visionPolicy,
              evidenceSource: surface.evidence.source,
              specializedContentKinds: surface.specializedContentSummary.map((entry) => entry.kind),
              nonStraightforwardPages: surface.pages.filter((page) => page.route !== "straightforward-text").length,
              // Ingest report: tables observed (heuristic, from the extracted text).
              tablePages: surface.pages.filter((page) => page.route === "table-heavy").length
            }
          };
        },
        signal
      );
    });
  }

  private async loadEvidence(
    state: import("../pipeline/pipeline.js").WorkflowState,
    document: import("../models.js").Document
  ): Promise<{
    text: string;
    source: "canonical-document" | "markdown-manifest" | "extraction-contract";
    artifactUri: string;
  } | null> {
    // Prefer canonical document text when available
    const canonicalUri = state.artifactLedger.readDocument(document.id, "canonical-document");
    if (canonicalUri) {
      try {
        const key = keyFromStorageUri(canonicalUri, this.storage.bucket);
        if (key) {
          const json = (await this.storage.getJson(key)) as {
            stats?: { pageCount?: number };
            blocks?: Array<{ text?: string; pageNumber?: number | null; order?: number }>;
          } | null;
          const text = Array.isArray(json?.blocks)
            ? canonicalBlocksToPageText(json.blocks, Math.max(1, document.pageCount))
            : null;
          if (text && text.trim()) {
            return { text, source: "canonical-document", artifactUri: canonicalUri };
          }
        }
      } catch {
        // fall back
      }
    }

    // Else try markdown manifest pointer
    const md = state.artifactLedger.readDocument(document.id, "markdown-manifest");
    if (md) {
      try {
        const key = keyFromStorageUri(md, this.storage.bucket);
        if (key) {
          const json = (await this.storage.getJson(key)) as { textArtifactUri?: string } | null;
          const nested = json?.textArtifactUri;
          if (nested) {
            const mk = keyFromStorageUri(nested, this.storage.bucket);
            if (mk) {
              const bytes = await this.storage.getBytes(mk);
              const text = bytes.toString("utf8");
              if (text.trim()) {
                return { text, source: "markdown-manifest", artifactUri: nested };
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }

    const contractUri = state.artifactLedger.readDocument(document.id, "extraction-contract");
    if (contractUri) {
      try {
        const key = keyFromStorageUri(contractUri, this.storage.bucket);
        if (key) {
          const json = (await this.storage.getJson(key)) as { markdown?: string; rawText?: string } | null;
          const text = json?.markdown?.trim() ? json.markdown : json?.rawText;
          if (text?.trim()) {
            return { text, source: "extraction-contract", artifactUri: contractUri };
          }
        }
      } catch {
        // no usable extraction evidence
      }
    }

    return null;
  }

  private async loadStructuredComplexity(
    state: import("../pipeline/pipeline.js").WorkflowState,
    documentId: string,
  ): Promise<{
    pages: Map<number, StructuredPageComplexityEvidence>;
    artifactUri: string;
  } | null> {
    const artifactUri = state.artifactLedger.readDocument(documentId, "liteparse-structured");
    if (!artifactUri) return null;
    try {
      const key = keyFromStorageUri(artifactUri, this.storage.bucket);
      if (!key) return null;
      const payload = (await this.storage.getJson(key)) as {
        pages?: Array<{ pageNumber?: number; complexity?: StructuredPageComplexityEvidence | null }>;
      };
      const pages = new Map(
        (payload.pages ?? [])
          .filter(
            (page): page is { pageNumber: number; complexity: StructuredPageComplexityEvidence } =>
              Number.isInteger(page.pageNumber) && Boolean(page.complexity),
          )
          .map((page) => [page.pageNumber, page.complexity]),
      );
      return pages.size > 0 ? { pages, artifactUri } : null;
    } catch {
      return null;
    }
  }
  private async loadPageImageEvidence(
    state: import("../pipeline/pipeline.js").WorkflowState,
    documentId: string,
  ): Promise<{ pages: Map<number, PageImageEvidence>; artifactUri: string; drawnBytesPerPage: number | null } | null> {
    const artifactUri = state.artifactLedger.readDocument(documentId, "page-image-evidence");
    if (!artifactUri) return null;
    try {
      const key = keyFromStorageUri(artifactUri, this.storage.bucket);
      if (!key) return null;
      const payload = (await this.storage.getJson(key)) as { pages?: unknown[]; drawnBytesPerPage?: unknown } | null;
      const pages = new Map<number, PageImageEvidence>();
      for (const entry of payload?.pages ?? []) {
        const page = parsePageImageEvidence(entry);
        if (page) pages.set(page.pageNumber, page);
      }
      const bytes = payload?.drawnBytesPerPage;
      const drawnBytesPerPage = typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
      return pages.size > 0 ? { pages, artifactUri, drawnBytesPerPage } : null;
    } catch {
      return null;
    }
  }
}

function parsePageImageEvidence(value: unknown): PageImageEvidence | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const number = (field: string, max = Number.POSITIVE_INFINITY) => {
    const raw = entry[field];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= max ? raw : null;
  };
  const pageNumber = number("pageNumber");
  const wordCount = number("wordCount");
  const imageCount = number("imageCount");
  const imageCoverage = number("imageCoverage", 1);
  const largestImageCoverage = number("largestImageCoverage", 1);
  if (
    pageNumber === null || !Number.isInteger(pageNumber) || pageNumber < 1 ||
    wordCount === null || imageCount === null || imageCoverage === null || largestImageCoverage === null
  ) {
    return null;
  }
  return { pageNumber, wordCount, imageCount, imageCoverage, largestImageCoverage,
    embeddedImageBytes: number("embeddedImageBytes", Number.MAX_SAFE_INTEGER) };
}

export interface StructuredPageComplexityEvidence {
  textLength: number;
  textCoverage: number;
  hasSubstantialImages: boolean;
  imageCoverage: number;
  largestImageCoverage: number;
  fullPageImage: boolean;
  uncoveredVectorArea?: number;
  isGarbled: boolean;
  pageArea: number;
  needsOcr: boolean;
  reasons: string[];
}

export function buildAdaptiveRoutingDecisionSurface(args: {
  documentId: string;
  filename: string;
  text: string;
  pageCount: number;
  evidence: {
    source:
      | "canonical-document"
      | "markdown-manifest"
      | "extraction-contract"
      | "liteparse-structured"
      | "page-image-evidence";
    artifactUri: string;
  } | null;
  structuredComplexity?: Map<number, StructuredPageComplexityEvidence>;
  /** Raster evidence for sparse-text PDF pages (lib/page-image-evidence.ts). */
  pageImageEvidence?: Map<number, PageImageEvidence>;
  /** (File bytes - all embedded image bytes) / pages, from the raster evidence artifact. */
  drawnBytesPerPage?: number | null;
  /** Legacy vision routing v2 (lib/vision-routing-v2.ts). Off reproduces v1 routing. */
  routingV2?: boolean;
}): AdaptiveRoutingDecisionSurface {
  const routingV2 = args.routingV2 === true;
  const hasPageEvidence =
    (args.structuredComplexity?.size ?? 0) > 0 || (args.pageImageEvidence?.size ?? 0) > 0;
  if ((!args.text.trim() && !hasPageEvidence) || !args.evidence) {
    return adaptiveRoutingDecisionSurfaceSchema.parse({
      status: "deferred",
      documentId: args.documentId,
      reason: "extraction-evidence-unavailable",
      pages: [],
    });
  }
  const { label, confidence, signals } = classifyTextAndFilename(args.text, args.filename, { routingV2 });
  const hasPageAlignment = pageAlignedTexts(args.text, args.pageCount) !== null;
  const pageTexts = splitTextIntoPages(args.text, Math.max(1, args.pageCount));
  const pageText = (pageNumber: number) => pageTexts[pageNumber - 1] ?? "";
  // No extractor produced any text for the whole document, and its file minus every embedded
  // image is far larger than blank pages need: the content may be drawn (vector paths, outlined
  // glyphs), so a page without text or images may not be blank and vision is its only reader.
  // Byte counts are spoofable (padding, metadata, attachments, a large font), so this only
  // nominates the page: vision-extract skips it unless its render shows ink (renderLooksBlank).
  const documentWithoutText = !args.text.trim();
  // Likewise (v2) a page with no text layer and no image whose extracted text (OCR of its
  // render) still has words: the words are drawn, so the page is not blank.
  const drawnContent = (text: string) =>
    (routingV2 && pageEvidenceWordCount(text) >= DRAWN_TEXT_MIN_WORDS) ||
    (documentWithoutText && args.drawnBytesPerPage != null && args.drawnBytesPerPage >= DRAWN_CONTENT_MIN_BYTES_PER_PAGE);
  const pages = buildAdaptivePageRoutesFromTexts(pageTexts, Math.max(1, args.pageCount), { routingV2 }).map((page) => {
    const complexity = args.structuredComplexity?.get(page.pageNumber);
    const imageEvidence = args.pageImageEvidence?.get(page.pageNumber);
    if (!complexity && !imageEvidence) return page;
    const evidenceDecision = complexity
      ? authorizeStructuredOcr(complexity, pageText(page.pageNumber), imageEvidence, hasPageAlignment)
      : authorizeRasterPageOcr(imageEvidence!);
    const ocrDecision: AdaptiveOcrDecision =
      evidenceDecision.signals.includes(BLANK_PAGE_SIGNAL) &&
      drawnContent(pageText(page.pageNumber))
        ? { authorized: true, confidence: 0.7, signals: [DRAWN_CONTENT_SIGNAL] }
        : evidenceDecision;
    if (!ocrDecision.authorized) {
      // Blank pages: confident there is nothing to read, so they are neither rendered nor sent to vision.
      if (ocrDecision.signals.includes(BLANK_PAGE_SIGNAL)) {
        return {
          ...page,
          confidence: Math.max(page.confidence, ocrDecision.confidence),
          signals: [...page.signals, ...ocrDecision.signals],
          ocrDecision,
        };
      }
      // Sparse page with only minor images: keep the text heuristics' route.
      if (!complexity) {
        return { ...page, signals: [...page.signals, ...ocrDecision.signals] };
      }
      return {
        ...page,
        signals: [...page.signals, ...ocrDecision.signals],
        ocrDecision,
      };
    }
    return {
      ...page,
      // v2: OCR text keeps visible structure cues (numeric rows, field labels, equations): keep
      // that route so the ingest report counts the table; any other raster page is degraded.
      route: routingV2 && STRUCTURED_TEXT_ROUTES.has(page.route) ? page.route : ("handwriting-or-degraded" as const),
      extractorHint: "vision-rescue" as const,
      confidence: Math.max(page.confidence, ocrDecision.confidence),
      signals: [...page.signals, ...ocrDecision.signals],
      ocrDecision,
    };
  });
  const summary = summarizeAdaptiveRouting(pages);
  const specializedContentSummary = summarizeSpecializedContent(pages);
  const suggestedPlaybook = resolveAdaptivePlaybook({
    label,
    documentComplexity: summary.documentComplexity,
    dominantRoutes: summary.dominantRoutes,
  });
  const routing: AdaptiveRoutingArtifact = adaptiveRoutingArtifactSchema.parse({
    documentId: args.documentId,
    label,
    confidence,
    signals,
    suggestedPlaybook,
    documentComplexity: summary.documentComplexity,
    dominantRoutes: summary.dominantRoutes,
    visionPolicy: summary.visionPolicy,
    specializedContentSummary,
    pages,
  });
  return adaptiveRoutingDecisionSurfaceSchema.parse({
    ...routing,
    status: "ready",
    evidence: {
      ...args.evidence,
      characterCount: args.text.length,
      pageCount: Math.max(1, args.pageCount),
    },
  });
}

const BLANK_PAGE_SIGNAL = "ocr-not-authorized:blank-page";
export const DRAWN_CONTENT_SIGNAL = "ocr-authorized:drawn-content";
const NO_NATIVE_TEXT_SIGNALS = new Set([
  "ocr-authorized:no-native-text",
  "ocr-authorized:raster-page-without-text",
  DRAWN_CONTENT_SIGNAL,
]);
/**
 * Bytes per page above which a PDF with no extractable text holds drawn content. Blank pages
 * need well under 1 KB; a page of text drawn as paths needs tens to hundreds of KB.
 */
export const DRAWN_CONTENT_MIN_BYTES_PER_PAGE = 16 * 1024;
/** Extracted words on a page with neither a text layer nor images that make it drawn text, not blank. */
export const DRAWN_TEXT_MIN_WORDS = 10;
const STRUCTURED_TEXT_ROUTES = new Set<AdaptivePageRoute>(["table-heavy", "form", "formula-heavy", "chart-or-figure"]);

/**
 * True when routing authorized OCR because the page has no native text: vision is the
 * page's only source of searchable text, so it goes first when a page budget truncates
 * the selection.
 */
export function pageLacksNativeText(page: Pick<AdaptivePageRoutingEntry, "ocrDecision">): boolean {
  return page.ocrDecision?.authorized === true &&
    page.ocrDecision.signals.some((signal) => NO_NATIVE_TEXT_SIGNALS.has(signal));
}

/**
 * Pages the legacy vision selector sends to vision, pages lacking native text first: vision is
 * their only source of searchable text, so they keep their place when a page budget truncates
 * the selection.
 *
 * v1 (routing v2 off): a routing decision from page evidence decides alone; otherwise
 * vision-rescue routes and sparse form or table pages. v2:
 *
 * - OCR authorized by raster or structured evidence (scans, OCR'd rasters, no text layer).
 * - Blank pages never.
 * - Otherwise the text route decides, also when raster evidence did not authorize OCR (a page
 *   with a minor image is still a formula or figure page): vision-rescue routes, formula pages
 *   (a text layer flattens notation that vision transcribes as LaTeX), and sparse form or table
 *   pages.
 */
export function selectLegacyVisionPages(
  pages: AdaptivePageRoutingEntry[],
  options: RoutingVersionOptions = {},
): number[] {
  if (options.routingV2 !== true) {
    return prioritizePagesWithoutNativeText(pages)
      .filter((page) => {
        if (page.ocrDecision !== undefined) {
          return page.ocrDecision.authorized;
        }
        return (
          page.extractorHint === "vision-rescue" ||
          ((page.route === "form" || page.route === "table-heavy") &&
            page.textDensityScore < 0.45)
        );
      })
      .map((page) => page.pageNumber);
  }
  return prioritizePagesWithoutNativeText(pages)
    .filter((page) => {
      if (page.ocrDecision?.authorized) return true;
      if (page.ocrDecision?.signals.includes(BLANK_PAGE_SIGNAL)) return false;
      return (
        page.extractorHint === "vision-rescue" ||
        page.route === "formula-heavy" ||
        // Native text retains labels, but not plotted values or diagram relationships.
        page.route === "chart-or-figure" ||
        ((page.route === "form" || page.route === "table-heavy") && page.textDensityScore < 0.45)
      );
    })
    .map((page) => page.pageNumber);
}

/** Page numbers ordered with pages lacking native text first, page order otherwise (stable). */
export function prioritizePagesWithoutNativeText<T extends Pick<AdaptivePageRoutingEntry, "ocrDecision">>(pages: T[]): T[] {
  return pages.slice().sort((left, right) => Number(pageLacksNativeText(right)) - Number(pageLacksNativeText(left)));
}
/** A page without native text whose largest image covers at least this share holds its content as pixels. */
export const RASTER_PAGE_MIN_LARGEST_IMAGE_COVERAGE = 0.25;
/** ...or whose significant images together cover at least this share (banded or tiled scans). */
export const RASTER_PAGE_MIN_TOTAL_IMAGE_COVERAGE = 0.35;
/**
 * A page whose native text is only a stamp, page number or generated footer ("Page 1 of 2",
 * a Bates number) over an image covering at least this share is a scan placed with margins.
 */
export const STAMP_TEXT_MAX_WORDS = 10;
export const STAMPED_SCAN_MIN_IMAGE_COVERAGE = 0.5;
/** A page with a little more native text (title, caption) needs an image this large to be a scan. */
export const SPARSE_TEXT_FULL_PAGE_IMAGE_COVERAGE = 0.85;

/**
 * OCR authorization from raster evidence alone (no structured parser evidence): the
 * page has no or almost no native text and an image holds its content. Blank pages
 * (no text, no significant image) and pages whose only images are small are not
 * authorized, so they cost nothing.
 */
export function authorizeRasterPageOcr(evidence: PageImageEvidence): AdaptiveOcrDecision {
  if (evidence.wordCount === 0 && evidence.imageCount === 0) {
    return { authorized: false, confidence: 0.9, signals: [BLANK_PAGE_SIGNAL] };
  }
  if (
    evidence.wordCount === 0 &&
    (evidence.largestImageCoverage >= RASTER_PAGE_MIN_LARGEST_IMAGE_COVERAGE ||
      evidence.imageCoverage >= RASTER_PAGE_MIN_TOTAL_IMAGE_COVERAGE)
  ) {
    return { authorized: true, confidence: 0.94, signals: ["ocr-authorized:raster-page-without-text"] };
  }
  if (evidence.wordCount <= STAMP_TEXT_MAX_WORDS && evidence.largestImageCoverage >= STAMPED_SCAN_MIN_IMAGE_COVERAGE) {
    return { authorized: true, confidence: 0.9, signals: ["ocr-authorized:stamped-raster-page"] };
  }
  if (
    evidence.wordCount < SPARSE_PAGE_WORDS &&
    evidence.largestImageCoverage >= SPARSE_TEXT_FULL_PAGE_IMAGE_COVERAGE
  ) {
    return { authorized: true, confidence: 0.9, signals: ["ocr-authorized:full-page-image-with-sparse-text"] };
  }
  return {
    authorized: false,
    confidence: 0.8,
    signals: [`ocr-not-authorized:minor-images=${evidence.imageCount}`],
  };
}

export function authorizeStructuredOcr(
  complexity: StructuredPageComplexityEvidence,
  nativeText: string,
  imageEvidence?: PageImageEvidence,
  hasPageAlignment = true,
): AdaptiveOcrDecision {
  const yieldEvidence = pageTextYield(nativeText, complexity.textLength);
  // Independent structured text evidence shows a substantial text layer, yet canonical
  // extraction lost most of it. Image byte totals do not establish text expectations.
  if (hasPageAlignment && yieldEvidence.substantialDeficit && !complexity.isGarbled &&
      Number.isFinite(complexity.textCoverage) && complexity.textCoverage >= 0.05 && complexity.textCoverage <= 1) {
    return {
      authorized: true,
      confidence: 0.8,
      signals: [
        "ocr-authorized:structured-text-yield-deficit",
        `text-yield:expected-chars=${yieldEvidence.expectedCharacters}:actual-chars=${yieldEvidence.actualCharacters}:actual-utf8-bytes=${yieldEvidence.actualTextBytes}`,
      ],
    };
  }
  const reasons = new Set(complexity.reasons.map((reason) => reason.toLowerCase()));
  const noNativeText =
    !nativeText.trim() ||
    complexity.textLength === 0 ||
    reasons.has("no-text") ||
    reasons.has("no-native-text") ||
    reasons.has("scanned-page");
  const fullPageImage =
    complexity.fullPageImage ||
    complexity.largestImageCoverage >= 0.85 ||
    reasons.has("full-page-image");
  const plausibilityFailed = nativeTextFailsPlausibility(nativeText);
  const uncoveredVectorRatio =
    (complexity.uncoveredVectorArea ?? 0) / Math.max(1, complexity.pageArea);
  const garbledOrUncovered =
    complexity.isGarbled ||
    reasons.has("garbled-text") ||
    reasons.has("uncovered-vector-text") ||
    uncoveredVectorRatio >= 0.05;
  const substantialRasterWithSparseText =
    complexity.needsOcr &&
    complexity.hasSubstantialImages &&
    complexity.largestImageCoverage >= 0.35 &&
    (reasons.has("sparse-text") || reasons.has("embedded-images"));

  // Something to read besides native text: image content, a scan, or vector-drawn text.
  const hasVisualContent =
    fullPageImage ||
    complexity.hasSubstantialImages ||
    complexity.imageCoverage > 0 ||
    complexity.largestImageCoverage > 0 ||
    reasons.has("scanned") ||
    reasons.has("scanned-page") ||
    uncoveredVectorRatio >= 0.05 ||
    (imageEvidence?.imageCount ?? 0) > 0;

  if (noNativeText && !hasVisualContent) {
    return { authorized: false, confidence: 0.9, signals: [BLANK_PAGE_SIGNAL] };
  }
  if (noNativeText) {
    return {
      authorized: true,
      confidence: 0.96,
      signals: ["ocr-authorized:no-native-text"],
    };
  }
  if (fullPageImage) {
    return {
      authorized: true,
      confidence: 0.92,
      signals: ["ocr-authorized:full-page-image"],
    };
  }
  if (substantialRasterWithSparseText) {
    return {
      authorized: true,
      confidence: 0.88,
      signals: ["ocr-authorized:substantial-raster-with-sparse-text"],
    };
  }
  if (garbledOrUncovered && plausibilityFailed) {
    return {
      authorized: true,
      confidence: 0.86,
      signals: ["ocr-authorized:complexity-and-plausibility-failure"],
    };
  }

  const ignoredReasons = [...reasons].filter(
    (reason) => reason.includes("sparse") || reason.includes("embedded-image"),
  );
  return {
    authorized: false,
    confidence: 0.9,
    signals: [
      "ocr-not-authorized",
      ...(ignoredReasons.length > 0
        ? ignoredReasons.map((reason) => `ocr-ignored:${reason}`)
        : []),
    ],
  };
}

function nativeTextFailsPlausibility(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return true;
  const words = normalized.split(/\s+/).filter(Boolean);
  const replacementCharacters = (normalized.match(/�/g) ?? []).length;
  const unusualCharacters = (normalized.match(/[^\p{L}\p{N}\s.,:%$()'"!?/\-]/gu) ?? []).length;
  const averageWordLength =
    words.reduce((sum, word) => sum + word.length, 0) / Math.max(1, words.length);
  return (
    replacementCharacters > 0 ||
    unusualCharacters > Math.max(4, normalized.length * 0.08) ||
    averageWordLength > 24 ||
    averageWordLength < 1.5
  );
}

function canonicalBlocksToPageText(
  blocks: Array<{ text?: string; pageNumber?: number | null; order?: number }>,
  pageCount: number,
): string {
  const pages = Array.from({ length: Math.max(1, pageCount) }, () => [] as typeof blocks);
  for (const block of blocks) {
    const pageIndex = Math.max(0, Math.min(pages.length - 1, (block.pageNumber ?? 1) - 1));
    pages[pageIndex]!.push(block);
  }
  return pages
    .map((pageBlocks) =>
      pageBlocks
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
        .map((block) => block.text?.trim() ?? "")
        .filter(Boolean)
        .join("\n\n"),
    )
    .join("\f");
}

export function classifyTextAndFilename(text: string, filename: string, options: RoutingVersionOptions = {}): {
  label: string;
  confidence: number;
  signals: string[];
} {
  const name = filename.toLowerCase();
  const routingV2 = options.routingV2 === true;
  // v2 classifies on a bounded prefix: the label comes from the opening pages, and term scans over
  // an unbounded upload must not grow with it.
  const body = (routingV2 ? text.slice(0, CLASSIFY_TEXT_MAX_CHARS) : text).toLowerCase();
  const signals: string[] = [];

  function hit(cond: boolean, token: string) {
    if (cond) signals.push(token);
    return cond;
  }

  // v2: whole-word terms, and at least two distinct ones from the body: substrings ("vat" in
  // "observation", "term" in "determine") and a single stray word labelled scanned brochures
  // and field notes as invoices or contracts.
  const isInvoice =
    hit(/invoice/.test(name), "name:invoice") ||
    hit(routingV2
      ? /\binvoice\s*(?:#|no\b|number\b)/i.test(body) ||
        hasDistinctTerms(body, /\b(?:invoice|billed to|bill to|remit to|subtotal|vat|amount due|balance due|due date)\b/gi, 2)
      : /invoice\s*#|billed to|remit to|subtotal|vat/i.test(body),
    "body:invoice-terms");

  const isBank = hit(
    routingV2
      ? hasDistinctTerms(body, /\b(?:statement period|account statement|routing\s+number|account\s+number|transactions|opening balance|closing balance)\b/gi, 2)
      : /statement|routing\s+number|account\s+number|transactions/i.test(body),
    "body:bank-terms",
  );

  const isContract = hit(
    routingV2
      ? hasDistinctTerms(body, /\b(?:agreement|parties|party|witnesseth|hereby|governing law|signature|indemnif\w*|termination)\b/gi, 2)
      : /agreement|party|term|witnesseth|hereby|governing law|signature/i.test(body),
    "body:contract-terms",
  );

  const isReport = hit(/table of contents|executive summary|introduction|conclusion|references/i.test(body), "body:report-structure");

  const isForm = hit(/\bform\b|fill out|please complete/i.test(body), "body:form-terms");

  const isTableHeavy = hit(/\|.*\|/.test(text) || /\btbl\b|table\s+\d+/i.test(body), "body:table-markers");

  let label = "generic";
  let confidence = 0.5;
  if (isInvoice) {
    label = "invoice"; confidence = 0.9;
  } else if (isBank) {
    label = "bank-statement"; confidence = 0.8;
  } else if (isContract) {
    label = "contract"; confidence = 0.75;
  } else if (isForm) {
    label = "form"; confidence = 0.7;
  } else if (isReport) {
    label = "report"; confidence = 0.65;
  }

  if (isTableHeavy && confidence < 0.9) {
    confidence = Math.min(0.9, confidence + 0.1);
  }

  return { label, confidence, signals };
}

/** Characters of a document the v2 label scan reads (`classifyTextAndFilename`). */
export const CLASSIFY_TEXT_MAX_CHARS = 256 * 1024;
/** Characters of a page the v2-only page scans read (numeric rows, garbled runs, Unicode math). */
export const PAGE_SCAN_MAX_CHARS = 64 * 1024;

/**
 * Whether `text` holds at least `needed` distinct matches of the global `pattern`. Walks matches
 * with `exec` and stops at the answer, so memory stays constant whatever the text's size.
 */
export function hasDistinctTerms(text: string, pattern: RegExp, needed: number): boolean {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const seen = new Set<string>();
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    if (match[0] === "") {
      re.lastIndex += 1;
      continue;
    }
    seen.add(match[0].toLowerCase().replace(/\s+/g, " "));
    if (seen.size >= needed) return true;
  }
  return false;
}

/** Number of matches of the global `pattern` in `text`, without building the match array. */
function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    count += 1;
    if (match[0] === "") pattern.lastIndex += 1;
  }
  return count;
}

/** Total length of the matches of the global `pattern` in `text`, without building the match array. */
function matchedLength(text: string, pattern: RegExp): number {
  let total = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    total += match[0].length;
    if (match[0] === "") pattern.lastIndex += 1;
  }
  return total;
}

export function buildAdaptivePageRoutes(
  text: string,
  pageCount: number,
  options: RoutingVersionOptions = {},
): AdaptivePageRoutingEntry[] {
  return buildAdaptivePageRoutesFromTexts(splitTextIntoPages(text, Math.max(1, pageCount)), pageCount, options);
}

function buildAdaptivePageRoutesFromTexts(
  pageTexts: string[],
  pageCount: number,
  options: RoutingVersionOptions,
): AdaptivePageRoutingEntry[] {
  const resolvedPages = pageTexts.length > 0 ? pageTexts : Array.from({ length: Math.max(1, pageCount) }, () => "");
  return resolvedPages.map((pageText, index) => classifyAdaptivePage(index + 1, pageText, options));
}

export function classifyAdaptivePage(
  pageNumber: number,
  text: string,
  options: RoutingVersionOptions = {},
): AdaptivePageRoutingEntry {
  const routingV2 = options.routingV2 === true;
  const normalized = text.trim();
  const charCount = normalized.length;
  // Same count as splitting on whitespace, without an array of every word on the page.
  const wordCount = countMatches(normalized, /\S+/g);
  const lines = normalized ? normalized.split(/\n+/).filter(Boolean) : [];
  const digitCount = countMatches(normalized, /\d/g);
  // v2-only scans read a bounded prefix of the page (PAGE_SCAN_MAX_CHARS).
  const scanText = routingV2 ? normalized.slice(0, PAGE_SCAN_MAX_CHARS) : "";
  const scanLines = scanText ? scanText.split(/\n+/).filter(Boolean) : [];
  const colonLineCount = lines.filter((line) => line.includes(":")).length;
  const markdownTableLineCount = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line)).length;
  // v2: OCR flattens a table into rows of space-separated cells; several rows with two or more
  // numeric cells are the table that survives.
  const numericRowLines = !routingV2 ? 0 : scanLines.filter((line) => {
    const cells = line.trim().split(/\s+/);
    return cells.length >= 3 && cells.filter((cell) => /^[-+(]?[$€£¥]?\d[\d,.:/%)]*$/.test(cell)).length >= 2;
  }).length;
  const tableMarkers = [
    /\|.+\|/.test(normalized),
    /\t/.test(text),
    /table\s+\d+|subtotal|total|amount|qty|balance|debit|credit/i.test(normalized),
    numericRowLines >= 3,
  ].filter(Boolean).length;
  const formFieldLineCount = lines.filter((line) =>
    /^(?:#{1,6}\s*)?(?:name|address|date|signature|phone|email|case\s+id|submitted\s+by|preferred\s+contact|reviewer\s+notes)\b/i.test(line.trim()),
  ).length;
  const formMarkers = [
    /_{3,}|\.{3,}|\[\s?\]|\(\s?\)/.test(text),
    colonLineCount >= Math.max(3, Math.ceil(lines.length * 0.25)),
    /name|address|date|signature|phone|email|account|policy|claim/i.test(normalized)
  ].filter(Boolean).length;
  const chartMarkers = [
    /figure|chart|graph|axis|legend|series|plot|dataset/i.test(normalized),
    /%/.test(normalized),
    lines.some((line) => /\bq[1-4]\b|\bjan\b|\bfeb\b|\bmar\b/i.test(line))
  ].filter(Boolean).length;
  // v2: text from fonts without a Unicode map comes out as long runs of shifted glyph codes
  // ("6FDOLQJDWWHQWLRQ...") rather than words: the text layer exists but is unreadable.
  const garbledCharacters = !routingV2 ? 0 : matchedLength(scanText, /[A-Za-z0-9]{20,}/g);
  const garbledText = routingV2 && charCount >= 200 && garbledCharacters / Math.max(1, scanText.length) >= 0.2;
  const degradationMarkers = [
    charCount < 80,
    /�/.test(normalized),
    countMatches(normalized, /[^\w\s.,:%$()/-]/g) > Math.max(6, charCount * 0.08),
    wordCount > 0 && charCount / Math.max(1, wordCount) < 3.2
  ].filter(Boolean).length;
  const imageMarkers = [
    /photo|image|diagram|illustration|screenshot/i.test(normalized),
    charCount < 140 && wordCount < 24 && chartMarkers >= 2
  ].filter(Boolean).length;
  const textDensityScore = Math.min(1, (charCount / 900) * 0.6 + (wordCount / 180) * 0.4);
  const signals: string[] = [];
  const specializedContent = detectSpecializedContent(normalized, lines, routingV2);

  let route: AdaptivePageRoute = "straightforward-text";
  let extractorHint: AdaptivePageRoutingEntry["extractorHint"] = "cheap-text";
  let confidence = Math.max(0.45, textDensityScore);

  if (garbledText) {
    route = "handwriting-or-degraded";
    extractorHint = "vision-rescue";
    confidence = 0.86;
    signals.push("garbled-text");
  } else if (degradationMarkers >= 2) {
    route = "handwriting-or-degraded";
    extractorHint = "vision-rescue";
    confidence = 0.82;
    signals.push("low-text-density", "ocr-noise");
  } else if (specializedContent.length > 0) {
    const dominantSpecialized = specializedContent[0];
    route = mapSpecializedContentToRoute(dominantSpecialized.kind);
    extractorHint = "syntax-preserving";
    confidence = dominantSpecialized.confidence;
    signals.push(...dominantSpecialized.signals, "syntax-preserving");
  } else if (formMarkers >= 2 || formFieldLineCount >= 2) {
    route = "form";
    extractorHint = "layout-aware";
    confidence = 0.79;
    signals.push("field-markers", "label-value-layout");
  } else if (tableMarkers >= 2 || markdownTableLineCount >= 2) {
    route = "table-heavy";
    extractorHint = "layout-aware";
    confidence = 0.76;
    signals.push("table-markers");
  } else if (chartMarkers >= 2) {
    route = "chart-or-figure";
    extractorHint = "vision-rescue";
    confidence = 0.72;
    signals.push("chart-markers");
  } else if (imageMarkers >= 1) {
    route = "image-heavy";
    extractorHint = "vision-rescue";
    confidence = 0.68;
    signals.push("image-markers");
  } else {
    signals.push("dense-prose");
  }

  if (digitCount > Math.max(12, charCount * 0.18)) {
    signals.push("numeric-heavy");
  }

  return {
    pageNumber,
    route,
    confidence,
    textDensityScore,
    signals,
    extractorHint,
    specializedContent
  };
}

type SpecializedSignalCandidate = {
  kind: AdaptiveSpecializedContentKind;
  confidence: number;
  signals: string[];
};

function detectSpecializedContent(text: string, lines: string[], routingV2: boolean): AdaptiveSpecializedContentEntry[] {
  if (!text) {
    return [];
  }

  const candidates = [
    detectFormulaHeavyContent(text, lines, routingV2),
    detectSourceCodeContent(text, lines),
    detectChemicalNotationContent(text, lines)
  ].filter((candidate): candidate is SpecializedSignalCandidate => candidate !== null);

  return candidates
    .sort((left, right) => right.confidence - left.confidence)
    .map((candidate) => ({
      kind: candidate.kind,
      confidence: candidate.confidence,
      signals: candidate.signals
    }));
}

function detectFormulaHeavyContent(text: string, lines: string[], routingV2: boolean): SpecializedSignalCandidate | null {
  const signals: string[] = [];
  const latexCommands = countMatches(text, /\\(?:frac|sum|int|alpha|beta|gamma|theta|lambda|mu|sigma|pi|sqrt|times|cdot|begin\{(?:equation|align)\}|end\{(?:equation|align)\})/g);
  const equationLines = lines.filter((line) => /[=<>]/.test(line) && /[+\-*/^_]/.test(line)).length;
  const mathFunctionTerms = countMatches(text, /\b(?:sin|cos|tan|cot|sec|csc|log|ln|lim|max|min|argmax|argmin|sqrt)\b/gi);
  const symbolDensity = countMatches(text, /[=+\-*/^_<>]/g);
  const functionAssignmentLines = lines.filter((line) => /\b[a-z]\w*\([^)]*\)\s*=/.test(line) || /\b(?:f|g|h|y)\s*=\s*[^.]{4,}/i.test(line)).length;

  // v2: text layers of typeset math carry it as Unicode: mathematical alphanumerics (𝑑, 𝐱) and
  // operators (∑, ≤, √). Their linear order loses fractions, scripts and roots.
  const mathScan = routingV2 ? text.slice(0, PAGE_SCAN_MAX_CHARS) : "";
  const mathAlphanumerics = routingV2 ? countMatches(mathScan, /[\u{1D400}-\u{1D7FF}]/gu) : 0;
  const mathOperators = routingV2 ? countMatches(mathScan, /[\u2200-\u22FF\u27C0-\u27EF\u2980-\u2AFF]/gu) : 0;
  if (mathAlphanumerics >= 3) signals.push("math:unicode-alphanumerics");
  if (mathAlphanumerics + mathOperators >= 6) signals.push("math:unicode-symbols");
  if (latexCommands > 0) signals.push("math:latex");
  if (equationLines > 0) signals.push("math:equation-lines");
  if (mathFunctionTerms >= 2) signals.push("math:function-terms");
  if (symbolDensity > Math.max(12, text.length * 0.06) && equationLines > 0) signals.push("math:symbol-density");
  if (functionAssignmentLines > 0) signals.push("math:function-assignment");

  const hasStrongMathContext =
    latexCommands > 0 ||
    mathAlphanumerics >= 3 ||
    mathFunctionTerms >= 2 ||
    functionAssignmentLines > 0 ||
    equationLines >= 2;

  if (!hasStrongMathContext) {
    return null;
  }

  if (signals.length < 2) {
    return null;
  }

  return {
    kind: "formula",
    confidence: Math.min(0.94, 0.62 + signals.length * 0.08 + Math.min(0.08, latexCommands * 0.03)),
    signals
  };
}

function detectSourceCodeContent(text: string, lines: string[]): SpecializedSignalCandidate | null {
  const signals: string[] = [];
  const codeFenceCount = (text.match(/```|~~~/g) ?? []).length;
  const keywordCount = (text.match(/\b(?:function|const|let|var|class|interface|type|return|import|export|from|def|elif|else|for|while|switch|case|async|await|public|private|protected|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/g) ?? []).length;
  const codeSpecificKeywordCount = (text.match(/\b(?:function|const|let|var|class|interface|return|import|export|def|elif|switch|case|async|await|public|private|protected|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/g) ?? []).length;
  const structuralLines = lines.filter((line) =>
    /[{};]/.test(line) ||
    /=>/.test(line) ||
    /^#include\b/.test(line) ||
    /<\/?[A-Za-z][^>]*>/.test(line) ||
    /\bconsole\.log\b|\bprint\(/.test(line)
  ).length;
  const indentationLines = lines.filter((line) => /^[ \t]{2,}\S/.test(line)).length;
  const commentLines = lines.filter((line) => /^\s*(?:\/\/|#|\/\*|\*)/.test(line)).length;
  const mathLikeLines = lines.filter((line) =>
    /\\(?:frac|sum|int|sqrt|partial|nabla|alpha|beta|theta)\b/.test(line) ||
    (/[=<>]/.test(line) && /[+\-*/^_]/.test(line)),
  ).length;
  const hasCodeStructure =
    codeFenceCount > 0 || structuralLines >= 2 || indentationLines >= 2;
  const fencedMathWithoutCodeKeywords =
    codeFenceCount > 0 && mathLikeLines >= 2 && codeSpecificKeywordCount === 0;

  if (codeFenceCount > 0) signals.push("code:fence");
  if (keywordCount >= 2) signals.push("code:keywords");
  if (structuralLines >= 2) signals.push("code:structure");
  if (indentationLines >= 2) signals.push("code:indentation");
  if (commentLines >= 1 && keywordCount >= 1) signals.push("code:comments");

  if (signals.length < 2 || !hasCodeStructure || fencedMathWithoutCodeKeywords) {
    return null;
  }

  return {
    kind: "source-code",
    confidence: Math.min(0.96, 0.64 + signals.length * 0.08 + Math.min(0.08, codeFenceCount * 0.03)),
    signals
  };
}

function detectChemicalNotationContent(text: string, lines: string[]): SpecializedSignalCandidate | null {
  const signals: string[] = [];
  const reactionLines = lines.filter((line) =>
    /(?:->|=>|<->|<=>|⇌|→)/.test(line) &&
    /(?:[A-Z][a-z]?\d*){1,}/.test(line)
  ).length;
  const chemistryTerms = (text.match(/\b(?:InChI=|SMILES|CAS(?:\s+No\.?|\s+Number)?|m\/z|NMR|HPLC|LC-MS|GC-MS|IR|ppm|pH|mol%|mmol|μmol|stoichiometry|catalyst|solvent|reagent)\b/gi) ?? []).length;
  const formulaTokens = (text.match(/\b(?:NaCl|KCl|LiCl|HCl|HBr|H2O|CO2|NH3|O2|N2|CH4|C6H6|C6H12O6|EtOH|MeOH|DMSO|DMF|THF|AcOH|(?:[A-Z][a-z]?\d{1,3}){2,})\b/g) ?? []).length;
  const smilesLikeTokens = (text.match(/\b(?:InChI=[^\s]+|[CNOPSFIBrcl@+\-[\]()=#\\/]{8,})\b/g) ?? []).length;

  if (reactionLines > 0) signals.push("chem:reaction-arrow");
  if (chemistryTerms >= 1) signals.push("chem:domain-terms");
  if (formulaTokens >= 2) signals.push("chem:formulae");
  if (smilesLikeTokens >= 1) signals.push("chem:linear-notation");

  if (signals.length < 2) {
    return null;
  }

  return {
    kind: "chemical-notation",
    confidence: Math.min(0.95, 0.63 + signals.length * 0.08 + Math.min(0.08, reactionLines * 0.03)),
    signals
  };
}

function mapSpecializedContentToRoute(kind: AdaptiveSpecializedContentKind): AdaptivePageRoute {
  switch (kind) {
    case "formula":
      return "formula-heavy";
    case "source-code":
      return "code-heavy";
    case "chemical-notation":
      return "chemical-notation-heavy";
  }
}

export function summarizeSpecializedContent(pages: AdaptivePageRoutingEntry[]): AdaptiveSpecializedContentSummary[] {
  const summary = new Map<AdaptiveSpecializedContentKind, AdaptiveSpecializedContentSummary>();

  for (const page of pages) {
    for (const entry of page.specializedContent ?? []) {
      const existing = summary.get(entry.kind);
      if (existing) {
        existing.pageCount += 1;
        existing.pageNumbers.push(page.pageNumber);
        existing.maxConfidence = Math.max(existing.maxConfidence, entry.confidence);
      } else {
        summary.set(entry.kind, {
          kind: entry.kind,
          pageCount: 1,
          pageNumbers: [page.pageNumber],
          maxConfidence: entry.confidence
        });
      }
    }
  }

  return [...summary.values()].sort((left, right) => {
    if (right.pageCount !== left.pageCount) {
      return right.pageCount - left.pageCount;
    }
    return right.maxConfidence - left.maxConfidence;
  });
}

export function summarizeAdaptiveRouting(pages: AdaptivePageRoutingEntry[]): {
  documentComplexity: AdaptiveDocumentComplexity;
  dominantRoutes: AdaptivePageRoute[];
  visionPolicy: AdaptiveRoutingArtifact["visionPolicy"];
} {
  const counts = new Map<AdaptivePageRoute, number>();
  for (const page of pages) {
    counts.set(page.route, (counts.get(page.route) ?? 0) + 1);
  }

  const dominantRoutes = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([route]) => route);
  const totalPages = Math.max(1, pages.length);
  const hardPages = pages.filter((page) => page.route !== "straightforward-text").length;
  const degradedPages = pages.filter((page) => page.route === "handwriting-or-degraded").length;
  const hardRatio = hardPages / totalPages;

  let documentComplexity: AdaptiveDocumentComplexity = "simple";
  if (hardRatio >= 0.6 || degradedPages > 0) {
    documentComplexity = "complex";
  } else if (hardRatio >= 0.2) {
    documentComplexity = "mixed";
  }

  let visionPolicy: AdaptiveRoutingArtifact["visionPolicy"] = "skip";
  if (documentComplexity === "complex") {
    visionPolicy = "aggressive";
  } else if (hardPages > 0) {
    visionPolicy = "selective";
  }

  return { documentComplexity, dominantRoutes, visionPolicy };
}

export function suggestPlaybook(label: string): ParserPlaybookKey | null {
  switch (label) {
    case "invoice":
    case "bank-statement":
    case "form":
      return "layout-aware"; // prioritize tables and bbox alignment
    case "contract":
      return "balanced"; // prose with headings
    case "report":
      return "agentic"; // richer sections, figures
    default:
      return null;
  }
}

export function resolveAdaptivePlaybook(args: {
  label: string;
  documentComplexity: AdaptiveDocumentComplexity;
  dominantRoutes: AdaptivePageRoute[];
}): ParserPlaybookKey | null {
  const basePlaybook = suggestPlaybook(args.label);
  const specializedRoutes: AdaptivePageRoute[] = [
    "formula-heavy",
    "code-heavy",
    "chemical-notation-heavy"
  ];

  if (args.dominantRoutes.some((route) => specializedRoutes.includes(route))) {
    return "agentic";
  }

  if (args.documentComplexity === "simple" && args.label === "generic") {
    return "fast";
  }

  if (args.documentComplexity === "complex") {
    if (args.dominantRoutes.includes("handwriting-or-degraded")) {
      return "review-grade";
    }
    if (args.dominantRoutes.includes("chart-or-figure") || args.dominantRoutes.includes("image-heavy")) {
      return "agentic";
    }
  }

  if (args.dominantRoutes.includes("form") || args.dominantRoutes.includes("table-heavy")) {
    return "layout-aware";
  }

  return basePlaybook;
}
