/**
 * Synonym and acronym expansion for BM25 full-text queries.
 * Expands query tokens using a provided glossary for jargon-heavy corpora.
 */

export type Glossary = Record<string, string[]>;

/**
 * Expand query tokens using glossary. Returns a BM25-compatible query string
 * with OR alternatives. E.g. "ml model" with glossary {ml: ["machine learning"]}
 * -> "(ml OR machine learning) model"
 */
export function expandQuery(query: string, glossary: Glossary): string {
  const normalizedGlossary: Glossary = {};
  for (const [key, synonyms] of Object.entries(glossary)) {
    normalizedGlossary[key.toLowerCase()] = synonyms;
  }

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const result: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    let matched = false;

    // Try 3-gram
    if (i + 2 < tokens.length) {
      const trigram = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
      if (normalizedGlossary[trigram]) {
        result.push(expandToken(trigram, normalizedGlossary[trigram]));
        i += 3;
        matched = true;
      }
    }

    // Try 2-gram
    if (!matched && i + 1 < tokens.length) {
      const bigram = `${tokens[i]} ${tokens[i + 1]}`;
      if (normalizedGlossary[bigram]) {
        result.push(expandToken(bigram, normalizedGlossary[bigram]));
        i += 2;
        matched = true;
      }
    }

    // Try single token
    if (!matched) {
      const token = tokens[i];
      if (normalizedGlossary[token]) {
        result.push(expandToken(token, normalizedGlossary[token]));
      } else {
        result.push(token);
      }
      i++;
    }
  }

  return result.join(" ");
}

function expandToken(token: string, synonyms: string[]): string {
  const alternatives = [token, ...synonyms].join(" OR ");
  return `(${alternatives})`;
}
