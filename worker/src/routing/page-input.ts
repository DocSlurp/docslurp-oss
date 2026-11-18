/**
 * Builds `PageInput[]` for the router from a PDF: runs the deterministic in-process native-pdf probe
 * (`worker/src/routing/probe/`; JSON lines: features, text facts, images, optional thumbnails) and merges the
 * classify-route heuristic (when available) into each page's `heuristic`.
 */

import sharp from "../tools/isolated-image.js";
import {
  PAGE_FEATURES_SCHEMA_VERSION,
  PAGE_INPUT_SCHEMA_VERSION,
  pageInputSchema,
  type AdaptiveRoutingArtifact,
  type PageInput,
  type TextLayerStatus,
} from "@docslurp/shared";

import {
  PAGE_EVIDENCE, TABLE_PATH_CAPPED_FEATURE, pageEvidenceFromProbeRow, readImageBoxes, routerTablePaths, routerTableRuleScore,
  type NativeProbePage, type PageEvidence,
} from "../lib/page-evidence.js";
import { DEFAULT_PLANNER_CONFIG } from "./planner.js";
import { loadProbeBinding } from "./probe/binding.js";
import type { Recogniser } from "./probe/ocr-layer.js";
import { NativeProbeOpenError, PROBE_OVERLAP_MAX_PAGES, looksEncrypted, lockedRow, probeNativePdf } from "./probe/probe.js";

/** The native probe's row (JSON lines). Page evidence reads it through pageEvidenceFromProbeRow. */
export interface ProbeRow extends NativeProbePage {
  pageNumber: number;
  pageCount: number;
  charCount: number;
  wordCount: number;
  textCoverage: number;
  fontCount: number;
  unmappedGlyphRatio: number;
  mathGlyphRatio: number;
  tableRuleScore: number;
  imageCoverage: number;
  largestImageCoverage: number;
  fullPageImage: boolean;
  vectorDrawingCount: number;
  uncoveredVectorRatio: number;
  garbled: boolean;
  textLayerStatus: TextLayerStatus;
  imageCount: number;
  textFacts: { wordCount: number | null; imageCount: number | null; imageCoverage: number | null; textLayerStatus: TextLayerStatus };
  /** Hidden-text signals (TL1). Absent on probes from before TL1. */
  invisibleTextRatio?: number;
  textOverImageRatio?: number;
  /** Present only when the probe ran with `--verify-ocr-layer` on an OCR-layer page. */
  ocrLayerCheck?: { agreement: number | null; tokens: number; cpuMs: number; wallMs: number };
  images: Array<{ bbox: [number, number, number, number]; coverage: number }>;
  smallestFontPt: number | null;
  widthPt: number;
  heightPt: number;
  rotation: number;
  probeMs: number;
  thumbnail?: string;
  /** H9 features (acroform-filled, ocg-hidden, ...). Absent on probes from before W14. */
  unusualFeatures?: string[];
  needsAttention?: boolean;
  /** Single row emitted for a password-protected document. */
  locked?: boolean;
  /** Set by the native-pdf probe (`native-pdf@<version>+<sha>`); absent on rows from the Python probe. */
  probeEngine?: string;
}

export type ProbeRunner = (args: {
  pdfPath: string;
  pages?: string;
  thumbDir?: string;
  thumbPx?: number;
  /** Re-OCR a band of pages whose text lies over a page image and report how well the layer agrees (needs `recognise`). */
  verifyOcrLayer?: boolean;
  /** OCR for the layer check, run in the OCR boundary; absent (the worker's default) leaves OCR layers unverified. */
  recognise?: Recogniser;
  signal?: AbortSignal;
}) => Promise<string>;

/**
 * Probe render overlap settings. `PROBE_OVERLAP_RENDER=1|true|on` renders each page's 72 DPI image on a second handle
 * while the feature handle reads the page (default off: the second handle parses the untrusted file a second time inside
 * the worker process, which holds secrets, so it stays opt-in). `PROBE_OVERLAP_MAX_PAGES` (default 1000) caps the page
 * count of documents that get the second handle; non-numeric or negative values keep the default.
 */
export function readProbeOverlap(env: NodeJS.ProcessEnv = process.env): { overlapRender: boolean; overlapRenderMaxPages: number } {
  const flag = env.PROBE_OVERLAP_RENDER?.trim().toLowerCase();
  const max = Number(env.PROBE_OVERLAP_MAX_PAGES?.trim() || Number.NaN);
  return {
    overlapRender: flag === "1" || flag === "true" || flag === "on",
    overlapRenderMaxPages: Number.isInteger(max) && max >= 0 ? max : PROBE_OVERLAP_MAX_PAGES,
  };
}

/** Native runner: probes in-process through the native-pdf binding and emits the same JSON lines. Throws when the binding is absent. */
export function createNativeProbeRunner(env: NodeJS.ProcessEnv = process.env): ProbeRunner {
  return async ({ pdfPath, pages, thumbDir, thumbPx, verifyOcrLayer, recognise, signal }) => {
    const loaded = loadProbeBinding();
    if (!loaded.ok) throw new NativeProbeOpenError("NATIVE_PDF_UNAVAILABLE", `native-pdf probe unavailable: ${loaded.reason}`);
    const lines: string[] = [];
    const overlap = readProbeOverlap(env);
    for await (const row of probeNativePdf(loaded.binding, { pdfPath, pages, thumbDir, thumbPx, verifyOcrLayer, recognise, signal, ...overlap })) lines.push(JSON.stringify(row));
    return lines.join("\n") + "\n";
  };
}

/**
 * Default runner: the in-process native-pdf probe (the only probe; the Python probe was removed). A document the
 * engine cannot open is reported as locked when it looks encrypted (needs attention) rather than failing the run; without
 * the private binding the error says so and the page router stays off for that document (PAGE_ROUTER_MODE is off by default).
 */
export function createProbeRunner(): ProbeRunner {
  const native = createNativeProbeRunner();
  return async (args) => {
    try {
      return await native(args);
    } catch (error) {
      if (!(error instanceof NativeProbeOpenError)) throw error;
      if (await looksEncrypted(args.pdfPath).catch(() => false)) return JSON.stringify(lockedRow()) + "\n";
      throw new Error(`page probe failed: ${error.message}`);
    }
  };
}

export function parseProbeOutput(stdout: string): ProbeRow[] {
  const rows: ProbeRow[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    rows.push(JSON.parse(text) as ProbeRow);
  }
  return rows;
}

/** Cheap 0..1 trust in the native text layer from probe signals alone. */
export function nativePlausibility(row: Pick<ProbeRow, "textLayerStatus" | "garbled" | "unmappedGlyphRatio">): number {
  if (row.textLayerStatus === "absent") return 0;
  if (row.garbled) return 0.1;
  const base = row.textLayerStatus === "ok" ? 1 : row.textLayerStatus === "suspect" ? 0.4 : row.textLayerStatus === "ocr-layer" ? 0.3 : 0.5;
  return Math.max(0, Math.min(1, base * (1 - Math.min(1, row.unmappedGlyphRatio * 5))));
}

export interface BuildPageInputsOptions {
  pdfPath: string;
  /** 1-based page spec for the probe, e.g. "1,2,5-7". */
  pages?: string;
  thumbDir?: string;
  thumbPx?: number;
  /** Verify OCR layers against the page image (default true; costs ~1 s CPU per OCR-layer page only). */
  verifyOcrLayer?: boolean;
  /** Sandboxed OCR for that check; without it OCR layers stay unverified. */
  recognise?: Recogniser;
  /** classify-route artifact for the document, when it already ran. */
  routing?: AdaptiveRoutingArtifact | null;
  documentFormat?: string;
  probe?: ProbeRunner;
  signal?: AbortSignal;
}

async function thumbnailInfo(file: string | undefined): Promise<PageInput["thumbnail"]> {
  if (!file) return undefined;
  try {
    const meta = await sharp(file).metadata();
    if (!meta.width || !meta.height) return undefined;
    return { uri: file, widthPx: meta.width, heightPx: meta.height };
  } catch {
    return undefined;
  }
}

/**
 * The router's page input from page evidence (lib/page-evidence.ts), merged with the classify-route heuristic for the page.
 * Unknown quantities read as the probe's failed row does (zero, `unknown` layer, no images); a locked document is one
 * page; the table rule score is page-evidence.ts routerTableRuleScore (grids on the table path, unknown included, are a full
 * table need), and only a `known` page's images reach the inset gate (readImageBoxes).
 */
export async function pageInputFromEvidence(
  evidence: PageEvidence,
  routing: AdaptiveRoutingArtifact | null | undefined,
  documentFormat = "pdf",
  extra: { pageCount: number; thumbnail?: string; tablePathCapped?: boolean },
): Promise<PageInput> {
  const locked = evidence.state === "locked";
  const pageNumber = locked ? 1 : evidence.page;
  const t = evidence.text;
  const img = evidence.state === "known" ? evidence.images : null;
  const vec = evidence.state === "known" ? evidence.vectors : null;
  const native = {
    textLayerStatus: t.status, garbled: t.garbled ?? false, unmappedGlyphRatio: evidence.unmappedGlyphRatio ?? 0,
  };
  const entry = routing?.pages.find((page) => page.pageNumber === pageNumber);
  const features = extra.tablePathCapped ? [...new Set([...evidence.features, TABLE_PATH_CAPPED_FEATURE])].sort() : evidence.features;
  const size = evidence.size ?? { widthPt: PAGE_EVIDENCE.defaultWidthPt, heightPt: PAGE_EVIDENCE.defaultHeightPt };
  const input: PageInput = {
    schemaVersion: PAGE_INPUT_SCHEMA_VERSION,
    features: {
      schemaVersion: PAGE_FEATURES_SCHEMA_VERSION,
      pageNumber,
      documentFormat,
      pageCount: locked ? 1 : extra.pageCount,
      native: {
        charCount: t.chars ?? 0,
        wordCount: t.words ?? 0,
        textCoverage: t.coverage ?? 0,
        fontCount: evidence.fonts?.count ?? 0,
        unmappedGlyphRatio: native.unmappedGlyphRatio,
        // Unmeasured math glyphs read as none (the math gate cannot fire); the encodings name math that needs a read.
        mathGlyphRatio: t.mathGlyphRatio ?? 0,
        tableRuleScore: routerTableRuleScore(evidence, { unknownTablePath: !extra.tablePathCapped }),
        garbled: native.garbled,
        plausibility: nativePlausibility(native),
      },
      raster: {
        imageCoverage: img?.coverage ?? 0,
        largestImageCoverage: img?.largestCoverage ?? 0,
        fullPageImage: img?.fullPageImage ?? false,
        vectorDrawingCount: vec?.paths ?? 0,
        // The router's features are numbers: an unmeasured share reads as none, as the probe's failed row does.
        uncoveredVectorRatio: vec?.uncoveredRatio ?? 0,
        smallestFontPt: evidence.fonts?.smallestPt ?? null,
      },
      geometry: { widthPt: size.widthPt, heightPt: size.heightPt, rotation: evidence.rotation ?? 0 },
      heuristic: {
        route: entry?.route ?? "straightforward-text",
        extractorHint: entry?.extractorHint ?? null,
        specializedKinds: entry?.specializedContent.map((s) => s.kind) ?? [],
        ocrAuthorized: entry?.ocrDecision?.authorized ?? null,
        textDensityScore: entry?.textDensityScore ?? t.coverage ?? 0,
      },
      decisions: null,
      provenance: { probe: evidence.source === "doppler-facts" ? "doppler-facts" : "native-pdf-probe", probeMs: evidence.probeMs },
    },
    textFacts: {
      wordCount: t.words,
      imageCount: img ? img.count : null,
      imageCoverage: img ? img.coverage : null,
      textLayerStatus: t.status,
      ...(t.invisibleTextRatio !== null ? { invisibleTextRatio: t.invisibleTextRatio } : {}),
      ...(t.textOverImageRatio !== null ? { textOverImageRatio: t.textOverImageRatio } : {}),
      ...(t.ocrLayerAgreement !== undefined ? { ocrLayerAgreement: t.ocrLayerAgreement, ocrLayerMs: t.ocrLayerMs } : {}),
    },
    ...(features.length > 0 ? { unusualFeatures: features } : {}),
    images: readImageBoxes(evidence).map((image, index) => ({
      index,
      bbox: {
        x: image.bbox[0],
        y: image.bbox[1],
        width: Math.max(0, image.bbox[2] - image.bbox[0]),
        height: Math.max(0, image.bbox[3] - image.bbox[1]),
      },
      coverage: image.coverage,
    })),
    thumbnail: await thumbnailInfo(extra.thumbnail),
  };
  return pageInputSchema.parse(input);
}

/**
 * A document's page inputs from its page evidence, with the table paths that come only from unknown grids capped per
 * document (page-evidence.ts routerTablePaths, at the planner's table need).
 */
export async function pageInputsFromEvidence(
  pages: readonly PageEvidence[],
  routing: AdaptiveRoutingArtifact | null | undefined,
  documentFormat: string,
  extra: { pageCount: number },
): Promise<PageInput[]> {
  const { capped } = routerTablePaths(pages, extra.pageCount, DEFAULT_PLANNER_CONFIG.needThreshold * PAGE_EVIDENCE.fullTableRuleScore);
  if (capped.size > 0) console.log(`[page-input] unknown-grid table paths capped=${capped.size} pages=${[...capped].slice(0, 50).join(",")}`);
  return Promise.all(pages.map((page) => pageInputFromEvidence(page, routing, documentFormat, { pageCount: extra.pageCount, tablePathCapped: capped.has(page.page) })));
}

/** A native probe row as the router's page input (through its page evidence). */
export async function pageInputFromProbeRow(
  row: ProbeRow,
  routing: AdaptiveRoutingArtifact | null | undefined,
  documentFormat = "pdf",
): Promise<PageInput> {
  return pageInputFromEvidence(pageEvidenceFromProbeRow(row), routing, documentFormat, { pageCount: row.pageCount, thumbnail: row.thumbnail });
}

export async function buildPageInputs(options: BuildPageInputsOptions): Promise<PageInput[]> {
  const probe = options.probe ?? createProbeRunner();
  const stdout = await probe({
    pdfPath: options.pdfPath,
    pages: options.pages,
    thumbDir: options.thumbDir,
    thumbPx: options.thumbPx,
    verifyOcrLayer: options.verifyOcrLayer ?? true,
    recognise: options.recognise,
    signal: options.signal,
  });
  const rows = parseProbeOutput(stdout);
  if (rows.length === 0) throw new Error("page probe produced no rows");
  return await Promise.all(rows.map((row) => pageInputFromProbeRow(row, options.routing, options.documentFormat)));
}
