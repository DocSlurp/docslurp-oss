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
  language?: string;
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

function mergePageRange(
  left: SearchFilters["pageRange"],
  right: SearchFilters["pageRange"],
): SearchFilters["pageRange"] | undefined {
  if (!left && !right) {
    return undefined;
  }

  return {
    from: right?.from ?? left?.from,
    to: right?.to ?? left?.to,
  };
}

function mergeFilters(
  base: SearchFilters | undefined,
  derived: SearchFilters,
): SearchFilters {
  return {
    ...base,
    ...derived,
    documentIds: base?.documentIds !== undefined
      ? base.documentIds
      : derived.documentIds,
    tags: base?.tags?.length ? base.tags : derived.tags,
    mimeTypes: uniqueStrings([
      ...(base?.mimeTypes ?? []),
      ...(derived.mimeTypes ?? []),
    ]),
    pageRange: mergePageRange(base?.pageRange, derived.pageRange),
  };
}

function mimeTypesForQuery(query: string): string[] {
  const normalized = query.toLowerCase();
  const matches: string[] = [];

  if (/\b(slide|slides|deck|powerpoint|pptx?)\b/.test(normalized)) {
    matches.push(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  }
  if (/\b(sheet|spreadsheet|xlsx?|csv|tsv)\b/.test(normalized)) {
    matches.push(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
      "text/tab-separated-values",
    );
  }
  if (/\b(pdf|scan|scanned)\b/.test(normalized)) {
    matches.push("application/pdf");
  }
  if (/\b(image|png|jpeg|jpg|tiff|photo)\b/.test(normalized)) {
    matches.push("image/png", "image/jpeg", "image/tiff");
  }
  if (/\b(json|jsonl)\b/.test(normalized)) {
    matches.push("application/json", "application/x-ndjson");
  }

  return uniqueStrings(matches);
}

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
    /\b(?:page|pages|slide|slides)\s+(\d+)(?:\s*[-–to]+\s*(\d+))?/i,
  );
  if (pageRange) {
    const from = Number(pageRange[1]);
    const to = Number(pageRange[2] ?? pageRange[1]);
    if (Number.isFinite(from)) {
      filters.pageRange = {
        from,
        to: Number.isFinite(to) ? to : from,
      };
      reasons.push(
        `Scoped retrieval to page range ${from}${to !== from ? `-${to}` : ""}.`,
      );
    }
  }

  const quotedDocument = query.match(/["“](.+?)["”]/);
  if (quotedDocument?.[1]) {
    filters.filenameContains = quotedDocument[1];
    reasons.push(`Detected quoted document reference "${quotedDocument[1]}".`);
  } else {
    const namedDocument = query.match(
      /\bin\s+the\s+([a-z0-9][a-z0-9 ._-]{2,80}?)(?:,|\?|$)/i,
    );
    if (namedDocument?.[1]) {
      const candidate = namedDocument[1].trim();
      if (!/\b(page|pages|slide|slides|section)\b/i.test(candidate)) {
        filters.filenameContains = candidate;
        reasons.push(`Detected document title hint "${candidate}".`);
      }
    }
  }

  const mimeTypes = mimeTypesForQuery(query);
  if (mimeTypes.length > 0) {
    filters.mimeTypes = mimeTypes;
    reasons.push(
      "Detected document-type terms and converted them into MIME filters.",
    );
  }

  const language = query.match(
    /\b(in|translated to)\s+(english|spanish|french|german|portuguese|italian|japanese|chinese)\b/i,
  );
  if (language?.[2]) {
    filters.language = language[2].toLowerCase();
    reasons.push(`Detected language hint "${filters.language}".`);
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
    if (parsed.language) {
      filters.language = parsed.language;
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
          "Allowed keys: filenameContains, mimeTypes, pageFrom, pageTo, language, heading, dateFrom, dateTo, reasons.",
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
        derived = mergeFilters(derived, parsed.filters);
        reasons.push(...parsed.reasons);
      }
    } catch {
      // Best-effort only. Heuristics remain active if the model call fails.
    }
  }

  return {
    filters: mergeFilters(args.baseFilters, derived),
    reasons: uniqueStrings(reasons),
  };
}
