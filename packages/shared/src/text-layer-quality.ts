/*
 * Is a PDF page's text layer readable? Pure functions over the extracted text of one page; no model, no
 * rendering, no word lists. Design, sources and calibration: docs/page-text-layer-quality.md.
 *
 * Two kinds of evidence, kept apart:
 *
 * - `garbled`: the layer carries marks of a failed glyph-to-Unicode mapping (replacement characters, private-use
 *   glyphs, `(cid:N)` runs, control characters), or is symbol soup or letters far outside the script's pairs. These
 *   cannot be produced by language, so the page's text is unreadable and only a read of the page image recovers it.
 * - `suspect`: patterns that usually mean a broken layer but that real text, data and other languages can produce
 *   too: a decoding mistake's signature (UTF-8 read as Latin-1 or Windows-1251), a glyph-code shift (long case-mixed
 *   alphanumeric runs with a language's letter frequencies), letters that do not behave like words of their script
 *   (letter pairs unlike the script's words, words mixing scripts). A consistent glyph substitution (a font whose
 *   code points were assigned in order of first use) looks like this and is invisible to the marker checks. A
 *   suspect page is cross-checked against an OCR of its render (`tokenAgreement`) before anything is paid for.
 *
 * Nothing here looks at ASCII: letters, marks and symbols are Unicode properties, so Cyrillic, Greek, Arabic, CJK,
 * math and source code are judged by the same rules as Latin prose.
 */

import { LETTER_BIGRAMS } from "./text-layer-bigrams.js";

export type TextLayerVerdict = "empty" | "ok" | "suspect" | "garbled";

export interface TextLayerAssessment {
  verdict: TextLayerVerdict;
  /** Share of the layer's non-space characters carried by the strongest garbled signal (0..1). */
  garbleRatio: number;
  /** Letters (any script) in the layer. */
  letters: number;
  /** Stable machine-readable causes, e.g. `unmapped-glyphs`, `mojibake`, `glyph-shift`, `implausible-words`. */
  reasons: string[];
}

/** Thresholds, chosen on the calibration in docs/page-text-layer-quality.md; they do not depend on any document. */
export const TEXT_LAYER_QUALITY = {
  /** Unmapped glyph marks over non-space characters: suspect at, garbled at. */
  unmappedSuspect: 0.02,
  unmappedGarbled: 0.1,
  /** Mojibake-signature characters over non-space characters. Never `garbled` on its own: see the module note. */
  mojibakeSuspect: 0.004,
  /** Consecutive lead+continuation pairs of Windows-1251 mojibake; Ukrainian or Serbian words reach one or two. */
  cp1251MojibakeMinPairs: 3,
  /** Alphanumeric-only runs of this many characters are "long tokens" (words never reach it; hashes and keys do). */
  longTokenChars: 20,
  /** Share of a page's non-space characters inside long, mixed-case, wide-alphabet tokens, and the least tokens. */
  longTokenGarbled: 0.25,
  longTokenMinTokens: 4,
  /**
   * A glyph-code shift keeps the language's letter frequencies: the index of coincidence of the long tokens' characters
   * is 0.06 and above for shifted English; base64, keys, hashes and serials are near-uniform (0.016 to 0.034).
   */
  longTokenMinCoincidence: 0.05,
  /** Shifted prose holds few digits (they come from rare capitals); identifiers and part numbers are digit-heavy. */
  longTokenMaxDigitShare: 0.3,
  /**
   * Mean natural-log probability per letter pair of a page's words under the script's pooled letter-bigram table
   * (text-layer-bigrams.ts). Held-out natural pages score -5.0 to -7.0; Caesar and substitution ciphers of the same
   * pages score -7.1 to -10.4. Below `plausibleLetterPairs` the page is suspect, below `implausibleLetterPairs`
   * garbled (as long as it has `minWordsForLanguageModel` words).
   */
  plausibleLetterPairs: -6.85,
  implausibleLetterPairs: -8.2,
  minWordsForLanguageModel: 30,
  minWordsForGarbledLanguageModel: 60,
  /** The script's letters must be this share of the page's letters (a Latin unit in Korean text proves nothing). */
  dominantScriptShare: 0.5,
  /** Tokens with letters of two alphabetic scripts, over alphabetic tokens. */
  mixedScriptSuspect: 0.2,
  /**
   * Symbol soup: ASCII punctuation and symbols (math operators and Unicode symbols excluded) are at least this share
   * of the non-space characters, over at least `symbolSoupMinDistinct` distinct marks, while letters are below
   * `symbolSoupMaxLetterShare`. A glyph-code shift that lands on punctuation leaves no letters to judge.
   */
  symbolSoupShare: 0.4,
  symbolSoupMinDistinct: 10,
  symbolSoupMaxLetterShare: 0.3,
  /** Fewer letters than this give too little evidence for the statistical checks. */
  minLettersForStatistics: 40,
} as const;

const UNMAPPED = /[�￾￿-\u{F0000}-\u{10FFFF}\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/gu;
const CID_RUN = /\(cid:\d+\)/g;

// UTF-8 text decoded as Latin-1/Windows-1252 ("Ã©", "â€™", "Ð¿Ñ€"): the lead byte of a Latin, Greek, Cyrillic, Arabic or
// Hebrew sequence followed by a continuation byte shown as Latin-1 or Windows-1252 punctuation. German capitals
// (Ö, Ü, ß) are not leads: "Straße—" is prose.
const LATIN1_MOJIBAKE = /[ÂÃÄÅÎÏÐÑØÙ×â][\u0080-¿ŒœŠšŸŽžƒˆ˜–-›€™]/gu;
// UTF-8 Cyrillic decoded as Windows-1251 ("Р°РІС‚"): every letter becomes Р or С plus a continuation byte, so the signature is
// a run of such pairs. A single pair is a Ukrainian, Belarusian, Serbian or Macedonian word ("Рівне", "СІЧЕНЬ", "РІШЕННЯ"):
// the continuation bytes include real letters (І, і, Ї, Є, Ј, Љ, Њ, Ћ, Џ, Ђ, ђ, ґ).
const CP1251_MOJIBAKE_RUN = new RegExp(
  `(?:[РС][Ђ-Џђ-џҐґ\\u00A0-¿‘-›€№™]){${TEXT_LAYER_QUALITY.cp1251MojibakeMinPairs},}`,
  "gu",
);

function countMatches(text: string, pattern: RegExp): { count: number; chars: number } {
  let count = 0;
  let chars = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    count += 1;
    chars += match[0].length;
    if (match[0] === "") pattern.lastIndex += 1;
  }
  return { count, chars };
}

type AlphabeticScript = "latin" | "cyrillic" | "greek";
const SCRIPT_TESTS: Array<[AlphabeticScript, RegExp]> = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
];

function scriptOf(char: string): AlphabeticScript | null {
  for (const [script, test] of SCRIPT_TESTS) if (test.test(char)) return script;
  return null;
}

/** A letter without its diacritics, lower case, so `é`, `ő` and `ά` score as their base letter. */
function baseLetter(char: string): string {
  return char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function wordLetterPairs(script: AlphabeticScript, tokenLetters: string[]): { sum: number; count: number } {
  const model = LETTER_BIGRAMS[script];
  const letters = Array.from(model.letters);
  const other = letters.length;
  const boundary = letters.length + 1;
  const size = letters.length + 2;
  const fold = model.fold as Record<string, string>;
  const symbols = tokenLetters.map((letter) => {
    const base = baseLetter(letter);
    const index = letters.indexOf(fold[base] ?? base);
    return index >= 0 ? index : other;
  });
  const sequence = [boundary, ...symbols, boundary];
  let sum = 0;
  for (let i = 0; i + 1 < sequence.length; i += 1) {
    sum -= (model.table.charCodeAt(sequence[i]! * size + sequence[i + 1]!) - 48) / 4;
  }
  return { sum, count: sequence.length - 1 };
}

/**
 * A long unspaced run of ASCII letters, digits and a few marks (a glyph-code shift lands on punctuation as well), that
 * is not a URL, an address or a restricted-alphabet sequence (hex digests, nucleotides).
 */
function isLongTokenCandidate(token: string): boolean {
  if (!/^[\x21-\x7e]+$/.test(token) || token.includes("://") || token.includes("@") || token.includes("-----")) return false;
  // A JSON Web Token (`eyJ…` is `{"`) is three base64url segments, never a shifted word.
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(token)) return false;
  const alphanumeric = token.match(/[A-Za-z0-9]/g)?.length ?? 0;
  if (alphanumeric < token.length * 0.7) return false;
  return !RESTRICTED_ALPHABET.test(token.replace(/[^A-Za-z0-9]/g, ""));
}

/** Probability that two characters drawn from the counts are equal: ~0.065 for a language's letters, 1/64 for base64. */
function indexOfCoincidence(counts: Map<string, number>, total: number): number {
  if (total < 2) return 0;
  let same = 0;
  for (const count of counts.values()) same += count * (count - 1);
  return same / (total * (total - 1));
}

const RESTRICTED_ALPHABET = /^[ACGTUNacgtun]+$|^[0-9A-Fa-f]+$/;

/**
 * Assess one page's text layer. Pass at most the first 64 KiB of a page: the checks are linear but the answer does
 * not need more.
 */
export function assessTextLayer(text: string): TextLayerAssessment {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return { verdict: "empty", garbleRatio: 0, letters: 0, reasons: [] };
  const sample = normalized.length > 65_536 ? normalized.slice(0, 65_536) : normalized;
  const nonSpace = Math.max(1, sample.replace(/ /g, "").length);
  const reasons: string[] = [];
  let garbled = false;
  let suspect = false;
  let ratio = 0;

  // 1. Unmapped glyph marks.
  const unmapped = countMatches(sample, UNMAPPED).chars + countMatches(sample, CID_RUN).chars;
  const unmappedRatio = unmapped / nonSpace;
  if (unmappedRatio >= TEXT_LAYER_QUALITY.unmappedGarbled) { garbled = true; reasons.push("unmapped-glyphs"); }
  else if (unmappedRatio >= TEXT_LAYER_QUALITY.unmappedSuspect) { suspect = true; reasons.push("unmapped-glyphs-minor"); }
  ratio = Math.max(ratio, unmappedRatio);

  // 2. Decoding mistakes.
  // A decoding mistake is `suspect`, never `garbled`: its signature can be language (a Latin-script name list, a cipher-like
  // table) and the OCR cross-check settles it; only unmapped glyphs are unreadable without a look at the image.
  const mojibake = (countMatches(sample, LATIN1_MOJIBAKE).chars + countMatches(sample, CP1251_MOJIBAKE_RUN).chars) / nonSpace;
  if (mojibake >= TEXT_LAYER_QUALITY.mojibakeSuspect) { suspect = true; reasons.push("mojibake"); }
  ratio = Math.max(ratio, mojibake);

  // Token pass: long-token mass, letter pairs and script mixing share one walk.
  let letters = 0;
  let longChars = 0;
  let longTokens = 0;
  const longAlphabet = new Map<string, number>();
  let longDigits = 0;
  const scriptLetters: Record<AlphabeticScript, number> = { latin: 0, cyrillic: 0, greek: 0 };
  const pairs: Record<AlphabeticScript, { sum: number; count: number; words: number }> = {
    latin: { sum: 0, count: 0, words: 0 },
    cyrillic: { sum: 0, count: 0, words: 0 },
    greek: { sum: 0, count: 0, words: 0 },
  };
  let alphabeticTokens = 0;
  let mixedTokens = 0;
  for (const token of sample.split(" ")) {
    if (!token) continue;
    if (token.length >= TEXT_LAYER_QUALITY.longTokenChars && isLongTokenCandidate(token)) {
      // Mixed-case noise or upper-case and digits only (no word is that long): a glyph-code shift renders text so,
      // a key as well, but a key is one token; a page needs several and most of its characters.
      const flips = token.match(/[a-z][A-Z]|[A-Z][a-z]|[A-Za-z][0-9]|[0-9][A-Za-z]/g)?.length ?? 0;
      if (flips >= 3 || !/[a-z]/.test(token)) {
        longChars += token.length;
        longTokens += 1;
        for (const char of token) {
          longAlphabet.set(char, (longAlphabet.get(char) ?? 0) + 1);
          if (char >= "0" && char <= "9") longDigits += 1;
        }
      }
    }
    const tokenLetters = token.match(/\p{L}/gu);
    if (!tokenLetters) continue;
    letters += tokenLetters.length;
    const tokenScripts = new Set<AlphabeticScript>();
    let alphabetic = 0;
    for (const letter of tokenLetters) {
      const script = scriptOf(letter);
      if (!script) continue;
      tokenScripts.add(script);
      scriptLetters[script] += 1;
      alphabetic += 1;
    }
    if (alphabetic === 0) continue;
    alphabeticTokens += 1;
    if (tokenScripts.size > 1) mixedTokens += 1;
    // Acronyms (PDF, HTML, SQL) and words of one or two letters carry no evidence about the script's letter pairs.
    if (tokenScripts.size === 1 && alphabetic >= 3 && alphabetic === tokenLetters.length && !(alphabetic <= 6 && token === token.toUpperCase())) {
      const script = [...tokenScripts][0]!;
      const score = wordLetterPairs(script, tokenLetters);
      pairs[script].sum += score.sum;
      pairs[script].count += score.count;
      pairs[script].words += 1;
    }
  }

  // 3. Glyph-code shift: most of the page is long, mixed-case alphanumeric runs over a wide alphabet whose letter
  // frequencies are a language's (a shift renames letters, it does not flatten them). Base64, PEM, JWTs, keys and
  // part numbers are long runs too, but uniform or digit-heavy. A shift is `suspect`: the OCR cross-check settles it.
  const longRatio = longChars / nonSpace;
  if (longTokens >= TEXT_LAYER_QUALITY.longTokenMinTokens && longAlphabet.size >= 12 && longRatio >= TEXT_LAYER_QUALITY.longTokenGarbled &&
      longDigits <= longChars * TEXT_LAYER_QUALITY.longTokenMaxDigitShare &&
      indexOfCoincidence(longAlphabet, longChars) >= TEXT_LAYER_QUALITY.longTokenMinCoincidence) {
    suspect = true;
    reasons.push("glyph-shift");
    ratio = Math.max(ratio, longRatio);
  }

  // 3b. Symbol soup.
  if (nonSpace >= 40) {
    const marks = sample.match(/[!-/:-@[-`{-~]/g) ?? [];
    const letterShare = letters / nonSpace;
    if (marks.length / nonSpace >= TEXT_LAYER_QUALITY.symbolSoupShare && letterShare < TEXT_LAYER_QUALITY.symbolSoupMaxLetterShare &&
        new Set(marks).size >= TEXT_LAYER_QUALITY.symbolSoupMinDistinct) {
      garbled = true;
      reasons.push("symbol-soup");
      ratio = Math.max(ratio, marks.length / nonSpace);
    }
  }

  // 4. Letters that do not pair like the script's words (a consistent glyph substitution keeps every mark the
  // checks above look for). Only the page's dominant alphabetic script is judged.
  for (const script of Object.keys(pairs) as AlphabeticScript[]) {
    const { sum, count, words } = pairs[script];
    if (words < TEXT_LAYER_QUALITY.minWordsForLanguageModel || scriptLetters[script] < letters * TEXT_LAYER_QUALITY.dominantScriptShare) continue;
    const mean = sum / Math.max(1, count);
    if (mean < TEXT_LAYER_QUALITY.implausibleLetterPairs && words >= TEXT_LAYER_QUALITY.minWordsForGarbledLanguageModel) {
      garbled = true;
      reasons.push("implausible-letter-pairs");
      ratio = Math.max(ratio, 1);
    } else if (mean < TEXT_LAYER_QUALITY.plausibleLetterPairs) {
      suspect = true;
      reasons.push("unusual-letter-pairs");
    }
  }
  if (alphabeticTokens >= 8 && letters >= TEXT_LAYER_QUALITY.minLettersForStatistics &&
      mixedTokens / alphabeticTokens >= TEXT_LAYER_QUALITY.mixedScriptSuspect) {
    suspect = true;
    reasons.push("mixed-script-words");
  }
  return { verdict: garbled ? "garbled" : suspect ? "suspect" : "ok", garbleRatio: Math.min(1, ratio), letters, reasons };
}

// ---- OCR cross-check ------------------------------------------------------------------------------------------

/** Words of a text for the cross-check: letter/digit runs; unspaced scripts (CJK, Thai...) as character bigrams. */
export function agreementTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const run of text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? []) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(run)) {
      const chars = Array.from(run);
      if (chars.length === 1) tokens.push(run);
      for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i]! + chars[i + 1]!);
    } else if (run.length >= 2) {
      tokens.push(run);
    }
  }
  return tokens;
}

export interface TokenAgreement {
  /** Share of OCR tokens that continue the text layer's token order. */
  precision: number;
  /** Share of text-layer tokens that continue the OCR's token order. */
  recall: number;
  layerTokens: number;
  ocrTokens: number;
}

/** Longest-common-subsequence length of two token sequences, bounded so a hostile page cannot cost more than 4M steps. */
function lcsLength(a: string[], b: string[]): number {
  const limit = 2000;
  const left = a.length > limit ? a.slice(0, limit) : a;
  const right = b.length > limit ? b.slice(0, limit) : b;
  let previous = new Uint16Array(right.length + 1);
  let current = new Uint16Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[right.length]!;
}

/**
 * How well a text layer and an OCR of the same page agree: both directions, in reading order. Precision alone passes
 * an OCR that is a subset of a salad; recall alone passes a layer that is a superset of what is visible. A real
 * layer scores high on both; a substituted or misaligned one scores low on at least one. Null when either side
 * has too few tokens to compare.
 */
export function tokenAgreement(layerText: string, ocrText: string, minTokens = 8): TokenAgreement | null {
  const layer = agreementTokens(layerText);
  const ocr = agreementTokens(ocrText);
  if (layer.length < minTokens || ocr.length < minTokens) return null;
  const common = lcsLength(layer, ocr);
  return {
    precision: common / Math.min(ocr.length, 2000),
    recall: common / Math.min(layer.length, 2000),
    layerTokens: layer.length,
    ocrTokens: ocr.length,
  };
}

/** Least precision and recall at which a text layer is taken to match the page image (calibration: the design note). */
export const TEXT_LAYER_AGREEMENT_MIN = 0.5;

export function textLayerMatchesOcr(agreement: TokenAgreement): boolean {
  return agreement.precision >= TEXT_LAYER_AGREEMENT_MIN && agreement.recall >= TEXT_LAYER_AGREEMENT_MIN;
}
