/** Token helpers shared by the conservation validators. Generic text handling only. */

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
}

export function tokenize(text: string): string[] {
  const n = normalizeText(text);
  return n ? n.split(" ") : [];
}

export function countTokens(tokens: Iterable<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Parses a cell as a number: thousands separators, currency, percent, parentheses/minus for negatives. */
export function parseNumber(cell: string): number | null {
  let s = normalizeText(cell).replace(/[$€£¥%\s]/g, "");
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-") || s.startsWith("−")) {
    sign = -sign;
    s = s.slice(1);
  }
  if (!/^\d{1,3}(,\d{3})+(\.\d+)?$|^\d+(\.\d+)?$/.test(s)) return null;
  return sign * Number(s.replace(/,/g, ""));
}

/** Multiset of non-space characters after NFKC. Robust to span splitting, hyphenation spacing and word-level bidi reordering. */
export function countChars(texts: Iterable<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of texts) {
    for (const ch of normalizeText(t).replace(/ /g, "")) m.set(ch, (m.get(ch) ?? 0) + 1);
  }
  return m;
}

const NUMBER_RE = /\d(?:[\d.,]*\d)?/g;

/** Number-like substrings (digit runs with inner separators), normalised by dropping separators' spacing. */
export function numericTokens(texts: Iterable<string>): string[] {
  const out: string[] = [];
  for (const t of texts) out.push(...(normalizeText(t).match(NUMBER_RE) ?? []));
  return out;
}
