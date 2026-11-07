import type { SearchFilters } from "./filters.js";

/**
 * Strict translation of Algolia `filters`, `facetFilters` and `numericFilters`
 * into DocSlurp search filters.
 *
 * Callers often use these filters to scope results on their side, so anything
 * outside the supported subset is rejected instead of ignored: dropping a clause
 * would silently return broader results. Supported subset:
 *
 * - facet attributes `tags`, `mime_type`, `filename` (exact), `filenameContains`
 *   (literal substring), `language`,
 *   `heading`, `documentId`, `runId`, joined with AND;
 * - OR groups only across values of one `tags` or `mime_type` attribute, since
 *   DocSlurp matches any of the listed tags or MIME types;
 * - numeric comparisons and `TO` ranges on `page`, joined with AND.
 */
export class AlgoliaFilterError extends Error {
  readonly name = "AlgoliaFilterError";
  readonly code = "UNSUPPORTED_SEARCH_OPTION";
}

type FacetAttribute = "tags" | "mime_type" | "filename" | "filenameContains" | "language" | "heading" | "documentId" | "runId";

const facetAliases = new Map<string, FacetAttribute>(Object.entries({
  tag: "tags",
  tags: "tags",
  mime_type: "mime_type",
  mimeType: "mime_type",
  filename: "filename",
  filenameContains: "filenameContains",
  language: "language",
  heading: "heading",
  documentId: "documentId",
  runId: "runId",
} satisfies Record<string, FacetAttribute>));
const numericAliases = new Set(["page", "pageNumber", "page_number"]);
const anyOfAttributes = new Set<FacetAttribute>(["tags", "mime_type"]);

const SUPPORTED_HINT = "Supported: tags, mime_type, filename (exact), filenameContains (substring), language, heading, documentId and runId facet clauses joined with AND (OR only between values of one tags or mime_type attribute), and page numeric comparisons.";

/** Request fields the compatibility routes apply themselves. `type` must be "default". */
const supportedParams = [
  "query", "page", "hitsPerPage", "filters", "facetFilters", "numericFilters", "facets",
  "attributesToRetrieve", "highlightPreTag", "highlightPostTag", "facetQuery", "maxFacetHits", "type",
];

/**
 * Algolia parameters accepted with any value and ignored: they only affect
 * ranking order, highlighting, facet counts or analytics, never which hits match.
 */
const rankingOnlyParams = [
  "analytics", "analyticsTags", "clickAnalytics", "getRankingInfo", "enablePersonalization",
  "personalizationImpact", "userToken", "enableABTest", "enableReRanking", "percentileComputation",
  "attributesToHighlight", "attributesToSnippet", "snippetEllipsisText", "restrictHighlightAndSnippetArrays",
  "responseFields", "maxValuesPerFacet", "sortFacetValuesBy", "facetingAfterDistinct",
  "optionalFilters", "sumOrFiltersScores", "aroundPrecision",
];

/**
 * Query-matching parameters that change how many hits match. DocSlurp does not
 * apply them, so only Algolia's default or a more permissive value is accepted
 * (ignoring those can only return fewer matches); a restrictive value, which
 * ignoring would widen, is rejected.
 */
const permissiveOnlyParams: Record<string, (value: unknown) => boolean> = {
  typoTolerance: (value) => value === true || value === "true",
  allowTyposOnNumericTokens: (value) => value === true,
  decompoundQuery: (value) => value === true,
  minWordSizefor1Typo: (value) => typeof value === "number" && value <= 4,
  minWordSizefor2Typos: (value) => typeof value === "number" && value <= 8,
  // Plural and stop-word handling only make more words optional or equivalent.
  ignorePlurals: (value) => typeof value === "boolean" || isStringArray(value),
  removeStopWords: (value) => typeof value === "boolean" || isStringArray(value),
  queryLanguages: isStringArray,
  naturalLanguages: isStringArray,
};

function isStringArray(value: unknown) {
  return Array.isArray(value) && value.length <= 100 && value.every((entry) => typeof entry === "string");
}

/**
 * Algolia parameters that narrow results (or select Algolia-only behaviour) and
 * that DocSlurp cannot apply. Accepted only when empty or off, which InstantSearch
 * sends by default (`tagFilters: ""`, `aroundLatLngViaIP: false`).
 */
const emptyOnlyParams = [
  "tagFilters", "aroundLatLng", "aroundLatLngViaIP", "aroundRadius", "minimumAroundRadius",
  "insideBoundingBox", "insidePolygon", "restrictSearchableAttributes", "ruleContexts", "enableRules",
  "keepDiacriticsOnCharacters", "params",
];

const allowedParams = new Set([...supportedParams, ...rankingOnlyParams, ...Object.keys(permissiveOnlyParams), ...emptyOnlyParams]);

/** Algolia filter arrays nest at most two levels (AND of OR groups). */
const MAX_PARAM_DEPTH = 2;
/** Postgres/filesystem filenames are at most 255 characters. */
const MAX_FILENAME_LENGTH = 255;

/** Bounds keep filter parsing cheap for browser keys before any project lookup. */
const MAX_FILTERS_BYTES = 8 * 1024;
const MAX_CLAUSE_LENGTH = 1024;
const MAX_CLAUSES = 100;
const MAX_FILTER_ARRAY_ENTRIES = 100;

type FacetAtom = { kind: "facet"; attribute: FacetAttribute; value: string; source: string };
type NumericAtom = { kind: "numeric"; from?: number; to?: number; source: string };
type Atom = FacetAtom | NumericAtom;

function fail(message: string): never {
  throw new AlgoliaFilterError(message);
}

function describe(clause: string) {
  return JSON.stringify(clause.length > 200 ? `${clause.slice(0, 200)}…` : clause);
}

// Postgres page_number is int4; larger bounds would fail the query instead of filtering.
const MAX_PAGE = 2_147_483_647;

function parseInteger(raw: string, clause: string) {
  if (raw.length > 12 || !/^-?\d+$/.test(raw)) fail(`Unsupported numeric filter ${describe(clause)}: page values must be integers.`);
  return checkPage(Number(raw), clause);
}

function checkPage(value: number, clause: string) {
  if (!Number.isSafeInteger(value) || value < -MAX_PAGE || value > MAX_PAGE) fail(`Unsupported numeric filter ${describe(clause)}: page value is out of range.`);
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

const IDENTIFIER = /^[A-Za-z_][\w.]*$/;
const OPERATOR_CHARS = new Set(["<", ">", "=", "!"]);

/**
 * Split a clause into its attribute and the rest, at the first ":" or comparison
 * operator, by scanning once. No regex runs over the raw clause (an unanchored
 * whitespace run made the former pattern backtrack quadratically).
 */
function splitClause(clause: string): { attribute: string; operator: string; rest: string } | null {
  let index = 0;
  let attribute: string;
  if (clause[0] === "\"") {
    const close = clause.indexOf("\"", 1);
    if (close < 0) return null;
    attribute = clause.slice(1, close);
    index = close + 1;
  } else {
    while (index < clause.length && clause[index] !== ":" && !OPERATOR_CHARS.has(clause[index]!) && !/\s/.test(clause[index]!)) index++;
    attribute = clause.slice(0, index);
  }
  while (index < clause.length && /\s/.test(clause[index]!)) index++;
  const char = clause[index];
  if (char === ":") return { attribute, operator: ":", rest: clause.slice(index + 1).trim() };
  if (char !== undefined && OPERATOR_CHARS.has(char)) {
    const operator = clause[index + 1] === "=" ? `${char}=` : char;
    return { attribute, operator, rest: clause.slice(index + operator.length).trim() };
  }
  return null;
}

/** `page>=3`, `page = 3`, `page:3`, `page:3 TO 5`. Returns null for a facet clause. */
function parseNumericAtom(clause: string): NumericAtom | null {
  const parts = splitClause(clause.trim());
  if (!parts) return null;
  const { attribute, operator, rest } = parts;
  if (operator === ":") {
    if (!numericAliases.has(attribute)) return null;
    const words = rest.split(/\s+/);
    if (words.length === 3 && words[1] === "TO") {
      return { kind: "numeric", from: parseInteger(words[0]!, clause), to: parseInteger(words[2]!, clause), source: clause };
    }
    if (words.length !== 1) fail(`Malformed numeric filter ${describe(clause)}: expected page:<n> or page:<from> TO <to>.`);
    const value = parseInteger(rest, clause);
    return { kind: "numeric", from: value, to: value, source: clause };
  }
  if (!IDENTIFIER.test(attribute) || !numericAliases.has(attribute)) {
    fail(`Unsupported numeric filter attribute ${describe(attribute)} in ${describe(clause)}. Only page supports numeric filters.`);
  }
  if (!["=", ">=", ">", "<=", "<"].includes(operator)) fail(`Unsupported numeric operator ${describe(operator)} in ${describe(clause)}.`);
  const value = parseInteger(rest, clause);
  if (operator === "=") return { kind: "numeric", from: value, to: value, source: clause };
  if (operator === ">=") return { kind: "numeric", from: value, source: clause };
  if (operator === ">") return { kind: "numeric", from: checkPage(value + 1, clause), source: clause };
  if (operator === "<=") return { kind: "numeric", to: value, source: clause };
  return { kind: "numeric", to: checkPage(value - 1, clause), source: clause };
}

function parseFacetAtom(clause: string, options: { facetFilterNegation: boolean }): FacetAtom {
  const index = clause.indexOf(":");
  if (index < 0) fail(`Malformed filter ${describe(clause)}: expected attribute:value. ${SUPPORTED_HINT}`);
  const attributeName = stripAttributeQuotes(clause.slice(0, index));
  const attribute = facetAliases.get(attributeName);
  if (!attribute) {
    fail(`Unsupported filter attribute ${describe(attributeName)} in ${describe(clause)}. ${SUPPORTED_HINT}`);
  }
  let value = unquoteValue(clause.slice(index + 1), clause);
  if (options.facetFilterNegation) {
    // Algolia facetFilters negate with a leading "-"; "\-" escapes a literal one.
    if (value.startsWith("-")) fail(`Unsupported negated filter ${describe(clause)}: negation is not supported.`);
    if (value.startsWith("\\-")) value = value.slice(1);
  }
  if (!value) fail(`Malformed filter ${describe(clause)}: empty value.`);
  if ((attribute === "filename" || attribute === "filenameContains") && value.length > MAX_FILENAME_LENGTH) {
    fail(`Filter ${describe(clause)}: ${attribute} values are at most ${MAX_FILENAME_LENGTH} characters.`);
  }
  return { kind: "facet", attribute, value, source: clause };
}

function parseAtom(clause: string, options: { facetFilterNegation: boolean }): Atom {
  checkClauseLength(clause);
  const trimmed = clause.trim();
  if (!trimmed) fail("Malformed filter: empty clause.");
  return parseNumericAtom(trimmed) ?? parseFacetAtom(trimmed, options);
}

function checkClauseLength(clause: string) {
  if (clause.length > MAX_CLAUSE_LENGTH) fail(`Filter clause ${describe(clause)} exceeds ${MAX_CLAUSE_LENGTH} characters.`);
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
  if (Buffer.byteLength(input, "utf8") > MAX_FILTERS_BYTES) fail(`filters exceeds ${MAX_FILTERS_BYTES} bytes.`);
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
    checkClauseLength(clause);
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
    if (token.type !== "and") fail(`Malformed filters ${describe(input)}: unexpected ${token.type === "word" ? describe(token.text) : token.type === "rparen" ? "\")\"" : "\"(\""}.`);
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
    checkClauseLength(entry);
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
  if (value.length > MAX_FILTER_ARRAY_ENTRIES) fail(`${name} accepts at most ${MAX_FILTER_ARRAY_ENTRIES} entries.`);
  const total = value.reduce<number>((sum, entry) => sum + (Array.isArray(entry) ? entry.length : 1), 0);
  if (total > MAX_CLAUSES) fail(`Filters accept at most ${MAX_CLAUSES} clauses in total.`);
  return value.map((entry) => {
    if (Array.isArray(entry)) {
      if (entry.length > MAX_FILTER_ARRAY_ENTRIES) fail(`${name} OR groups accept at most ${MAX_FILTER_ARRAY_ENTRIES} entries.`);
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
  // Algolia facet semantics: filename is an exact match; filenameContains is the explicit substring form.
  if (value("filename")) filters.filenameEquals = value("filename")![0];
  if (value("filenameContains")) filters.filenameContains = value("filenameContains")![0];
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

function isEmptyParam(name: string, value: unknown, depth = 0): boolean {
  if (value === undefined || value === null || value === false || value === "") return true;
  if (!Array.isArray(value)) return false;
  // tagFilters [[]], [""] and [[""]] carry no constraint; deeper nesting is not Algolia syntax.
  if (depth >= MAX_PARAM_DEPTH) fail(`Malformed ${name}: arrays nest at most ${MAX_PARAM_DEPTH} levels.`);
  return value.every((entry) => isEmptyParam(name, entry, depth + 1));
}

/**
 * Translate the filter parameters of one Algolia request, or throw
 * `AlgoliaFilterError` naming the first unsupported clause or parameter. Unknown
 * keys are rejected too: a misspelled `facetfilters` must not silently widen results.
 */
export function parseAlgoliaCompatFilters(body: Record<string, unknown>, extraAllowed: readonly string[] = []): SearchFilters {
  for (const key of Object.keys(body)) {
    if (!allowedParams.has(key) && !extraAllowed.includes(key)) {
      fail(`Unsupported search parameter ${describe(key)}: DocSlurp cannot apply it. Parameters that could change which results match are rejected rather than ignored.`);
    }
  }
  for (const param of emptyOnlyParams) {
    if (!isEmptyParam(param, body[param])) {
      fail(param === "params"
        ? "The URL-encoded params string is not supported; send search parameters as JSON fields."
        : `${param} is not supported: it changes which results match and DocSlurp cannot apply it. ${SUPPORTED_HINT}`);
    }
  }
  for (const [param, permissive] of Object.entries(permissiveOnlyParams)) {
    if (body[param] !== undefined && !permissive(body[param])) {
      fail(`${param}=${describe(JSON.stringify(body[param]) ?? "")} is not supported: it restricts which results match and DocSlurp cannot apply it. Omit it or use Algolia's default.`);
    }
  }
  if (body.type !== undefined && body.type !== "default") fail(`Unsupported request type ${describe(String(body.type))}: use the facet search route for facet values.`);
  if (body.filters !== undefined && body.filters !== null && typeof body.filters !== "string") fail("Malformed filters: expected a string.");
  const groups = [
    ...(typeof body.filters === "string" ? parseFiltersString(body.filters) : []),
    ...parseFilterArray("facetFilters", body.facetFilters, false),
    ...parseFilterArray("numericFilters", body.numericFilters, true),
  ];
  const clauses = groups.reduce((total, group) => total + group.length, 0);
  if (clauses > MAX_CLAUSES) fail(`Filters accept at most ${MAX_CLAUSES} clauses in total.`);
  return combine(groups);
}
