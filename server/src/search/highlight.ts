import { matchTerms } from "./text-fold.js";
import { hasCjk } from "./text-fold.js";

export interface HighlightResult {
  value: string;
  /** Algolia's levels: "full" when every query word is in the text, "partial" for some, "none". */
  matchLevel: "none" | "partial" | "full";
  matchedWords: string[];
  fullyHighlighted: boolean;
}

/** Letters, digits and marks: the characters that make up a word. */
const WORD = /[\p{L}\p{N}\p{M}]/u;

/**
 * Wraps the query's words in `pre`/`post` inside `text`, matching case- and accent-insensitively (the same
 * folding keyword search uses), whole words for alphabetic scripts and character runs for CJK, whose words
 * have no boundaries. The text itself is returned unchanged apart from the tags.
 */
export function highlightMatches(text: string, query: string, pre: string, post: string): HighlightResult {
  const queryTerms = [...new Set(matchTerms(query))].filter(Boolean);
  const wordTerms = new Set(queryTerms.filter((term) => !hasCjk(term)));
  const cjkTerms = queryTerms.filter((term) => hasCjk(term));

  // Per original code point: its folded form (a base letter may lose its accent) and where it sits in `text`.
  const points = Array.from(text);
  const folded = points.map((point) => point.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC"));
  const marked = new Array<boolean>(points.length).fill(false);
  const matched = new Set<string>();

  // Whole words.
  let index = 0;
  while (index < points.length) {
    if (!WORD.test(points[index]!) || hasCjk(points[index]!)) { index += 1; continue; }
    let end = index;
    while (end < points.length && WORD.test(points[end]!) && !hasCjk(points[end]!)) end += 1;
    const word = folded.slice(index, end).join("");
    if (wordTerms.has(word)) {
      for (let at = index; at < end; at += 1) marked[at] = true;
      matched.add(word);
    }
    index = end;
  }

  // CJK: each pair (or single character) of the query wherever it occurs.
  if (cjkTerms.length > 0) {
    const joined = folded.join("");
    // `folded` entries are single characters here (CJK has no decomposition that changes length).
    for (const term of cjkTerms) {
      let from = joined.indexOf(term);
      while (from !== -1) {
        for (let at = from; at < from + term.length; at += 1) marked[at] = true;
        matched.add(term);
        from = joined.indexOf(term, from + 1);
      }
    }
  }

  let value = "";
  for (let at = 0; at < points.length; at += 1) {
    if (marked[at] && !marked[at - 1]) value += pre;
    value += points[at];
    if (marked[at] && !marked[at + 1]) value += post;
  }
  const matchedCount = queryTerms.filter((term) => matched.has(term)).length;
  const matchLevel = matchedCount === 0 ? "none" : matchedCount === queryTerms.length ? "full" : "partial";
  return {
    value,
    matchLevel,
    matchedWords: queryTerms.filter((term) => matched.has(term)),
    fullyHighlighted: matchLevel !== "none" && marked.every(Boolean),
  };
}
