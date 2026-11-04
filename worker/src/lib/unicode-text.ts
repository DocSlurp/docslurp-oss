/**
 * Unicode-aware text helpers shared by chunking, graph naming and structured
 * extraction. Everything here works on user-perceived characters, words and
 * sentences (`Intl.Segmenter`), never on UTF-16 code units, so a surrogate pair
 * or a grapheme cluster (emoji ZWJ sequences, combining marks) is never cut.
 *
 * Normalization is NFC, not NFKC: NFKC folds characters that differ in meaning
 * (full-width digits, superscripts, ligatures) and is not needed to make
 * visually identical text compare equal.
 */

const segmenters = new Map<string, Intl.Segmenter>();

function segmenter(granularity: "grapheme" | "word" | "sentence"): Intl.Segmenter {
  let value = segmenters.get(granularity);
  if (!value) {
    value = new Intl.Segmenter(undefined, { granularity });
    segmenters.set(granularity, value);
  }
  return value;
}

/** Canonical composition form; the one form extracted text is stored and indexed in. */
export function normalizeNfc(text: string): string {
  return text.normalize("NFC");
}

/**
 * Comparison key for names: NFC, locale-independent lower case, runs of
 * non-letter/number characters collapsed to one space. `C++` and `C#` keep
 * their symbols (see `entityKey` in the graph for the identity rule).
 */
export function foldKey(text: string): string {
  return normalizeNfc(text).toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
}

/** Letters, numbers and marks from any script. */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN = /^[\p{Script=Latin}\p{N}\p{M}'’_-]+$/u;

export function isWordChar(char: string): boolean {
  return WORD_CHAR.test(char);
}

export function graphemes(text: string): string[] {
  return Array.from(segmenter("grapheme").segment(text), (part) => part.segment);
}

export function sentences(text: string): string[] {
  return Array.from(segmenter("sentence").segment(text), (part) => part.segment);
}

/** Words (and the separators between them), so joining the result restores the text. */
export function wordParts(text: string): Array<{ text: string; wordLike: boolean }> {
  return Array.from(segmenter("word").segment(text), (part) => ({ text: part.segment, wordLike: part.isWordLike === true }));
}

/**
 * Conservative token count for sizing chunks and for usage estimates when the
 * provider reports none. One estimator for the worker: Latin-script words cost
 * about a token per four letters, other alphabets a token per three, ideographic
 * scripts a token per character, and every punctuation mark, symbol or emoji
 * code point one token. It deliberately over-counts so a chunk sized by it
 * never exceeds the model's real limit. It is additive across segments cut at
 * word boundaries.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const part of segmenter("word").segment(text)) {
    const value = part.segment;
    if (part.isWordLike) {
      tokens += wordTokens(value);
    } else if (value.trim()) {
      for (const char of value) if (char.trim()) tokens++;
    }
  }
  return tokens;
}

function wordTokens(word: string): number {
  let ideographic = 0;
  let other = 0;
  for (const char of word) {
    if (IDEOGRAPHIC.test(char)) ideographic++;
    else other++;
  }
  if (other === 0) return ideographic;
  const perToken = LATIN.test(word) ? 4 : 3;
  return ideographic + Math.max(1, Math.ceil(other / perToken));
}

export interface SizeLimits {
  /** UTF-16 length limit (the storage and display unit). */
  maxChars: number;
  /** Model-token limit; omitted when only characters matter. */
  maxTokens?: number;
}

export function fitsLimits(text: string, limits: SizeLimits, tokens = limits.maxTokens === undefined ? 0 : estimateTokens(text)): boolean {
  return text.length <= limits.maxChars && (limits.maxTokens === undefined || tokens <= limits.maxTokens);
}

export type SplitLevel = "sentence" | "line" | "word" | "grapheme";

function unitsAt(text: string, level: SplitLevel): string[] {
  switch (level) {
    case "sentence": return sentences(text);
    case "line": return text.split(/(?<=\n)/);
    case "word": return wordParts(text).map((part) => part.text);
    case "grapheme": return graphemes(text);
  }
}

const NEXT_LEVEL: Record<Exclude<SplitLevel, "grapheme">, SplitLevel> = { sentence: "line", line: "word", word: "grapheme" };

/**
 * Cuts `text` into pieces that each fit `limits`, preferring the coarsest
 * boundary that works: sentence, then line, then word, then grapheme. Pieces
 * keep their whitespace, so concatenating them restores the text exactly. Code
 * starts at the line level because it has no sentences.
 */
export function atomize(text: string, limits: SizeLimits, options?: { code?: boolean }): string[] {
  if (!text) return [];
  return split(text, limits, options?.code ? "line" : "sentence");
}

function split(text: string, limits: SizeLimits, level: SplitLevel): string[] {
  if (fitsLimits(text, limits)) return [text];
  if (level === "grapheme") return splitGraphemes(text, limits);
  const parts = unitsAt(text, level);
  if (parts.length <= 1) return split(text, limits, NEXT_LEVEL[level]);
  const next = NEXT_LEVEL[level];
  const pieces: string[] = [];
  let current = "";
  let currentTokens = 0;
  const flush = () => {
    if (current) pieces.push(current);
    current = "";
    currentTokens = 0;
  };
  for (const part of parts) {
    const partTokens = limits.maxTokens === undefined ? 0 : estimateTokens(part);
    if (!fitsLimits(part, limits, partTokens)) {
      flush();
      pieces.push(...split(part, limits, next));
      continue;
    }
    if (current && !fitsLimits(current + part, limits, currentTokens + partTokens)) flush();
    current += part;
    currentTokens += partTokens;
  }
  flush();
  return pieces;
}

function splitGraphemes(text: string, limits: SizeLimits): string[] {
  const pieces: string[] = [];
  let current = "";
  let currentTokens = 0;
  for (const cluster of graphemes(text)) {
    const clusterTokens = limits.maxTokens === undefined ? 0 : estimateTokens(cluster);
    if (!fitsLimits(cluster, limits, clusterTokens)) {
      // A single cluster over the limit (hundreds of combining marks): cut by
      // code point, which still never splits a surrogate pair.
      if (current) pieces.push(current);
      current = "";
      currentTokens = 0;
      let piece = "";
      for (const point of cluster) {
        if (piece && !fitsLimits(piece + point, limits, limits.maxTokens === undefined ? 0 : estimateTokens(piece + point))) {
          pieces.push(piece);
          piece = "";
        }
        piece += point;
      }
      if (piece) pieces.push(piece);
      continue;
    }
    if (current && !fitsLimits(current + cluster, limits, currentTokens + clusterTokens)) {
      pieces.push(current);
      current = "";
      currentTokens = 0;
    }
    current += cluster;
    currentTokens += clusterTokens;
  }
  if (current) pieces.push(current);
  return pieces;
}

/** The last `maxChars` or fewer UTF-16 units of `text`, starting on a word boundary. */
export function tailWords(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const parts = wordParts(text);
  let start = text.length;
  for (let index = parts.length - 1; index >= 0; index--) {
    const next = start - parts[index]!.text.length;
    if (text.length - next > maxChars) break;
    start = next;
  }
  return text.slice(start).trimStart();
}

/** The first `maxChars` or fewer UTF-16 units of `text`, ending on a word boundary. */
export function headWords(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  let end = 0;
  for (const part of wordParts(text)) {
    if (end + part.text.length > maxChars) break;
    end += part.text.length;
  }
  return text.slice(0, end).trimEnd();
}
