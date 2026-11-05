/**
 * Synonym and acronym expansion for BM25 full-text queries.
 * Expands query tokens using a provided glossary for jargon-heavy corpora.
 */

export type Glossary = Record<string, string[]>;

/** Most alternative queries one expansion may produce; further synonyms are dropped, never the query itself. */
const MAX_EXPANDED_QUERIES = 16;

/**
 * Expand query tokens using a glossary into a websearch_to_tsquery query. That syntax has no
 * parentheses, and `a b or c` means `(a AND b) OR c`, so a grouped form such as
 * "(ml OR machine learning) model" read as `ml OR (machine AND learning AND model)`: the unexpanded
 * term lost its "model" and an unrelated hit on "ml" alone matched. The expansion is instead
 * distributed into whole alternative queries: "ml model" with {ml: ["machine learning"]} becomes
 * `ml model or "machine learning" model`, so every alternative keeps all the other terms.
 */
export function expandQuery(query: string, glossary: Glossary): string {
  const normalizedGlossary: Glossary = {};
  for (const [key, synonyms] of Object.entries(glossary)) {
    normalizedGlossary[key.toLowerCase()] = synonyms;
  }

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  // One slot per query position: the term itself followed by its glossary alternatives.
  const slots: string[][] = [];
  let i = 0;

  while (i < tokens.length) {
    let span = 1;
    if (i + 2 < tokens.length && normalizedGlossary[`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`]) span = 3;
    else if (i + 1 < tokens.length && normalizedGlossary[`${tokens[i]} ${tokens[i + 1]}`]) span = 2;
    const phrase = tokens.slice(i, i + span).join(" ");
    const synonyms = normalizedGlossary[phrase];
    slots.push(synonyms ? [phrase, ...synonyms] : [phrase]);
    i += span;
  }

  if (slots.every((slot) => slot.length === 1)) return slots.map((slot) => slot[0]).join(" ");

  // Cartesian product, original wording first, capped.
  let queries: string[][] = [[]];
  for (const slot of slots) {
    const next: string[][] = [];
    for (const prefix of queries) {
      for (const [index, alternative] of slot.entries()) {
        // The user's own wording stays as typed; only glossary alternatives become phrases.
        next.push([...prefix, index === 0 ? alternative : alternativeText(alternative)]);
        if (next.length >= MAX_EXPANDED_QUERIES) break;
      }
      if (next.length >= MAX_EXPANDED_QUERIES) break;
    }
    // A capped product never loses the unexpanded query: its prefix is always the first branch.
    queries = next.length > 0 ? next : queries;
  }
  return queries.map((terms) => terms.join(" ")).join(" or ");
}

/** A multi-word glossary entry is a phrase; quotes inside it cannot close the phrase early. */
function alternativeText(text: string): string {
  const clean = text.replace(/"/g, " ").replace(/\s+/g, " ").trim();
  return /\s/.test(clean) && !/^".*"$/.test(text) ? `"${clean}"` : clean;
}
