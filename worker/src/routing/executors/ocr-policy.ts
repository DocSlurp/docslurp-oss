/**
 * When page OCR may come from the native-pdf engine instead of tesseract, and the dropout guard every native OCR
 * output must pass.
 *
 * Measured on binding a88a052 (o1a2 smoke, 4 development pages): the engine's OCR matches tesseract on clean rasters
 * (1-CER 0.973 vs 0.959) and reads CJK that the image's tesseract languages cannot (0.740 vs 0.000), but it drops
 * most text on degraded scans (photocopy 0.023 vs 0.969, phone scan 0.156 vs 0.827), runs about 2x slower and adds
 * ~400 MB in-process RSS outside WORKER_COMMAND_MAX_RSS_MB. So tesseract is the primary page OCR; the engine serves
 * a page only when tesseract's output does not look like text in its languages and the engine's does (a script
 * tesseract lacks), or when NATIVE_PDF_OCR=prefer. Either way a native result that lost text is rejected.
 */

/** Tesseract output whose word-shaped token share is below this is treated as "script not installed" noise. */
export const TESSERACT_WORDLIKE_MIN = 0.5;
/** Native output counts as another script when at least this share of its letters is outside Latin. */
export const NATIVE_OTHER_SCRIPT_MIN = 0.3;
/** Dropout: output shorter than this share of the expected characters is rejected. */
export const OCR_DROPOUT_RATIO = 0.5;
/** Expected-character counts below this are too small to judge a dropout. */
export const OCR_DROPOUT_MIN_EXPECTED = 80;
/**
 * Output characters per square inch of page below which a native result needs a cross-check. A full Latin text
 * page runs ~20-40 chars/in2 (clean dev page: ~21; the collapsed photocopy ~1, phone scan ~4.5); CJK carries more
 * per character (~12 on the dev zh-TW page), so its floor is lower.
 */
export const OCR_DENSITY_FLOOR_LATIN = 8;
export const OCR_DENSITY_FLOOR_OTHER_SCRIPT = 4;

const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;

/** Share of letters outside the Latin script (0 when there are no letters). */
export function otherScriptShare(text: string): number {
  let letters = 0;
  let other = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    letters += 1;
    if (!LATIN.test(ch)) other += 1;
  }
  return letters === 0 ? 0 : other / letters;
}

/**
 * Share of alphabetic tokens (2+ letters) shaped like words: lower-case or capitalised Latin words. Tesseract run
 * with Latin languages on CJK, Arabic or Indic pages emits mostly upper-case letter runs and mixed symbol tokens.
 * Returns 1 when there are too few tokens to judge, so short pages never trigger the engine.
 */
export function wordLikeShare(text: string): number {
  const tokens = text.split(/\s+/).map((t) => t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")).filter((t) => t.length >= 2 && /^\p{L}+(['’-]\p{L}+)*$/u.test(t));
  if (tokens.length < 20) return 1;
  const wordLike = tokens.filter((t) => /^\p{Lu}?[\p{Ll}'’-]+$/u.test(t)).length;
  return wordLike / tokens.length;
}

export interface OcrDropoutInput {
  /** Characters of the native OCR output. */
  output: string;
  /** Characters of the page's existing text layer (a scan's hidden OCR layer), 0 when none. */
  layerChars: number;
  /** Page area in square inches, when known. */
  pageAreaIn2: number | null;
  /** Characters of a tesseract pass over the same page, when one ran. */
  crossCheckChars: number | null;
}

export type OcrDropoutVerdict =
  | { ok: true }
  | { ok: false; reason: "below-text-layer" | "below-cross-check" }
  | { ok: false; reason: "low-density"; needsCrossCheck: true };

const chars = (text: string) => text.replace(/\s+/g, "").length;

/**
 * Expected-vs-output check for native OCR. Expected characters come from the page's own text layer when it has
 * one, else from a tesseract cross-check, which is requested only when the output is sparse for the page area.
 */
export function nativeOcrDropout(input: OcrDropoutInput): OcrDropoutVerdict {
  const out = chars(input.output);
  if (input.layerChars >= OCR_DROPOUT_MIN_EXPECTED && out < OCR_DROPOUT_RATIO * input.layerChars) {
    return { ok: false, reason: "below-text-layer" };
  }
  if (input.crossCheckChars !== null && input.crossCheckChars >= OCR_DROPOUT_MIN_EXPECTED && out < OCR_DROPOUT_RATIO * input.crossCheckChars) {
    return { ok: false, reason: "below-cross-check" };
  }
  if (input.pageAreaIn2 && input.pageAreaIn2 > 0 && input.crossCheckChars === null) {
    const floor = otherScriptShare(input.output) >= NATIVE_OTHER_SCRIPT_MIN ? OCR_DENSITY_FLOOR_OTHER_SCRIPT : OCR_DENSITY_FLOOR_LATIN;
    if (out / input.pageAreaIn2 < floor) return { ok: false, reason: "low-density", needsCrossCheck: true };
  }
  return { ok: true };
}
