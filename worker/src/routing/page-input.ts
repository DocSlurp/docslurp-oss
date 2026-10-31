/**
 * Builds `PageInput[]` for the router from a PDF: runs the deterministic in-process native-pdf probe
 * (`worker/src/routing/probe/`; JSON lines: features, text facts, images, optional thumbnails) and merges the
 * classify-route heuristic (when available) into each page's `heuristic`.
 */

import sharp from "sharp";
import {
  PAGE_FEATURES_SCHEMA_VERSION,
  PAGE_INPUT_SCHEMA_VERSION,
  pageInputSchema,
  type AdaptiveRoutingArtifact,
  type PageInput,
  type TextLayerStatus,
} from "@docslurp/shared";

import { loadProbeBinding } from "./probe/binding.js";
import type { Recogniser } from "./probe/ocr-layer.js";
import { NativeProbeOpenError, PROBE_OVERLAP_MAX_PAGES, looksEncrypted, lockedRow, probeNativePdf } from "./probe/probe.js";

export interface ProbeRow {
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

const LOCKED_ROW_DEFAULTS = {
  pageNumber: 1, pageCount: 1, charCount: 0, wordCount: 0, textCoverage: 0, fontCount: 0, unmappedGlyphRatio: 0,
  mathGlyphRatio: 0, tableRuleScore: 0, imageCoverage: 0, largestImageCoverage: 0, fullPageImage: false,
  vectorDrawingCount: 0, uncoveredVectorRatio: 0, garbled: false, imageCount: 0, images: [] as ProbeRow["images"],
  smallestFontPt: null, widthPt: 612, heightPt: 792, rotation: 0, probeMs: 0,
};

export type ProbeRunner = (args: {
  pdfPath: string;
  pages?: string;
  thumbDir?: string;
  thumbPx?: number;
  /** Re-OCR a band of pages whose text lies over a page image and report how well the layer agrees (needs tesseract). */
  verifyOcrLayer?: boolean;
  /** Sandboxed OCR for the layer check (`sandboxedTesseract`); absent leaves OCR layers unverified. */
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

export async function pageInputFromProbeRow(
  row: ProbeRow,
  routing: AdaptiveRoutingArtifact | null | undefined,
  documentFormat = "pdf",
): Promise<PageInput> {
  if (row.locked) {
    // Locked document: the probe emits one row with no geometry; give it a valid page so the planner can report it.
    row = {
      ...LOCKED_ROW_DEFAULTS,
      ...row,
      pageNumber: 1,
      pageCount: 1,
      textLayerStatus: "unknown",
      textFacts: { wordCount: null, imageCount: null, imageCoverage: null, textLayerStatus: "unknown" },
    };
  }
  const entry = routing?.pages.find((page) => page.pageNumber === row.pageNumber);
  const input: PageInput = {
    schemaVersion: PAGE_INPUT_SCHEMA_VERSION,
    features: {
      schemaVersion: PAGE_FEATURES_SCHEMA_VERSION,
      pageNumber: row.pageNumber,
      documentFormat,
      pageCount: row.pageCount,
      native: {
        charCount: row.charCount,
        wordCount: row.wordCount,
        textCoverage: row.textCoverage,
        fontCount: row.fontCount,
        unmappedGlyphRatio: row.unmappedGlyphRatio,
        mathGlyphRatio: row.mathGlyphRatio,
        tableRuleScore: row.tableRuleScore,
        garbled: row.garbled,
        plausibility: nativePlausibility(row),
      },
      raster: {
        imageCoverage: row.imageCoverage,
        largestImageCoverage: row.largestImageCoverage,
        fullPageImage: row.fullPageImage,
        vectorDrawingCount: row.vectorDrawingCount,
        uncoveredVectorRatio: row.uncoveredVectorRatio,
        smallestFontPt: row.smallestFontPt,
      },
      geometry: { widthPt: row.widthPt, heightPt: row.heightPt, rotation: row.rotation },
      heuristic: {
        route: entry?.route ?? "straightforward-text",
        extractorHint: entry?.extractorHint ?? null,
        specializedKinds: entry?.specializedContent.map((s) => s.kind) ?? [],
        ocrAuthorized: entry?.ocrDecision?.authorized ?? null,
        textDensityScore: entry?.textDensityScore ?? row.textCoverage,
      },
      decisions: null,
      provenance: { probe: "native-pdf-probe", probeMs: row.probeMs },
    },
    textFacts: {
      wordCount: row.textFacts.wordCount,
      imageCount: row.textFacts.imageCount,
      imageCoverage: row.textFacts.imageCoverage,
      textLayerStatus: row.textFacts.textLayerStatus,
      ...(row.invisibleTextRatio !== undefined ? { invisibleTextRatio: row.invisibleTextRatio } : {}),
      ...(row.textOverImageRatio !== undefined ? { textOverImageRatio: row.textOverImageRatio } : {}),
      ...(row.ocrLayerCheck ? { ocrLayerAgreement: row.ocrLayerCheck.agreement, ocrLayerMs: row.ocrLayerCheck.wallMs } : {}),
    },
    ...(row.unusualFeatures && row.unusualFeatures.length > 0 ? { unusualFeatures: row.unusualFeatures } : {}),
    images: row.images.map((image, index) => ({
      index,
      bbox: {
        x: image.bbox[0],
        y: image.bbox[1],
        width: Math.max(0, image.bbox[2] - image.bbox[0]),
        height: Math.max(0, image.bbox[3] - image.bbox[1]),
      },
      coverage: image.coverage,
    })),
    thumbnail: await thumbnailInfo(row.thumbnail),
  };
  return pageInputSchema.parse(input);
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
