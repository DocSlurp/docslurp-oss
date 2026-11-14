/**
 * Script-aware text folding for keyword search. `foldText` mirrors the database function
 * `docslurp_fold_text` (migration 0121) behind the folded keyword index (to_tsvector('simple', docslurp_fold_text(text))), so the query side
 * and the indexed side agree: lowercase, Latin diacritics removed, and (in SQL) a space around every
 * CJK / kana / Hangul character. Nothing here guesses a language; it only decides how text is cut into terms.
 */

const CJK_CLASS = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff66-\\uff9f";
const CJK_CHAR = new RegExp(`[${CJK_CLASS}]`, "u");
const CJK_SPLIT = new RegExp(`[${CJK_CLASS}]+|[^${CJK_CLASS}]+`, "gu");
const ASCII_ONLY = /^[\u0000-\u007f]*$/;
const TERM_SEPARATORS = /[^\p{L}\p{N}\p{M}-]+/u;

/** True when the text contains CJK, kana or Hangul characters, which have no word boundaries. */
export function hasCjk(text: string): boolean {
  return CJK_CHAR.test(text);
}

/** True when the text has anything outside ASCII (accents, Cyrillic, Greek, CJK ...). */
export function hasNonAscii(text: string): boolean {
  return /[^\u0000-\u007f]/.test(text);
}

/** Lowercase with Latin diacritics removed (NFD, drop combining marks U+0300-036F, NFC). */
export function foldText(text: string): string {
  // ASCII has no diacritics and is its own NFD/NFC form, so lowercasing is the whole fold.
  if (ASCII_ONLY.test(text)) return text.toLowerCase();
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC");
}

/**
 * Terms of a query for matching: words (folded) and, for unsegmented CJK runs, overlapping character
 * pairs (a single character stands alone). Used for relevance coverage and the folded OR backoff.
 */
export function matchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const segment of foldText(text).split(TERM_SEPARATORS)) {
    if (!segment) continue;
    for (const piece of segment.match(CJK_SPLIT) ?? []) {
      if (!CJK_CHAR.test(piece)) {
        terms.push(piece);
        continue;
      }
      const chars = Array.from(piece);
      if (chars.length === 1) terms.push(chars[0]!);
      else for (let index = 0; index < chars.length - 1; index += 1) terms.push(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return terms;
}

const MAX_BACKOFF_TERMS = 48;

/**
 * The OR query for the folded ('simple') leg: each word is a term and each adjacent CJK pair a two-term
 * phrase, so "日本の首都" matches any chunk holding "日本", "本の", "の首" or "首都". Terms contain only
 * letters, digits, marks and hyphens, so quoting them is safe.
 */
export function buildFoldedBackoffTsQuery(query: string, stopWords: ReadonlySet<string> = new Set()): string | null {
  const parts: string[] = [];
  for (const term of new Set(matchTerms(query))) {
    if (hasCjk(term)) {
      const chars = Array.from(term);
      parts.push(chars.length === 1 ? `'${term}'` : `('${chars[0]}' <-> '${chars[1]}')`);
    } else if (term.length >= 2 && !stopWords.has(term) && /[\p{L}]/u.test(term)) {
      parts.push(`'${term}'`);
    }
    if (parts.length >= MAX_BACKOFF_TERMS) break;
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}

/** Words for the English OR backoff: Unicode letters and digits, no CJK runs (those use the folded leg). */
export function backoffWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(TERM_SEPARATORS)
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter((word) => word && !hasCjk(word));
}
