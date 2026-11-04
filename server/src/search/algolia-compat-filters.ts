import type { SearchFilters } from "./filters.js";

/**
 * Strict translation of Algolia `filters`, `facetFilters` and `numericFilters`
 * into DocSlurp search filters.
 *
 * Callers often use these filters to scope results on their side, so anything
 * outside the supported subset is rejected instead of ignored: dropping a clause
 * would silently return broader results. Supported subset:
 *
 * - facet attributes `tags`, `mime_type`, `filename` (substring), `language`,
 *   `heading`, `documentId`, `runId`, joined with AND;
 * - OR groups only across values of one `tags` or `mime_type` attribute, since
 *   DocSlurp matches any of the listed tags or MIME types;
 * - numeric comparisons and `TO` ranges on `page`, joined with AND.
 */
export class AlgoliaFilterError extends Error {
  readonly name = "AlgoliaFilterError";
  readonly code = "UNSUPPORTED_SEARCH_OPTION";
}

type FacetAttribute = "tags" | "mime_type" | "filename" | "language" | "heading" | "documentId" | "runId";

const facetAliases = new Map<string, FacetAttribute>(Object.entries({
  tag: "tags",
  tags: "tags",
  mime_type: "mime_type",
  mimeType: "mime_type",
  filename: "filename",
  filenameContains: "filename",
  language: "language",
  heading: "heading",
  documentId: "documentId",
  runId: "runId",
} satisfies Record<string, FacetAttribute>));
const numericAliases = new Set(["page", "pageNumber", "page_number"]);
const anyOfAttributes = new Set<FacetAttribute>(["tags", "mime_type"]);

const SUPPORTED_HINT = "Supported: tags, mime_type, filename, language, heading, documentId and runId facet clauses joined with AND (OR only between values of one tags or mime_type attribute), and page numeric comparisons.";

/** Algolia search parameters that narrow result scope but have no DocSlurp equivalent. */
const unsupportedScopeParams = [
  "tagFilters",
  "aroundLatLng",
  "aroundLatLngViaIP",
  "aroundRadius",
  "minimumAroundRadius",
  "insideBoundingBox",
  "insidePolygon",
  "restrictSearchableAttributes",
  "params",
] as const;

type FacetAtom = { kind: "facet"; attribute: FacetAttribute; value: string; source: string };
type NumericAtom = { kind: "numeric"; from?: number; to?: number; source: string };
type Atom = FacetAtom | NumericAtom;

function fail(message: string): never {
  throw new AlgoliaFilterError(message);
}

function describe(clause: string) {
  return JSON.stringify(clause.length > 200 ? `${clause.slice(0, 200)}…` : clause);
}

function parseInteger(raw: string, clause: string) {
  if (!/^-?\d+$/.test(raw)) fail(`Unsupported numeric filter ${describe(clause)}: page values must be integers.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`Unsupported numeric filter ${describe(clause)}: page value is out of range.`);
  return value;
}

function stripAttributeQuotes(raw: string) {
  const trimmed = raw.trim();
  return trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"") ? trimmed.slice(1, -1) : trimmed;
}

function unquoteValue(raw: string, clause: string) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("\"")) {
    if (trimmed.length < 2 || !trimmed.endsWith("\"")) fail(`Malformed filter ${describe(clause)}: unterminated quote.`);
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (trimmed.includes("\"")) fail(`Malformed filter ${describe(clause)}: unexpected quote.`);
  return trimmed;
}

/** `page>=3`, `page = 3`, `page:3`, `page:3 TO 5`. */
function parseNumericAtom(clause: string): NumericAtom | null {
  const comparison = clause.match(/^\s*("?)([A-Za-z_][\w.]*)\1\s*(<=|>=|!=|=|<|>)\s*(\S+)\s*$/);
  if (comparison) {
    const [, , attribute, operator, raw] = comparison as unknown as [string, string, string, string, string];
    if (!numericAliases.has(attribute)) fail(`Unsupported numeric filter attribute ${JSON.stringify(attribute)} in ${describe(clause)}. Only page supports numeric filters.`);
    const value = parseInteger(raw, clause);
    if (operator === "=") return { kind: "numeric", from: value, to: value, source: clause };
    if (operator === ">=") return { kind: "numeric", from: value, source: clause };
    if (operator === ">") return { kind: "numeric", from: value + 1, source: clause };
    if (operator === "<=") return { kind: "numeric", to: value, source: clause };
    if (operator === "<") return { kind: "numeric", to: value - 1, source: clause };
    fail(`Unsupported numeric operator ${JSON.stringify(operator)} in ${describe(clause)}.`);
  }
  const colon = clause.match(/^\s*("?)([A-Za-z_][\w.]*)\1\s*:\s*(.+?)\s*$/);
  if (!colon || !numericAliases.has(colon[2]!)) return null;
  const range = colon[3]!.match(/^(\S+)\s+TO\s+(\S+)$/);
  if (range) {
    const from = parseInteger(range[1]!, clause);
    const to = parseInteger(range[2]!, clause);
    return { kind: "numeric", from, to, source: clause };
  }
  const value = parseInteger(colon[3]!, clause);
  return { kind: "numeric", from: value, to: value, source: clause };
}

function parseFacetAtom(clause: string, options: { facetFilterNegation: boolean }): FacetAtom {
  const index = clause.indexOf(":");
  if (index < 0) fail(`Malformed filter ${describe(clause)}: expected attribute:value. ${SUPPORTED_HINT}`);
  const attributeName = stripAttributeQuotes(clause.slice(0, index));
  const attribute = facetAliases.get(attributeName);
  if (!attribute) {
    fail(`Unsupported filter attribute ${JSON.stringify(attributeName)} in ${describe(clause)}. ${SUPPORTED_HINT}`);
  }
  let value = unquoteValue(clause.slice(index + 1), clause);
  if (options.facetFilterNegation) {
    // Algolia facetFilters negate with a leading "-"; "\-" escapes a literal one.
    if (value.startsWith("-")) fail(`Unsupported negated filter ${describe(clause)}: negation is not supported.`);
    if (value.startsWith("\\-")) value = value.slice(1);
  }
  if (!value) fail(`Malformed filter ${describe(clause)}: empty value.`);
  return { kind: "facet", attribute, value, source: clause };
}

function parseAtom(clause: string, options: { facetFilterNegation: boolean }): Atom {
  const trimmed = clause.trim();
  if (!trimmed) fail("Malformed filter: empty clause.");
  return parseNumericAtom(trimmed) ?? parseFacetAtom(trimmed, options);
}

type Token = { type: "lparen" | "rparen" | "and" | "or" | "not" } | { type: "word"; text: string };

/** Split a `filters` string on whitespace and parentheses outside double quotes. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let inQuote = false;
  const flush = () => {
    if (!current) return;
    const keyword = current.toUpperCase();
    if (keyword === "AND") tokens.push({ type: "and" });
    else if (keyword === "OR") tokens.push({ type: "or" });
    else if (keyword === "NOT") tokens.push({ type: "not" });
    else tokens.push({ type: "word", text: current });
    current = "";
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (inQuote) {
      current += char;
      if (char === "\\" && i + 1 < input.length) current += input[++i]!;
      else if (char === "\"") inQuote = false;
      continue;
    }
    if (char === "\"") { inQuote = true; current += char; continue; }
    if (/\s/.test(char)) { flush(); continue; }
    if (char === "(" || char === ")") { flush(); tokens.push({ type: char === "(" ? "lparen" : "rparen" }); continue; }
    current += char;
  }
  if (inQuote) fail(`Malformed filters ${describe(input)}: unterminated quote.`);
  flush();
  return tokens;
}

/**
 * Parse the `filters` string: AND-joined groups, where a group is one clause or a
 * parenthesized OR of clauses. NOT, nested parentheses and AND/OR mixed at the top
 * level are rejected.
 */
function parseFiltersString(input: string): Atom[][] {
  const tokens = tokenize(input);
  if (!tokens.length) return [];
  if (tokens.some(token => token.type === "not")) fail(`Unsupported filter operator NOT in ${describe(input)}: negation is not supported.`);

  const groups: Atom[][] = [];
  let index = 0;
  const readClause = () => {
    const words: string[] = [];
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token.type !== "word") break;
      words.push(token.text);
      index++;
    }
    if (!words.length) fail(`Malformed filters ${describe(input)}: expected a clause.`);
    const clause = words.join(" ");
    if (words.length > 1) {
      // Only numeric clauses ("page > 3", "page:1 TO 5") span several words.
      const numeric = parseNumericAtom(clause);
      if (!numeric) fail(`Malformed filter ${describe(clause)}: quote values that contain spaces and join clauses with AND or OR.`);
      return numeric;
    }
    return parseAtom(clause, { facetFilterNegation: false });
  };
  const readGroup = (): Atom[] => {
    const token = tokens[index];
    if (token?.type === "lparen") {
      index++;
      const group = [readClause()];
      while (tokens[index]?.type === "or") { index++; group.push(readClause()); }
      const close = tokens[index];
      if (close?.type === "and") fail(`Unsupported filters ${describe(input)}: AND inside parentheses is not supported.`);
      if (close?.type !== "rparen") fail(`Malformed filters ${describe(input)}: expected ")".`);
      index++;
      return group;
    }
    return [readClause()];
  };

  const first = readGroup();
  if (tokens[index]?.type === "or") {
    // A top-level OR without parentheses must not be mixed with AND.
    const group = [...first];
    while (tokens[index]?.type === "or") {
      index++;
      if (tokens[index]?.type === "lparen") fail(`Unsupported filters ${describe(input)}: nested OR groups are not supported.`);
      group.push(readClause());
    }
    if (index < tokens.length) fail(`Unsupported filters ${describe(input)}: combine AND and OR with parentheses, for example "language:en AND (tags:a OR tags:b)".`);
    groups.push(group);
    return groups;
  }
  groups.push(first);
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.type === "or") fail(`Unsupported filters ${describe(input)}: combine AND and OR with parentheses, for example "language:en AND (tags:a OR tags:b)".`);
    if (token.type !== "and") fail(`Malformed filters ${describe(input)}: unexpected ${token.type === "word" ? JSON.stringify(token.text) : token.type === "rparen" ? "\")\"" : "\"(\""}.`);
    index++;
    groups.push(readGroup());
  }
  return groups;
}

/**
 * Parse `facetFilters`/`numericFilters`: an array of clauses (AND), where an entry
 * may itself be an array (OR). A string is a single clause.
 */
function parseFilterArray(name: string, value: unknown, numeric: boolean): Atom[][] {
  if (value === undefined || value === null) return [];
  const parse = (entry: unknown): Atom => {
    if (typeof entry !== "string") fail(`Malformed ${name}: every clause must be a string.`);
    if (numeric) {
      const atom = parseNumericAtom(entry.trim());
      if (!atom) fail(`Unsupported numeric filter ${describe(entry)}. Only page supports numeric filters.`);
      return atom;
    }
    return parseAtom(entry, { facetFilterNegation: true });
  };
  if (typeof value === "string") {
    if (!value.trim()) return [];
    if (/[(),]/.test(value)) fail(`Unsupported ${name} string ${describe(value)}: send an array of clauses instead of the legacy comma syntax.`);
    return [[parse(value)]];
  }
  if (!Array.isArray(value)) fail(`Malformed ${name}: expected an array of clauses.`);
  return value.map((entry) => {
    if (Array.isArray(entry)) {
      if (!entry.length) fail(`Malformed ${name}: an OR group must not be empty.`);
      return entry.map(parse);
    }
    return [parse(entry)];
  });
}

function sameValues(left: string[], right: string[]) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function combine(groups: Atom[][]): SearchFilters {
  const facets = new Map<FacetAttribute, { values: string[]; source: string }>();
  let pageFrom: number | undefined;
  let pageTo: number | undefined;

  for (const group of groups) {
    const first = group[0]!;
    if (group.length > 1) {
      const sources = group.map(atom => atom.source).join(" OR ");
      if (group.some(atom => atom.kind === "numeric")) fail(`Unsupported OR group ${describe(sources)}: page filters cannot be combined with OR.`);
      const attribute = (first as FacetAtom).attribute;
      if (!anyOfAttributes.has(attribute) || group.some(atom => (atom as FacetAtom).attribute !== attribute)) {
        fail(`Unsupported OR group ${describe(sources)}: OR is only supported between values of one tags or mime_type attribute.`);
      }
    }
    if (first.kind === "numeric") {
      if (first.from !== undefined) pageFrom = pageFrom === undefined ? first.from : Math.max(pageFrom, first.from);
      if (first.to !== undefined) pageTo = pageTo === undefined ? first.to : Math.min(pageTo, first.to);
      continue;
    }
    const attribute = first.attribute;
    const values = group.map(atom => (atom as FacetAtom).value);
    const existing = facets.get(attribute);
    if (existing && !sameValues(existing.values, values)) {
      fail(anyOfAttributes.has(attribute)
        ? `Unsupported filter ${describe(group.map(atom => atom.source).join(" OR "))}: ${attribute} may appear in only one AND clause because DocSlurp matches any of the listed values. Use one OR group, for example "(${attribute}:a OR ${attribute}:b)".`
        : `Unsupported filter ${describe(group[0]!.source)}: ${attribute} may only be filtered by one value (already ${describe(existing.source)}).`);
    }
    facets.set(attribute, { values: [...new Set(values)], source: existing?.source ?? first.source });
  }

  const filters: SearchFilters = {};
  const value = (attribute: FacetAttribute) => facets.get(attribute)?.values;
  if (value("tags")) filters.tags = value("tags");
  if (value("mime_type")) filters.mimeTypes = value("mime_type");
  if (value("filename")) filters.filenameContains = value("filename")![0];
  if (value("language")) filters.language = value("language")![0];
  if (value("documentId")) filters.documentId = value("documentId")![0];
  if (value("runId")) filters.runId = value("runId")![0];
  if (value("heading")) {
    const headingPath = value("heading")![0]!.split("/").filter(Boolean);
    if (!headingPath.length) fail(`Malformed filter ${describe(facets.get("heading")!.source)}: empty heading path.`);
    filters.headingPath = headingPath;
  }
  if (pageFrom !== undefined || pageTo !== undefined) filters.pageRange = { from: pageFrom, to: pageTo };
  return filters;
}

function isEmptyParam(value: unknown) {
  return value === undefined || value === null || value === false || value === "" || (Array.isArray(value) && value.length === 0);
}

/**
 * Translate the filter parameters of one Algolia request, or throw
 * `AlgoliaFilterError` naming the first unsupported clause or parameter.
 */
export function parseAlgoliaCompatFilters(body: Record<string, unknown>): SearchFilters {
  for (const param of unsupportedScopeParams) {
    if (!isEmptyParam(body[param])) {
      fail(param === "params"
        ? "The URL-encoded params string is not supported; send search parameters as JSON fields."
        : `${param} is not supported: it narrows results and DocSlurp cannot apply it. ${SUPPORTED_HINT}`);
    }
  }
  if (body.filters !== undefined && body.filters !== null && typeof body.filters !== "string") fail("Malformed filters: expected a string.");
  const groups = [
    ...(typeof body.filters === "string" ? parseFiltersString(body.filters) : []),
    ...parseFilterArray("facetFilters", body.facetFilters, false),
    ...parseFilterArray("numericFilters", body.numericFilters, true),
  ];
  return combine(groups);
}
