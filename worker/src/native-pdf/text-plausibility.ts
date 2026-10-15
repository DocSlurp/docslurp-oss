import type { NativePdfScanStats } from "./types.js";

/**
 * Hidden-OCR-layer guard. A scan whose invisible OCR layer is garbage would otherwise pass that text through as if
 * it were the page. These checks use only free signals (the engine's glyph totals and the page's own text); no
 * dictionary, language model or document-specific knowledge.
 *
 * Calibrated on development + calibration pages only (eval-suite tier-4 scans, external dev corpus wild-v1 /
 * wild-v1-quirks / wild-v1-raster OCR-layer variants; internal research notes):
 * - implausible-token ratio: reliable OCR layers max 0.118, visible text layers max 0.094, letter-salad layers 0.41;
 * - capitalised share / punctuation per token: reliable pages min 0.047 / 0.033, word-salad layers 0 / 0.
 * The unmapped-glyph share is reported but not a verdict: the engine's glyph-mapping fallbacks recover most unmapped
 * text, so the output's own plausibility is the better judge.
 */
export const OCR_LAYER_MIN_SHARE = 0.5;
export const PLAUSIBILITY_MIN_TOKENS = 20;
export const IMPLAUSIBLE_TOKEN_MAX = 0.2;
export const FLAT_TEXT_MAX = 0.02;
export const OCR_LAYER_WARNING = "ocr-layer-unreliable";

/** Invisible text drawn over a page-sized image: the page's text is an OCR layer, not the document's own. */
export function isOcrLayer(stats: Pick<NativePdfScanStats, "glyphs" | "invisible" | "overImage">): boolean {
  if (stats.glyphs <= 0) return false;
  return stats.invisible / stats.glyphs >= OCR_LAYER_MIN_SHARE && stats.overImage / stats.glyphs >= OCR_LAYER_MIN_SHARE;
}

export interface TextPlausibility {
  /** Latin-script word tokens judged; below PLAUSIBILITY_MIN_TOKENS the text gets no verdict. */
  tokens: number;
  /** Share of 3+ character tokens that no alphabetic language writes: no vowel, 5+ consonants, case flips, letter/digit mixes. */
  implausibleTokens: number;
  capitalised: number;
  punctuationPerToken: number;
  unmapped: number;
  reasons: string[];
}

const LATIN_WORD = /^[A-Za-zÀ-ɏ]+$/;
const LATIN_ALNUM = /^[A-Za-zÀ-ɏ0-9]+$/;
const HAS_LETTER = /[A-Za-zÀ-ɏ]/;
const VOWELS = "aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœāăąēĕėęěīĭįıōŏőūŭůűų";
const VOWEL = new RegExp(`[${VOWELS}]`);
const CONSONANT_RUN = new RegExp(`[^${VOWELS}]{5,}`);
/** Ordinals, units and codes are normal letter/digit mixes: 2nd, 10kg, A4, ISO9001. */
const CODE_LIKE = /^\d+[a-z]{1,3}$|^[A-Za-z]{1,4}\d+$/;
const CASE_FLIP = /[a-zß-ÿ][A-ZÀ-Þ]/;

function implausible(token: string): boolean {
  if (/\d/.test(token)) return !CODE_LIKE.test(token);
  const lower = token.toLowerCase();
  if (!VOWEL.test(lower) || CONSONANT_RUN.test(lower)) return true;
  return token !== token.toUpperCase() && CASE_FLIP.test(token.slice(1));
}

/** Dictionary-free plausibility of a page's text. Scripts other than Latin get no verdict (too few tokens). */
export function assessTextPlausibility(markdown: string, stats?: Pick<NativePdfScanStats, "glyphs" | "unmapped">): TextPlausibility {
  const text = markdown.replace(/[#*_`|>[\]()!]/g, " ");
  const raw = text.split(/\s+/).filter(Boolean);
  const words = raw.map((token) => token.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, "")).filter(Boolean);
  const latin = words.filter((word) => LATIN_WORD.test(word));
  const judged = words.filter((word) => word.length >= 3 && LATIN_ALNUM.test(word) && HAS_LETTER.test(word));
  const implausibleTokens = judged.length > 0 ? judged.filter(implausible).length / judged.length : 0;
  const capitalised = latin.length > 0 ? latin.filter((word) => word[0] !== word[0]!.toLowerCase()).length / latin.length : 0;
  const punctuationPerToken = (text.match(/[.,;:?!]/g) ?? []).length / Math.max(1, raw.length);
  const unmapped = stats && stats.glyphs > 0 ? stats.unmapped / stats.glyphs : 0;
  const reasons: string[] = [];
  if (judged.length >= PLAUSIBILITY_MIN_TOKENS && implausibleTokens >= IMPLAUSIBLE_TOKEN_MAX) reasons.push("implausible-tokens");
  if (latin.length >= PLAUSIBILITY_MIN_TOKENS && capitalised < FLAT_TEXT_MAX && punctuationPerToken < FLAT_TEXT_MAX) reasons.push("flat-text");
  return { tokens: latin.length, implausibleTokens, capitalised, punctuationPerToken, unmapped, reasons };
}
