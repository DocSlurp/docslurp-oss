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
  // Nothing below U+1100 is Han, Kana or Hangul, and nothing there is a surrogate: skip the per-character script test.
  let low = true;
  for (let i = 0; i < word.length; i++) {
    if (word.charCodeAt(i) >= 0x1100) {
      low = false;
      break;
    }
  }
  if (low) return Math.max(1, Math.ceil(word.length / (LATIN.test(word) ? 4 : 3)));
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

/**
 * Whether `text` fits. Characters are checked first and the token estimate is skipped when the answer is already
 * known: a token costs at least one UTF-16 unit of text (`estimateTokens(text) <= text.length`), so text no longer
 * than `maxTokens` always fits, and oversize text is rejected without segmenting it.
 */
export function fitsLimits(text: string, limits: SizeLimits, tokens?: number): boolean {
  if (text.length > limits.maxChars) return false;
  if (limits.maxTokens === undefined || text.length <= limits.maxTokens) return true;
  return (tokens ?? estimateTokens(text)) <= limits.maxTokens;
}

export type SplitLevel = "sentence" | "line" | "word" | "grapheme";

export interface SizedPiece {
  text: string;
  /** `estimateTokens(text)` or, for pieces cut inside a word, a conservative count; 0 when no token limit applies. */
  tokens: number;
}

const NEXT_LEVEL: Record<Exclude<SplitLevel, "grapheme">, SplitLevel> = { sentence: "line", line: "word", word: "grapheme" };

/**
 * Cuts `text` into pieces that each fit `limits`, preferring the coarsest
 * boundary that works: sentence, then line, then word, then grapheme. Pieces
 * keep their whitespace, so concatenating them restores the text exactly. Code
 * starts at the line level because it has no sentences.
 */
export function atomize(text: string, limits: SizeLimits, options?: { code?: boolean }): string[] {
  return atomizeSized(text, limits, options).map((piece) => piece.text);
}

/**
 * `atomize` with each piece's token count, so a caller packing pieces into chunks does not segment them again.
 *
 * Linear in the text: every level walks its parts once, a part is counted only when it can fit the character limit,
 * and a text that is over the limit is never counted as a whole. Word and grapheme parts are counted as they are
 * walked and never collected into an array.
 */
export function atomizeSized(text: string, limits: SizeLimits, options?: { code?: boolean }): SizedPiece[] {
  if (!text) return [];
  const pieces: SizedPiece[] = [];
  split(pieces, text, limits, options?.code ? "line" : "sentence");
  return pieces;
}

function split(out: SizedPiece[], text: string, limits: SizeLimits, level: SplitLevel, known?: number): void {
  const counting = limits.maxTokens !== undefined;
  if (text.length <= limits.maxChars) {
    const tokens = counting ? known ?? estimateTokens(text) : 0;
    if (!counting || tokens <= limits.maxTokens!) {
      out.push({ text, tokens });
      return;
    }
  }
  if (level === "grapheme") return splitGraphemes(out, text, limits);
  if (level === "word") return splitWords(out, text, limits);
  const next = NEXT_LEVEL[level];
  const packer = new Packer(out, limits);
  const parts: Iterable<string> = level === "sentence" ? lazySentences(text) : text.split(/(?<=\n)/);
  for (const part of parts) {
    if (part.length > limits.maxChars) {
      packer.flush();
      split(out, part, limits, next);
      continue;
    }
    const tokens = counting ? estimateTokens(part) : 0;
    if (counting && tokens > limits.maxTokens!) {
      packer.flush();
      split(out, part, limits, next, tokens);
      continue;
    }
    packer.add(part, tokens);
  }
  packer.flush();
}

/** Greedy packing of parts that each fit into pieces that each fit. */
class Packer {
  private current = "";
  private currentTokens = 0;
  /** `recount`: pieces cut inside words were packed by a per-cluster upper bound; report their real estimate. */
  constructor(private readonly out: SizedPiece[], private readonly limits: SizeLimits, private readonly recount = false) {}

  add(part: string, tokens: number): void {
    if (this.current && (this.current.length + part.length > this.limits.maxChars ||
        (this.limits.maxTokens !== undefined && this.currentTokens + tokens > this.limits.maxTokens))) {
      this.flush();
    }
    this.current += part;
    this.currentTokens += tokens;
  }

  flush(): void {
    if (this.current) {
      const tokens = this.recount && this.limits.maxTokens !== undefined ? estimateTokens(this.current) : this.currentTokens;
      this.out.push({ text: this.current, tokens });
    }
    this.current = "";
    this.currentTokens = 0;
  }
}

function* lazySentences(text: string): Generator<string> {
  for (const part of segmenter("sentence").segment(text)) yield part.segment;
}

function splitWords(out: SizedPiece[], text: string, limits: SizeLimits): void {
  const counting = limits.maxTokens !== undefined;
  const packer = new Packer(out, limits);
  for (const part of segmenter("word").segment(text)) {
    const value = part.segment;
    const tokens = !counting ? 0 : part.isWordLike ? wordTokens(value) : symbolTokens(value);
    if (value.length > limits.maxChars || (counting && tokens > limits.maxTokens!)) {
      packer.flush();
      splitGraphemes(out, value, limits);
      continue;
    }
    packer.add(value, tokens);
  }
  packer.flush();
}

function splitGraphemes(out: SizedPiece[], text: string, limits: SizeLimits): void {
  const counting = limits.maxTokens !== undefined;
  const packer = new Packer(out, limits, true);
  for (const part of segmenter("grapheme").segment(text)) {
    const cluster = part.segment;
    const tokens = counting ? graphemeTokens(cluster) : 0;
    if (cluster.length > limits.maxChars || (counting && tokens > limits.maxTokens!)) {
      // A single cluster over the limit (hundreds of combining marks): cut by code point, which still never splits a
      // surrogate pair. Each code point counts one token, an upper bound of the estimate.
      packer.flush();
      let piece = "";
      let pieceTokens = 0;
      for (const point of cluster) {
        const cost = counting && point.trim() ? 1 : 0;
        if (piece && (piece.length + point.length > limits.maxChars || (counting && pieceTokens + cost > limits.maxTokens!))) {
          out.push({ text: piece, tokens: pieceTokens });
          piece = "";
          pieceTokens = 0;
        }
        piece += point;
        pieceTokens += cost;
      }
      if (piece) out.push({ text: piece, tokens: pieceTokens });
      continue;
    }
    packer.add(cluster, tokens);
  }
  packer.flush();
}

/** What `estimateTokens` charges for a non-word segment: one token per non-space code point. */
function symbolTokens(value: string): number {
  if (value.length === 1) return value.trim() ? 1 : 0;
  let tokens = 0;
  for (const char of value) if (char.trim()) tokens++;
  return tokens;
}

/** A cluster of one code point costs one token unless it is whitespace; clusters with marks or joiners are counted whole. */
function graphemeTokens(cluster: string): number {
  const single = cluster.length === 1 || (cluster.length === 2 && cluster.codePointAt(0)! > 0xffff);
  if (single) return cluster.trim() ? 1 : 0;
  return estimateTokens(cluster);
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
