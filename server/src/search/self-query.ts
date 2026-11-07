import { InvalidRetrievalQueryError } from "../lib/retrieval-query-flags.js";
import type { PrivacyMode } from "@docslurp/shared";
import { SEARCH_OPENROUTER_MODEL, generateOpenRouterText } from "../lib/ai.js";
import type { UsageRecorder } from "../lib/ai-usage.js";
import type { SearchFilters } from "./filters.js";

/** Consume explicit tag syntax once, before any retrieval or derived prompts. */
export function parseSelfQuerySyntax(query: string): { query: string; tags: string[] } {
  const tags: string[] = [];
  const naturalLanguage = query.replace(/(^|\s)tag:("[^"\n]*"[^\s]*|[^\s]*)/g, (_token, space: string, value: string) => {
    const tag = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).trim() : value;
    if (!tag || tag.length > 100 || /[\u0000,"]/.test(tag)) {
      throw new InvalidRetrievalQueryError("tag: requires a label of 1 to 100 characters; quote labels containing spaces");
    }
    tags.push(tag);
    return space;
  }).replace(/\s+/g, " ").trim();
  if (tags.length > 24) throw new InvalidRetrievalQueryError("At most 24 tag: labels are allowed");
  if (tags.length && !naturalLanguage) {
    throw new InvalidRetrievalQueryError("Include search text alongside tag: labels");
  }
  return { query: tags.length ? naturalLanguage : query, tags: uniqueStrings(tags) };
}

type SelfQueryPlan = {
  filters: SearchFilters;
  reasons: string[];
};

type SelfQueryModelResponse = {
  filenameContains?: string;
  mimeTypes?: string[];
  pageFrom?: number;
  pageTo?: number;
  heading?: string;
  dateFrom?: string;
  dateTo?: string;
  reasons?: string[];
};

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function intersectPageRange(
  base: SearchFilters["pageRange"],
  derived: SearchFilters["pageRange"],
): SearchFilters["pageRange"] | undefined {
  if (!base) return derived;
  if (!derived) return base;
  const from = Math.max(base.from ?? -Infinity, derived.from ?? -Infinity);
  const to = Math.min(base.to ?? Infinity, derived.to ?? Infinity);
  // Disjoint ranges: the derived hint cannot override the caller's, so the caller's stands.
  if (from > to) return base;
  return { ...(Number.isFinite(from) ? { from } : {}), ...(Number.isFinite(to) ? { to } : {}) };
}

function intersectDateRange(
  base: SearchFilters["dateRange"],
  derived: SearchFilters["dateRange"],
): SearchFilters["dateRange"] | undefined {
  if (!base) return derived;
  if (!derived) return base;
  const later = (a?: string, b?: string) => (a && b ? (a > b ? a : b) : a ?? b);
  const earlier = (a?: string, b?: string) => (a && b ? (a < b ? a : b) : a ?? b);
  const from = later(base.from, derived.from);
  const to = earlier(base.to, derived.to);
  if (from && to && from > to) return base;
  return { from, to };
}

/**
 * Apply derived filters to the caller's. Derived filters (explicit `tag:` syntax, page numbers, a model's reading
 * of the query) may only narrow: every scope the caller set (documents, run, project, geo, filename, tags) is
 * kept exactly, and for the filters that have values on both sides the result is the intersection, never a union.
 * A derived value that would leave nothing (disjoint types or pages) is dropped, so a misreading can
 * neither widen the search nor empty it.
 */
export function narrowFilters(
  base: SearchFilters | undefined,
  derived: SearchFilters,
): SearchFilters {
  const merged: SearchFilters = { ...(base ?? {}) };
  if (!base?.tags?.length && derived.tags?.length) merged.tags = derived.tags;
  if (base?.filenameContains === undefined && base?.filenameEquals === undefined && derived.filenameContains) {
    merged.filenameContains = derived.filenameContains;
  }
  if (derived.mimeTypes?.length) {
    if (!base?.mimeTypes?.length) merged.mimeTypes = derived.mimeTypes;
    else {
      const allowed = new Set(base.mimeTypes);
      const overlap = derived.mimeTypes.filter((type) => allowed.has(type));
      if (overlap.length > 0) merged.mimeTypes = overlap;
    }
  }
  const pageRange = intersectPageRange(base?.pageRange, derived.pageRange);
  if (pageRange) merged.pageRange = pageRange;
  const dateRange = intersectDateRange(base?.dateRange, derived.dateRange);
  if (dateRange) merged.dateRange = dateRange;
  if (!base?.headingPath?.length && derived.headingPath?.length) merged.headingPath = derived.headingPath;
  return merged;
}

/**
 * Only structure the caller wrote is read without a model: explicit `tag:` labels and page numbers
 * ("page 4", "slides 3-5"). Document types, filenames and languages are not guessed from words
 * ("image sensor" is not a request for images; "in the meeting" is not a filename).
 */
function deriveHeuristicPlan(query: string): SelfQueryPlan {
  const filters: SearchFilters = {};
  const reasons: string[] = [];

  const syntax = parseSelfQuerySyntax(query);
  query = syntax.query;
  if (syntax.tags.length) {
    filters.tags = syntax.tags;
    reasons.push("Applied explicit tag: labels.");
  }

  const pageRange = query.match(
    /\b(?:page|pages|slide|slides)\s+(\d+)(?:\s*(?:[-–]|to)\s*(\d+))?/i,
  );
  if (pageRange) {
    const from = Number(pageRange[1]);
    const to = Number(pageRange[2] ?? pageRange[1]);
    if (Number.isFinite(from) && Number.isFinite(to) && from <= to) {
      filters.pageRange = { from, to };
      reasons.push(
        `Scoped retrieval to page range ${from}${to !== from ? `-${to}` : ""}.`,
      );
    }
  }

  return { filters, reasons };
}

function parseModelPlan(text: string): SelfQueryPlan | null {
  try {
    const parsed = JSON.parse(text) as SelfQueryModelResponse;
    const filters: SearchFilters = {};
    if (parsed.filenameContains) {
      filters.filenameContains = parsed.filenameContains;
    }
    if (parsed.mimeTypes?.length) {
      filters.mimeTypes = uniqueStrings(parsed.mimeTypes);
    }
    if (parsed.pageFrom || parsed.pageTo) {
      filters.pageRange = {
        from: parsed.pageFrom,
        to: parsed.pageTo,
      };
    }
    if (parsed.heading) {
      filters.headingPath = parsed.heading
        .split("/")
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (parsed.dateFrom || parsed.dateTo) {
      filters.dateRange = {
        from: parsed.dateFrom,
        to: parsed.dateTo,
      };
    }
    return {
      filters,
      reasons: parsed.reasons?.filter(Boolean) ?? [],
    };
  } catch {
    return null;
  }
}

export async function deriveSelfQueryFilters(args: {
  query: string;
  baseFilters?: SearchFilters;
  openRouterApiKey?: string | null;
  privacyMode: PrivacyMode;
  usage: UsageRecorder;
}): Promise<SelfQueryPlan> {
  const heuristic = deriveHeuristicPlan(args.query);
  const reasons = [...heuristic.reasons];
  let derived = heuristic.filters;

  if (args.openRouterApiKey) {
    try {
      const result = await generateOpenRouterText({
        operation: "api.search.self-query",
        apiKey: args.openRouterApiKey,
        privacyMode: args.privacyMode,
        model: SEARCH_OPENROUTER_MODEL,
        maxOutputTokens: 220,
        prompt: [
          "Extract only explicit metadata filters from the query and return pure JSON.",
          "Allowed keys: filenameContains, mimeTypes, pageFrom, pageTo, heading, dateFrom, dateTo, reasons.",
          "If a filter is not explicit, omit it.",
          `Query: ${parseSelfQuerySyntax(args.query).query}`,
        ].join("\n"),
      });
      // Record before parsing: tokens are spent even if the JSON is unusable.
      args.usage.record({
        provider: "openrouter",
        model: SEARCH_OPENROUTER_MODEL,
        metric: "self-query",
        ...result.usage,
      });
      const parsed = parseModelPlan(result.text.trim());
      if (parsed) {
        derived = narrowFilters(derived, parsed.filters);
        reasons.push(...parsed.reasons);
      }
    } catch {
      // Best-effort only. Heuristics remain active if the model call fails.
    }
  }

  return {
    filters: narrowFilters(args.baseFilters, derived),
    reasons: uniqueStrings(reasons),
  };
}
