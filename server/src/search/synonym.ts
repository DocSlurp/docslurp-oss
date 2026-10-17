/** Explicit, workspace-scoped aliases shared by lexical and vector retrieval. */
export type Glossary = Record<string, string[]>;

const MAX_GROUPS = 256;
const MAX_ALIASES = 8;
const MAX_ALIAS_LENGTH = 128;
const MAX_MATCHES = 8;
const MAX_VARIANTS = 8;
const MAX_QUERY_LENGTH = 8_192;

type AliasGroup = { terms: string[] };
type Match = { start: number; end: number; term: string; alternatives: string[] };

/** Later scopes override earlier keys, including differently cased keys and []. */
export function mergeGlossaries(...scopes: (Glossary | undefined)[]): Glossary {
  const merged: Glossary = Object.create(null);
  for (const scope of scopes) {
    for (const [key, aliases] of Object.entries(scope ?? {})) {
      merged[normalize(key)] = aliases;
    }
  }
  return merged;
}

function normalize(term: string): string {
  return term.trim().replace(/\s+/g, " ").toLowerCase();
}

function clean(term: string): string {
  return term.trim().replace(/\s+/g, " ");
}

function findMatches(query: string, glossary: Glossary): Match[] {
  if (query.length > MAX_QUERY_LENGTH) return [];
  const groups: AliasGroup[] = Object.entries(mergeGlossaries(glossary))
    .slice(0, MAX_GROUPS)
    .map(([key, aliases]) => ({
      terms: [...new Map([key, ...aliases.slice(0, MAX_ALIASES)]
        .map(clean)
        .filter(term => term.length > 0 && term.length <= MAX_ALIAS_LENGTH)
        .map(term => [normalize(term), term])).values()],
    }));
  const owners = new Map<string, AliasGroup[]>();
  for (const group of groups) {
    for (const term of group.terms) {
      const key = normalize(term);
      owners.set(key, [...(owners.get(key) ?? []), group]);
    }
  }
  const candidates: Match[] = [];
  for (const [term, termGroups] of owners) {
    // A shared abbreviation can denote different concepts. Do not pick a sense.
    if (termGroups.length !== 1) continue;
    const alternatives = termGroups[0].terms.filter(alias => normalize(alias) !== term);
    if (alternatives.length === 0) continue;
    const escaped = term.split(" ").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    // Do not expand the prefix of a course/product code, URL or dotted identifier.
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_./+\\-])${escaped}(?![\\p{L}\\p{N}_/+\\-]|\\.[\\p{L}\\p{N}])`, "giu");
    for (const found of query.matchAll(pattern)) {
      candidates.push({ start: found.index, end: found.index + found[0].length, term: found[0], alternatives });
      if (candidates.length >= MAX_GROUPS * MAX_MATCHES) break;
    }
  }
  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const matches: Match[] = [];
  for (const candidate of candidates) {
    if (matches.length && candidate.start < matches[matches.length - 1].end) continue;
    matches.push(candidate);
    if (matches.length === MAX_MATCHES) break;
  }
  return matches;
}

/** Append explicit aliases without replacing the original words or identifiers. */
export function expandEmbeddingQuery(query: string, glossary: Glossary): string {
  const additions = [...new Set(findMatches(query, glossary)
    .map(match => `${match.term} = ${match.alternatives.join("; ")}`))];
  return additions.length ? `${query}\nAliases: ${additions.join(". ")}` : query;
}

function quote(term: string): string {
  return `"${term.replaceAll('"', " ")}"`;
}

function literalTerms(text: string): string {
  return text.split(/\s+/).filter(Boolean).map(quote).join(" ");
}

/**
 * Postgres websearch_to_tsquery ignores parentheses. Emit bounded, complete AND
 * branches joined by OR, preserving the query context in every alternative.
 * Explicit websearch syntax is left untouched rather than changing its meaning.
 */
export function expandQuery(query: string, glossary: Glossary): string {
  if (/"|(?:^|\s)-\S|\bOR\b/i.test(query)) return query;
  const matches = findMatches(query, glossary);
  if (!matches.length) return query;
  function variant(replacements: Map<Match, string>): string {
    const parts: string[] = [];
    let cursor = 0;
    for (const match of matches) {
      parts.push(literalTerms(query.slice(cursor, match.start)));
      parts.push(quote(replacements.get(match) ?? match.term));
      cursor = match.end;
    }
    parts.push(literalTerms(query.slice(cursor)));
    return parts.filter(Boolean).join(" ");
  }
  const variants = new Set([variant(new Map())]);
  // Include the combined expansion before the bounded single-substitution arms.
  variants.add(variant(new Map(matches.map(match => [match, match.alternatives[0]]))));
  for (const match of matches) {
    for (const alias of match.alternatives) {
      if (variants.size === MAX_VARIANTS) return [...variants].join(" OR ");
      variants.add(variant(new Map([[match, alias]])));
    }
  }
  return [...variants].join(" OR ");
}
