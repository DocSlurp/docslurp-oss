/**
 * Pure helpers of the page probe, ported 1:1 from worker/scripts/page_probe.py (thresholds included) so the
 * TypeScript probe and the Python probe stay interchangeable. No document-specific knowledge.
 */

export const GRID = 4; // coverage masks are computed on a 4 pt grid
export const PROBE_DPI = 72;

const MATH_RANGES: Array<[number, number]> = [
  [0x2200, 0x22ff], [0x2a00, 0x2aff], [0x27c0, 0x27ef], [0x2980, 0x29ff], [0x2070, 0x209f],
  [0x0391, 0x03c9], [0x1d400, 0x1d7ff], [0x2140, 0x214f],
];
const MATH_SINGLE = new Set([..."±×÷∑∏√∞≈≠≤≥∂∇∫"]);

export function isMath(cp: number, ch: string): boolean {
  return MATH_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) || MATH_SINGLE.has(ch);
}

export function isUnmapped(cp: number): boolean {
  return cp === 0xfffd || cp === 0 || (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0x10ffff);
}

/** Python `str.isprintable` for a non-space character. */
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;
export function isPrintable(ch: string): boolean {
  return !NON_PRINTABLE.test(ch);
}

/** Boolean coverage grid over the page box (union-area arithmetic). */
export class Mask {
  readonly w: number;
  readonly h: number;
  readonly a: Uint8Array;
  constructor(width: number, height: number) {
    this.w = Math.max(1, Math.ceil(width / GRID));
    this.h = Math.max(1, Math.ceil(height / GRID));
    this.a = new Uint8Array(this.w * this.h);
  }
  add(x0: number, y0: number, x1: number, y1: number): void {
    const i0 = Math.max(0, Math.floor(x0 / GRID));
    const i1 = Math.min(this.w, Math.ceil(x1 / GRID));
    const j0 = Math.max(0, Math.floor(y0 / GRID));
    const j1 = Math.min(this.h, Math.ceil(y1 / GRID));
    if (i1 <= i0 || j1 <= j0) return;
    for (let j = j0; j < j1; j++) this.a.fill(1, j * this.w + i0, j * this.w + i1);
  }
  ratio(): number {
    let n = 0;
    for (const v of this.a) n += v;
    return n / this.a.length;
  }
}

export function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  if (height < 3 || width < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = gray[i - width]! + gray[i + width]! + gray[i - 1]! + gray[i + 1]! - 4 * gray[i]!;
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** numpy.percentile (linear) of a uint8 image through its histogram. */
export function percentiles(gray: Uint8Array, qs: number[]): number[] {
  const hist = new Uint32Array(256);
  for (const v of gray) hist[v]!++;
  const at = (rank: number): number => {
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += hist[v]!;
      if (rank < seen) return v;
    }
    return 255;
  };
  return qs.map((q) => {
    const pos = ((gray.length - 1) * q) / 100;
    const lo = Math.floor(pos);
    const frac = pos - lo;
    const a = at(lo);
    return frac === 0 ? a : a + (at(Math.min(lo + 1, gray.length - 1)) - a) * frac;
  });
}

export type TextLayerStatusValue = "ok" | "suspect" | "absent" | "unknown" | "ocr-layer";

/** ok | suspect | absent | unknown, from free facts only. */
export function textLayerStatus(
  chars: number, words: number, unmappedRatio: number, garbled: boolean, imageCoverage: number,
): Exclude<TextLayerStatusValue, "ocr-layer"> {
  if (chars === 0) return imageCoverage >= 0.3 ? "unknown" : "absent";
  if (garbled || unmappedRatio > 0.03) return "suspect";
  if (words < 20 && imageCoverage >= 0.3) return "suspect";
  return "ok";
}

export const OCR_FONT_RE = /glyphless|invisible|\bocr|hocr|tesseract/i;
export const OCR_PRODUCER_RE =
  /tesseract|ocrmypdf|ocr|abbyy|finereader|paddle|textract|readiris|omnipage|paper ?capture|document ?ai/i;
export const IMAGE_HOST_COVERAGE = 0.25;
export const OCR_LAYER_OVER_IMAGE = 0.5;

const COMMON = new Set(
  ("the of and to in is that it for as with was on be by this are at from or an have not but they which you " +
    "were all can her has there their will would one more when who what been if its than about into over also " +
    "may other some these our out up so them we such only any new no time then could those use two how most " +
    "after first said many each between both under while where should because through during before").split(" "),
);

export function commonWordRatio(text: string): number {
  const toks = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (toks.length === 0) return 0;
  return round(toks.filter((t) => COMMON.has(t)).length / toks.length, 4);
}

export function tokens(s: string, minLen = 2): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= minLen);
}

export function isOcrLayer(textOverImageRatio: number, words: number): boolean {
  return words >= 3 && textOverImageRatio >= OCR_LAYER_OVER_IMAGE;
}

export function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Parse "1,2,5-7" (1-based) into valid page numbers. */
export function parsePages(spec: string | undefined, count: number): number[] {
  if (!spec) return Array.from({ length: count }, (_, i) => i + 1);
  const out: number[] = [];
  for (const raw of spec.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    if (part.includes("-")) {
      const [a, b] = part.split("-", 2) as [string, string];
      for (let p = Number(a); p <= Number(b); p++) out.push(p);
    } else out.push(Number(part));
  }
  return out.filter((p) => Number.isInteger(p) && p >= 1 && p <= count);
}
