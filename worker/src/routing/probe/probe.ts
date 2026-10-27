/**
 * Native in-process page probe: deterministic per-page PDF features for the page router, computed through the
 * native-pdf binding (no Python). Field names, thresholds and semantics match worker/scripts/page_probe.py so rows
 * map 1:1 onto `ProbeRow`; the parity harness (probe-parity.ts) measures the differences.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import type { ProbeRow } from "../page-input.js";
import { NATIVE_PDF_OPEN_LIMITS } from "../../native-pdf/binding-engine.js";
import type { ProbeBinding, ProbeBindingDoc, ProbeBindingPage } from "./binding.js";
import {
  IMAGE_HOST_COVERAGE, Mask, OCR_FONT_RE, OCR_PRODUCER_RE, PROBE_DPI, commonWordRatio, isMath, isOcrLayer,
  isPrintable, isUnmapped, laplacianVariance, parsePages, percentiles, round, textLayerStatus,
} from "./features.js";
import { OCR_AGREEMENT_MIN, ocrLayerAgreement, type OcrLayerCheck, type Recogniser } from "./ocr-layer.js";
import { ATTENTION_FEATURES, documentFeatures, pageUnusualFeatures } from "./unusual.js";

export interface NativeProbeRow extends ProbeRow {
  commonWordRatio: number;
  controlCharRatio: number;
  ocrEngineHint: boolean;
  blur: number;
  contrast: number;
  brightness: number;
  largestImageDpi: number | null;
  /** Engine that produced the row, e.g. `native-pdf@0.13.0+5a88c4a`. */
  probeEngine?: string;
}

export interface NativeProbeOptions {
  pdfPath: string;
  /** 1-based page spec, e.g. "1,2,5-7". */
  pages?: string;
  thumbDir?: string;
  thumbPx?: number;
  verifyOcrLayer?: boolean;
  signal?: AbortSignal;
  /** OCR for the layer check; must run sandboxed (`sandboxedTesseract`). Absent: the layer stays unverified. */
  recognise?: Recogniser;
}

/** Without a sandboxed recogniser the OCR layer stays unverified, as when tesseract is not installed. */
const noRecogniser: Recogniser = async () => null;

/** The document could not be opened by the binding (damaged, unsupported encryption); callers may fall back. */
export class NativeProbeOpenError extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NativeProbeOpenError";
  }
}

/**
 * Resource limits for probing: the same server-ingestion profile the extractor uses, so a document the probe
 * accepts is one the extractor can open. The upstream re-read PDF_LIMIT bug is fixed in the pinned binding.
 */
export const PROBE_LIMITS = NATIVE_PDF_OPEN_LIMITS;

/** The original Python probe's span boxes span the font's ascent-to-descent line box; glyph-tight boxes are shorter, so pad them to match. */
const LINE_BOX_PAD = 0.1;

function addPadded(mask: Mask, [x0, y0, x1, y1]: [number, number, number, number]): void {
  const pad = (y1 - y0) * LINE_BOX_PAD;
  mask.add(x0, y0 - pad, x1, y1 + pad);
}

const DRAWING_COMMAND_CAP = 131_072;

type LiveSpan = { x0: number; y0: number; x1: number; y1: number; chars: string[]; vertical: boolean };

function wordSpans(words: Array<{ text: string; bbox: [number, number, number, number] }>): LiveSpan[] {
  return words
    .filter((w) => w.text.trim())
    .map((w) => {
      const [x0, y0, x1, y1] = w.bbox;
      const chars = Array.from(w.text);
      return { x0, y0, x1, y1, chars, vertical: chars.length >= 2 && y1 - y0 > VERTICAL_ASPECT * (x1 - x0) };
    });
}

const VERTICAL_ASPECT = 2; // a multi-character span taller than 2x its width is vertical text

interface TextFacts {
  chars: number;
  words: number;
  fontNames: Set<string>;
  smallest: number | null;
  mathChars: number;
  unmappedChars: number;
  printable: number;
  verticalChars: number;
  controlChars: number;
  text: string;
  /** Per-character positions for host-image overlap: [cx, cy]. */
}

function pythonSplitWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Python's score is min(horizontal rules, vertical rules). The binding only reports their sum (`longRuleCount`), so
 * without separate counts the rules are tied to a grid through the lines-strategy table finder (run only when the page
 * has at least two long rules): a ruled grid of r rows and c columns has min(r, c) + 1 rules in its thinner direction.
 */
function tableRuleScore(page: ProbeBindingPage, dr: ReturnType<ProbeBindingPage["drawings"]>): number {
  if (dr.hRuleCount !== undefined && dr.vRuleCount !== undefined) return Math.min(dr.hRuleCount, dr.vRuleCount);
  if (dr.longRuleCount < 2 || !page.tables) return 0;
  let best = 0;
  for (const table of page.tables({ strategy: "lines" })) best = Math.max(best, Math.min(table.rowCount, table.colCount) + 1);
  // Rules the table finder did not tie to a grid still count once, so "has rules" (>= 1) keeps its recall.
  return best > 0 ? Math.min(best, Math.floor(dr.longRuleCount / 2) + 1) : 1;
}

export async function probePage(
  doc: ProbeBindingDoc,
  pageIndex: number,
  pageCount: number,
  docFeatures: Set<string>,
  producer: string,
  options: Pick<NativeProbeOptions, "thumbDir" | "thumbPx"> & { stem?: string } = {},
): Promise<{ row: NativeProbeRow; page: ProbeBindingPage; size: { widthPt: number; heightPt: number; rotation: number } }> {
  const t0 = performance.now();
  const page = doc.page(pageIndex);
  const size = page.size();
  const pw = size.widthPt;
  const ph = size.heightPt;
  const area = Math.max(pw * ph, 1e-6);
  const textMask = new Mask(pw, ph);
  const imgMask = new Mask(pw, ph);

  // ---- text layer ----
  const spans = page.spans();
  const stats = page.glyphStats();
  const t: TextFacts = {
    chars: 0, words: 0, fontNames: new Set(), smallest: null, mathChars: 0, unmappedChars: 0, printable: 0,
    verticalChars: 0, controlChars: 0, text: "",
  };
  const parts: string[] = [];
  // Text coverage and image overlap use word boxes when the binding has them (spans merge columns on a shared baseline).
  const boxes = page.words ? page.words() : null;
  if (boxes) for (const w of boxes) if (w.text.trim()) addPadded(textMask, w.bbox);
  const liveSpans: LiveSpan[] = [];
  for (const span of spans) {
    const txt = span.text;
    if (!txt.trim()) continue;
    const [x0, y0, x1, y1] = span.bbox;
    if (!boxes) textMask.add(x0, y0, x1, y1);
    parts.push(txt);
    t.fontNames.add(span.font);
    if (span.size > 0 && (t.smallest === null || span.size < t.smallest)) t.smallest = span.size;
    const all = Array.from(txt);
    const vertical = all.length >= 2 && y1 - y0 > VERTICAL_ASPECT * (x1 - x0);
    liveSpans.push({ x0, y0, x1, y1, chars: all, vertical });
    for (const ch of all) {
      if (/\s/u.test(ch)) continue;
      t.chars++;
      if (vertical) t.verticalChars++;
      const cp = ch.codePointAt(0)!;
      if (isUnmapped(cp)) t.unmappedChars++;
      else if (isMath(cp, ch)) t.mathChars++;
      if (isPrintable(ch)) t.printable++;
    }
    t.words += pythonSplitWords(txt);
  }
  // The native engine leaves glyphs without a Unicode mapping out of the text; its glyph stats count them.
  // The original Python probe kept them as U+FFFD/PUA characters, so they count as (unmapped) characters here too.
  const hiddenUnmapped = Math.max(0, stats.unmapped - t.unmappedChars);
  t.chars += hiddenUnmapped;
  t.unmappedChars += hiddenUnmapped;
  const chars = t.chars;
  const unmappedRatio = chars ? t.unmappedChars / chars : 0;
  const mathRatio = chars ? t.mathChars / chars : 0;
  const garbled = chars >= 20 && (unmappedRatio > 0.1 || t.printable / chars < 0.6);

  // ---- images ----
  let largest = 0;
  let bestDpi: number | null = null;
  let bestArea = 0;
  const images: NativeProbeRow["images"] = [];
  for (const info of page.images()) {
    const [x0, y0, x1, y1] = info.bbox;
    const bw = Math.max(x1 - x0, 0);
    const bh = Math.max(y1 - y0, 0);
    imgMask.add(x0, y0, x1, y1);
    const a = bw * bh;
    const cov = Math.min(a / area, 1);
    images.push({ bbox: [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)], coverage: round(cov, 5) });
    if (cov > largest) largest = cov;
    if (a > bestArea && bw > 0) {
      bestArea = a;
      bestDpi = info.widthPx / (bw / 72);
    }
  }
  const imageCoverage = imgMask.ratio();
  const fullPage = largest >= 0.85;

  // ---- vector drawings ----
  let dr: ReturnType<ProbeBindingPage["drawings"]>;
  let drawingLimit = false;
  try {
    dr = page.drawings();
  } catch (error) {
    // Pathological vector pages exceed the binding's drawing command cap: keep the page, mark the signal as saturated.
    drawingLimit = true;
    dr = { lineCount: 0, rectCount: 0, longRuleCount: 0, pathCount: DRAWING_COMMAND_CAP, vectorArea: area * 0.5 };
  }
  const vecCount = dr.pathCount ?? dr.lineCount + dr.rectCount;
  const tableRule = tableRuleScore(page, dr);
  // The binding reports union vector area, not where it is: assume it is independent of text/image coverage.
  let covered = 0;
  for (let i = 0; i < textMask.a.length; i++) if (textMask.a[i]! | (imgMask.a[i] ?? 0)) covered++;
  const uncovered = Math.min(dr.vectorArea / area, 1) * (1 - covered / textMask.a.length);

  // ---- 72 DPI grayscale render ----
  const png = await page.renderAsync({ dpi: PROBE_DPI, gray: true, format: "png" });
  const raw = await sharp(png).toColourspace("b-w").raw().toBuffer({ resolveWithObject: true });
  const gray = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.info.width * raw.info.height * raw.info.channels);
  const px = raw.info.channels === 1 ? gray : gray.filter((_, i) => i % raw.info.channels === 0);
  const blur = laplacianVariance(px, raw.info.width, raw.info.height);
  const [p1, p99] = percentiles(px, [1, 99]) as [number, number];
  const contrast = (p99 - p1) / 255;
  let sum = 0;
  for (const v of px) sum += v;
  const brightness = px.length ? sum / px.length / 255 : 0;

  // ---- hidden / OCR text-layer signals ----
  images.sort((a, b) => b.coverage - a.coverage);
  const hosts = images.filter((im) => im.coverage >= IMAGE_HOST_COVERAGE).map((im) => im.bbox);
  let total = 0;
  let overHost = 0;
  let ctrl = 0;
  if (chars) {
    for (const s of boxes ? wordSpans(boxes) : liveSpans) {
      const n = s.chars.length;
      total += n;
      for (let k = 0; k < n; k++) {
        const cp = s.chars[k]!.codePointAt(0)!;
        if (cp < 32 && cp !== 9 && cp !== 10 && cp !== 13) ctrl++;
        const f = (k + 0.5) / n;
        const cx = s.vertical ? (s.x0 + s.x1) / 2 : s.x0 + (s.x1 - s.x0) * f;
        const cy = s.vertical ? s.y0 + (s.y1 - s.y0) * f : (s.y0 + s.y1) / 2;
        if (hosts.some(([hx0, hy0, hx1, hy1]) => hx0 <= cx && cx <= hx1 && hy0 <= cy && cy <= hy1)) overHost++;
      }
    }
  }
  const ocrFont = [...t.fontNames].some((f) => OCR_FONT_RE.test(f));
  const sig = chars
    ? {
        invisibleTextRatio: stats.glyphs ? round(stats.invisible / stats.glyphs, 4) : 0,
        textOverImageRatio: total ? round(overHost / total, 4) : 0,
        controlCharRatio: total ? round(ctrl / total, 4) : 0,
        ocrEngineHint: ocrFont || OCR_PRODUCER_RE.test(producer),
      }
    : { invisibleTextRatio: 0, textOverImageRatio: 0, controlCharRatio: 0, ocrEngineHint: false };
  const common = commonWordRatio(parts.join(" "));
  let status: string = textLayerStatus(chars, t.words, unmappedRatio, garbled, imageCoverage);
  if ((status === "ok" || status === "suspect") && isOcrLayer(sig.textOverImageRatio, t.words)) status = "ocr-layer";
  const imageCount = images.length;
  const pno = pageIndex + 1;
  let factsLine =
    `P${String(pno).padStart(2, "0")}: ${t.words} words, ${imageCount} image${imageCount !== 1 ? "s" : ""}` +
    (imageCount ? ` covering ${Math.round(imageCoverage * 100)}%` : "") +
    (status === "ok" ? ", text layer ok" : status === "ocr-layer" ? ", text layer lies over a page image (OCR layer, unverified)" : `, text layer ${status}`);

  const unusual = new Set(docFeatures);
  for (const f of pageUnusualFeatures(doc, page, pageIndex, size, chars ? t.verticalChars / chars : 0, unmappedRatio)) unusual.add(f);
  if (drawingLimit) unusual.add("drawing-limit");
  if (pageCount >= 100 && t.words < 5 && chars < 40) unusual.add("sparse-multipage");
  // unmapped-glyph fonts decode to printable-looking garbage: flag the layer, do not trust it
  if (unusual.has("no-tounicode") && status === "ok") {
    status = "suspect";
    factsLine = factsLine.replace("text layer ok", "text layer suspect");
  }
  const probeMs = performance.now() - t0;

  const row: NativeProbeRow = {
    pageNumber: pno,
    pageCount,
    charCount: chars,
    wordCount: t.words,
    textCoverage: round(textMask.ratio(), 5),
    fontCount: t.fontNames.size,
    unmappedGlyphRatio: round(unmappedRatio, 5),
    mathGlyphRatio: round(mathRatio, 5),
    tableRuleScore: tableRule,
    imageCoverage: round(imageCoverage, 5),
    largestImageCoverage: round(largest, 5),
    fullPageImage: fullPage,
    largestImageDpi: bestDpi === null ? null : round(bestDpi, 1),
    vectorDrawingCount: vecCount,
    uncoveredVectorRatio: round(uncovered, 5),
    garbled,
    blur: round(blur, 3),
    contrast: round(contrast, 4),
    brightness: round(brightness, 4),
    textLayerStatus: status as ProbeRow["textLayerStatus"],
    ...sig,
    commonWordRatio: common,
    imageCount,
    textFacts: { wordCount: t.words, imageCount, imageCoverage: round(imageCoverage, 5), textLayerStatus: status as ProbeRow["textLayerStatus"], line: factsLine } as ProbeRow["textFacts"],
    images: images.slice(0, 32),
    smallestFontPt: t.smallest === null ? null : round(t.smallest, 2),
    widthPt: round(pw, 2),
    heightPt: round(ph, 2),
    rotation: size.rotation,
    unusualFeatures: [...unusual].sort(),
    needsAttention: [...unusual].some((f) => ATTENTION_FEATURES.has(f)),
    probeMs: round(probeMs, 2),
  };
  if (options.thumbDir) {
    const long = options.thumbPx ?? 384;
    const file = path.join(options.thumbDir, `${options.stem ?? "page"}-p${String(pno).padStart(4, "0")}.png`);
    await mkdir(options.thumbDir, { recursive: true });
    await writeFile(file, await page.renderAsync({ maxEdgePx: long, format: "png" }));
    row.thumbnail = file;
  }
  return { row, page, size };
}

/** Fold an OCR-layer check into the row: agreeing layers become "ok", disagreeing ones "suspect". */
export function applyOcrCheck(row: NativeProbeRow, check: OcrLayerCheck): void {
  row.ocrLayerCheck = check;
  if (check.agreement === null) return;
  const status = check.agreement >= OCR_AGREEMENT_MIN ? "ok" : "suspect";
  const old = (row.textFacts as { line?: string }).line!.split(", text layer").slice(0, -1).join(", text layer");
  const note = status === "ok" ? "ok (OCR layer matches the page image)" : "suspect (OCR layer disagrees with the page image)";
  row.textLayerStatus = row.textFacts.textLayerStatus = status;
  (row.textFacts as { line?: string }).line = `${old}, text layer ${note}`;
}

export function lockedRow(): NativeProbeRow {
  return {
    pageNumber: 0, pageCount: 0, locked: true, textLayerStatus: "unknown", unusualFeatures: ["encrypted-user-password"], needsAttention: true,
    textFacts: { textLayerStatus: "unknown", line: "document locked (user password required)" },
  } as unknown as NativeProbeRow;
}

function failedRow(pageNumber: number, pageCount: number, error: unknown): NativeProbeRow {
  return {
    pageNumber, pageCount, charCount: 0, wordCount: 0, textCoverage: 0, fontCount: 0, unmappedGlyphRatio: 0, mathGlyphRatio: 0,
    tableRuleScore: 0, imageCoverage: 0, largestImageCoverage: 0, fullPageImage: false, largestImageDpi: null, vectorDrawingCount: 0,
    uncoveredVectorRatio: 0, garbled: false, blur: 0, contrast: 0, brightness: 0, textLayerStatus: "unknown", commonWordRatio: 0,
    controlCharRatio: 0, ocrEngineHint: false, imageCount: 0, images: [], smallestFontPt: null, widthPt: 612, heightPt: 792, rotation: 0,
    unusualFeatures: ["probe-error"], needsAttention: true, probeMs: 0,
    textFacts: { wordCount: null, imageCount: null, imageCoverage: null, textLayerStatus: "unknown", line: `P${pageNumber}: probe failed (${error instanceof Error ? error.message : String(error)})` },
  } as unknown as NativeProbeRow;
}

export async function* probeNativePdf(binding: ProbeBinding, options: NativeProbeOptions): AsyncGenerator<NativeProbeRow> {
  const info = binding.version();
  const engine = `native-pdf@${info.version}+${info.gitSha.slice(0, 7)}`;
  let doc: ProbeBindingDoc;
  try {
    doc = binding.openPath(options.pdfPath, { limits: PROBE_LIMITS });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "PDF_ERROR";
    if (code === "PDF_LOCKED") {
      yield lockedRow();
      return;
    }
    throw new NativeProbeOpenError(code, error instanceof Error ? error.message : String(error), { cause: error });
  }
  try {
    const stem = path.basename(options.pdfPath, path.extname(options.pdfPath));
    const meta = doc.metadata();
    const producer = `${meta.producer ?? ""} ${meta.creator ?? ""}`;
    const count = doc.pageCount();
    const docFeatures = documentFeatures(doc, meta.encrypted);
    for (const pno of parsePages(options.pages, count)) {
      options.signal?.throwIfAborted();
      await new Promise<void>((resolve) => setImmediate(resolve));
      let row: NativeProbeRow;
      try {
        const probed = await probePage(doc, pno - 1, count, docFeatures, producer, { thumbDir: options.thumbDir, thumbPx: options.thumbPx, stem });
        row = probed.row;
        if (options.verifyOcrLayer && row.textLayerStatus === "ocr-layer") {
          applyOcrCheck(row, await ocrLayerAgreement(probed.page, probed.size, options.recognise ?? noRecogniser, options.signal));
        }
      } catch (error) {
        if ((error as { name?: string } | null)?.name === "AbortError") throw error;
        row = failedRow(pno, count, error);
      }
      row.probeEngine = engine;
      yield row;
    }
  } finally {
    doc.close();
  }
}

/** True when the file declares a standard /Encrypt dictionary (cheap head/tail scan; no parsing). */
export async function looksEncrypted(pdfPath: string): Promise<boolean> {
  const { open } = await import("node:fs/promises");
  const handle = await open(pdfPath, "r");
  try {
    const { size } = await handle.stat();
    for (const [start, length] of [[Math.max(0, size - 262_144), Math.min(size, 262_144)], [0, Math.min(size, 65_536)]] as const) {
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      if (buf.includes("/Encrypt")) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}
