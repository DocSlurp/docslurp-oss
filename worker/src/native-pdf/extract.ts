import { assemblePageMarkdown, planSpanPass, type AssembledPage, type AssembleOptions } from "./assemble.js";
import { assessTextPlausibility, isOcrLayer, OCR_LAYER_WARNING } from "./text-plausibility.js";
import {
  NativePdfError,
  toNativePdfError,
  type NativePdfDocument,
  type NativePdfEngine,
  type NativePdfPage,
  type TableStrategy,
} from "./types.js";

/**
 * Invisible-text dropout guard (calibrated on the routing-suite dev scans with a good OCR layer:
 * output/text-layer ratio 0.99-1.01 on every real page). A page whose text layer holds at least
 * DROPOUT_MIN_EXPECTED_CHARS non-space characters but whose output keeps under DROPOUT_MIN_RATIO of
 * them lost its text (e.g. an invisible OCR layer the engine skipped); the document is rejected so
 * the next extractor (kreuzberg) serves it.
 */
export const DROPOUT_MIN_RATIO = 0.5;
export const DROPOUT_MIN_EXPECTED_CHARS = 80;
export const DROPOUT_WARNING = "native-pdf-dropout";
/** Glyph counts include inter-word spaces the output counts separately: ~85% are non-space characters. */
const GLYPH_NON_SPACE_SHARE = 0.85;

/** Non-space characters the page's own text layer holds, visible or not (0 when no signal is available). */
export function expectedTextChars(
  signals: { spans?: ReadonlyArray<{ text: string }>; glyphs?: number; hinted?: number },
): number {
  const fromSpans = signals.spans ? signals.spans.reduce((sum, span) => sum + span.text.replace(/\s/g, "").length, 0) : 0;
  const fromGlyphs = Math.floor((signals.glyphs ?? 0) * GLYPH_NON_SPACE_SHARE);
  return Math.max(fromSpans, fromGlyphs, signals.hinted ?? 0);
}

export function isTextDropout(engineChars: number, expectedChars: number): boolean {
  return expectedChars >= DROPOUT_MIN_EXPECTED_CHARS && engineChars / expectedChars < DROPOUT_MIN_RATIO;
}

export interface NativePdfExtractOptions extends AssembleOptions {
  signal?: AbortSignal;
  password?: string;
  tableStrategy?: TableStrategy;
  /** Pages processed at once; one document is used by one task at a time. */
  concurrency?: number;
  /** Fraction of pages that must carry text before the result counts as non-empty. */
  minTextPageRatio?: number;
  /**
   * Reject the document (callers fall back to another extractor) when a page
   * still has interleaved columns the local repair could not fix. Default true.
   */
  rerouteOnLayoutRisk?: boolean;
  /** Reject the document when a page lost most of its text layer (see isTextDropout). Default true. */
  rejectOnDropout?: boolean;
  /**
   * Drop a hidden OCR layer whose text fails the plausibility guard (text-plausibility.ts): the page is emitted like
   * a scan without a text layer (its image placeholder), so classify-route sends it to vision instead of the garbage
   * being indexed. The document is not rejected: the next extractor would read the same layer. Default true.
   */
  dropUnreliableOcrLayer?: boolean;
  /** Probe-reported non-space character count for a 1-based page, when known; raises the expected count. */
  expectedChars?: (pageNumber: number) => number | undefined;
}

export interface NativePdfPageResult {
  pageNumber: number;
  markdown: string;
  repairs: string[];
  warnings: string[];
  /** Non-space characters in the engine's own output, before image placeholders and repairs. */
  engineChars: number;
  /** Non-space characters in the page's text layer (invisible OCR text included), 0 when unknown. */
  expectedChars: number;
  ms: number;
}

export interface NativePdfExtraction {
  engine: string;
  pageCount: number;
  pages: NativePdfPageResult[];
  /** Per-page Markdown joined with form feeds, the extract stage's page separator. */
  markdown: string;
  totalMs: number;
  warnings: string[];
}

/** Optional side signals: one that fails or is unsupported only skips its repair, never the page's Markdown. */
async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

interface PageRead {
  assembled: AssembledPage;
  expectedChars: number;
}

/**
 * Signals through the engine's one-pass scan (runs, images, glyph totals) plus the cheap cached reads (words, links,
 * size); merged spans, a pass of their own, are read only when planSpanPass finds a repair they can change.
 */
async function readWithScan(page: NativePdfPage, pageNumber: number, markdown: string, options: NativePdfExtractOptions): Promise<PageRead | undefined> {
  const scan = page.scan ? await optional(() => page.scan!()) : undefined;
  if (!scan) return undefined;
  const [words, links, size] = await Promise.all([
    optional(() => page.words()),
    optional(() => page.links()),
    optional(() => page.size()),
  ]);
  const expectedChars = expectedTextChars({ spans: scan.runs, glyphs: scan.stats.mapped, hinted: options.expectedChars?.(pageNumber) });
  if (options.dropUnreliableOcrLayer !== false && isOcrLayer(scan.stats)) {
    const verdict = assessTextPlausibility(markdown, scan.stats);
    if (verdict.reasons.length > 0) {
      const assembled = assemblePageMarkdown({ pageNumber, markdown: "", images: scan.images, size }, { emphasis: options.emphasis });
      const detail = `${verdict.reasons.join("+")}:${verdict.implausibleTokens.toFixed(2)}`;
      return { assembled: { ...assembled, warnings: [`${OCR_LAYER_WARNING}:${detail}`, ...assembled.warnings] }, expectedChars };
    }
  }
  const signals = { markdown, runs: scan.runs, words, links, images: scan.images, size };
  const plan = planSpanPass(signals, { emphasis: options.emphasis });
  const spans = plan.reasons.length > 0 ? await optional(() => page.spans()) : undefined;
  const assembled = assemblePageMarkdown(
    { ...signals, pageNumber, spans, unmappedGlyphs: scan.stats.unmapped, columns: spans ? undefined : plan.columns },
    { emphasis: options.emphasis },
  );
  return { assembled, expectedChars };
}

/** Engines without scan(): every side signal as its own call. */
async function readEachSignal(page: NativePdfPage, pageNumber: number, markdown: string, options: NativePdfExtractOptions): Promise<PageRead> {
  const [spans, words, links, images, size, glyphs] = await Promise.all([
    optional(() => page.spans()),
    optional(() => page.words()),
    optional(() => page.links()),
    optional(() => page.images()),
    optional(() => page.size()),
    optional(() => page.glyphStats()),
  ]);
  const assembled = assemblePageMarkdown(
    { pageNumber, markdown, spans, words, links, images, size, unmappedGlyphs: glyphs?.unmapped },
    { emphasis: options.emphasis },
  );
  const expectedChars = expectedTextChars({ spans, glyphs: glyphs?.glyphs, hinted: options.expectedChars?.(pageNumber) });
  return { assembled, expectedChars };
}

async function extractPage(page: NativePdfPage, pageNumber: number, options: NativePdfExtractOptions): Promise<NativePdfPageResult> {
  const started = performance.now();
  let markdown: string;
  try {
    markdown = await page.markdown({ tableStrategy: options.tableStrategy ?? "lines" });
  } catch (error) {
    // Markdown unsupported or failed for this page: plain text keeps the page non-empty.
    const text = await optional(() => page.text());
    if (text === undefined) throw toNativePdfError(error);
    markdown = text;
  }
  const { assembled, expectedChars } = (await readWithScan(page, pageNumber, markdown, options))
    ?? (await readEachSignal(page, pageNumber, markdown, options));
  const engineChars = markdown.replace(/\s/g, "").length;
  const warnings = isTextDropout(engineChars, expectedChars)
    ? [...assembled.warnings, `${DROPOUT_WARNING}:${engineChars}/${expectedChars}`]
    : assembled.warnings;
  return {
    pageNumber,
    markdown: assembled.markdown,
    repairs: assembled.repairs,
    warnings,
    engineChars,
    expectedChars,
    ms: performance.now() - started,
  };
}

/** Extract every page of an open document; page order is preserved. */
export async function extractNativePdfDocument(
  doc: NativePdfDocument,
  engineId: string,
  options: NativePdfExtractOptions = {},
): Promise<NativePdfExtraction> {
  const started = performance.now();
  const pageCount = await doc.pageCount();
  const pages = new Array<NativePdfPageResult>(pageCount);
  const width = Math.max(1, Math.min(options.concurrency ?? 4, pageCount));
  let next = 0;
  const worker = async () => {
    while (next < pageCount) {
      if (options.signal?.aborted) throw new NativePdfError("NATIVE_PDF_FAILED", "aborted");
      const index = next;
      next += 1;
      pages[index] = await extractPage(doc.page(index), index + 1, options);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));

  // Placeholders alone do not make a page non-empty: scans must fall back.
  const populated = pages.filter((page) => page.engineChars > 0).length;
  const ratio = options.minTextPageRatio ?? 0.2;
  if (pageCount === 0 || populated / pageCount < ratio) {
    throw new NativePdfError("NATIVE_PDF_EMPTY", `native-pdf produced text on ${populated}/${pageCount} pages`);
  }
  if (options.rejectOnDropout !== false) {
    const dropped = pages.filter((page) => page.warnings.some((w) => w.startsWith(`${DROPOUT_WARNING}:`)));
    if (dropped.length > 0) {
      const detail = dropped.map((p) => `${p.pageNumber}(${p.engineChars}/${p.expectedChars})`).join(",");
      throw new NativePdfError("NATIVE_PDF_DROPOUT", `${DROPOUT_WARNING}: text layer not extracted on pages ${detail}`);
    }
  }
  if (options.rerouteOnLayoutRisk !== false) {
    const risky = pages.filter((page) => page.warnings.includes("multi-column-interleave"));
    if (risky.length > 0) {
      throw new NativePdfError("NATIVE_PDF_LAYOUT", `unrepaired multi-column interleave on pages ${risky.map((p) => p.pageNumber).join(",")}`);
    }
  }
  const warnings = [...new Set(pages.flatMap((page) => page.warnings.map((w) => w.split(":")[0]!)))];
  return {
    engine: engineId,
    pageCount,
    pages,
    markdown: pages.map((page) => page.markdown).join("\f"),
    totalMs: performance.now() - started,
    warnings,
  };
}

export async function extractNativePdf(
  engine: NativePdfEngine,
  filePath: string,
  options: NativePdfExtractOptions = {},
): Promise<NativePdfExtraction> {
  const doc = await engine.openPath(filePath, { password: options.password, signal: options.signal });
  try {
    return await extractNativePdfDocument(doc, engine.id, options);
  } finally {
    await doc.close().catch(() => undefined);
  }
}
