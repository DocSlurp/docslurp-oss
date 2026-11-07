import { reportPublicError } from "../lib/public-errors.js";
import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { ProjectSearchSettings } from "@docslurp/shared";

import { sql } from "../db.js";
import {
  apiKeyHasAnyScope,
  assertServerApiKey,
  loadApiKeyScopedProject
} from "../lib/api-key-authorization.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { hybridSearch } from "../services/search.js";
import { cacheableApiKeyId, readCachedResponse, responseCacheTicket, searchResponseCacheTtlMs, storeResponse } from "../search/response-cache.js";
import { highlightMatches } from "../search/highlight.js";
import { currentRequestApiKeyId } from "../lib/request-context.js";
import type { ValidatedKey } from "../services/api-keys.js";
import type { SearchFilters } from "../search/filters.js";
import { AlgoliaFilterError, parseAlgoliaCompatFilters } from "../search/algolia-compat-filters.js";
import {
  getProjectSearchSettings,
  mutateProjectSearchSettingsForUser,
  userCanEditProjectSettings
} from "../services/search-controls.js";

const queryBodySchema = z.object({
  query: z.string().max(10_000).optional(),
  page: z.number().int().nonnegative().optional(),
  hitsPerPage: z.number().int().min(1).max(1000).optional(),
  // Type-checked by parseAlgoliaCompatFilters so every filter error shares one envelope.
  filters: z.unknown().optional(),
  facetFilters: z.unknown().optional(),
  numericFilters: z.unknown().optional(),
  attributesToRetrieve: z.array(z.string()).optional(),
  facets: z.array(z.string()).optional(),
  highlightPreTag: z.string().optional(),
  highlightPostTag: z.string().optional(),
}).passthrough();

/** Ranked passages retrieved per compat query, so counts describe a real window (the SDK search adapters use the same 100). */
const COMPAT_COUNT_WINDOW = 100;
const COMPAT_MAX_FETCH = 1000;

/** The window covers the requested page plus one passage, and at least COMPAT_COUNT_WINDOW passages. */
function compatFetchLimit(pageStart: number, hitsPerPage: number): number {
  return Math.max(1, Math.min(COMPAT_MAX_FETCH, Math.max(COMPAT_COUNT_WINDOW, pageStart + hitsPerPage + 1)));
}

/**
 * nbHits is the number of passages found in the retrieved window. A window that came back full may have more
 * beyond it, so the count is only a floor and `exhaustive` is false; a short window is the whole result set.
 */
function compatHitCount(found: number, fetchLimit: number): { nbHits: number; exhaustive: boolean } {
  return { nbHits: found, exhaustive: found < fetchLimit };
}

const batchQuerySchema = z.object({
  requests: z.array(queryBodySchema.extend({ indexName: z.string().min(1) })).max(10),
});

const facetQuerySchema = queryBodySchema.pick({ query: true, filters: true, facetFilters: true, numericFilters: true }).extend({
  facetQuery: z.string().max(10_000).optional(),
  maxFacetHits: z.number().int().min(1).max(100).optional(),
}).passthrough();

// Keep batched queries as predictable and inexpensive as single-index queries.
const compatRetrievalOptions = {
  parentRetrieval: false,
  summarySeed: false,
  useContextualCompression: false,
  useHyDE: false,
  useMmr: false,
  useRerank: false,
  queryRewrite: false,
  queryDecompose: false,
  stepback: false,
  selfQuery: false,
};

type CompatImportBody = {
  source?: "algolia" | "elastic" | "legacy-parser";
  /** Project ID, slug or name to import into; falls back to indexName. */
  project?: string;
  indexName?: string;
  synonyms?: unknown;
  rules?: unknown;
  settings?: Record<string, unknown>;
  schema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

const defaultCompatSettings = {
  searchableAttributes: ["text", "filename", "headingPath"],
  attributesForFaceting: ["filterOnly(tags)", "filterOnly(mime_type)", "filterOnly(language)"],
  attributesToRetrieve: ["text", "filename", "pageNumber", "headingPath"],
  customRanking: ["desc(score)"],
  attributesToSnippet: ["text:18"],
  hitsPerPage: 10,
  analytics: true,
  clickAnalytics: true,
  paginationLimitedTo: 1000
} satisfies Record<string, unknown>;

function compatFilters(body: Record<string, unknown>, label?: string, extraAllowed: readonly string[] = []): SearchFilters | Response {
  try {
    return parseAlgoliaCompatFilters(body, extraAllowed);
  } catch (error) {
    // Any parse failure is a rejected request, never a 500 or a silently ignored filter.
    if (!(error instanceof AlgoliaFilterError)) console.error("[algolia-compat] filter parsing failed", error);
    const reason = error instanceof AlgoliaFilterError ? error.message : "Malformed search parameters.";
    // Same code as the Meilisearch/Typesense/Pagefind adapters, plus Algolia's message/status fields.
    const message = label ? `${label}: ${reason}` : reason;
    return Response.json({ code: "UNSUPPORTED_SEARCH_OPTION", error: message, message, status: 400 }, { status: 400 });
  }
}

function selectAlgoliaHitFields(hit: Record<string, unknown>, attributesToRetrieve?: string[]) {
  if (!Array.isArray(attributesToRetrieve) || attributesToRetrieve.length === 0 || attributesToRetrieve.includes("*")) {
    return hit;
  }

  const selected: Record<string, unknown> = {
    objectID: hit.objectID
  };
  for (const attribute of attributesToRetrieve) {
    if (attribute in hit) {
      selected[attribute] = hit[attribute];
    }
  }
  if ("_highlightResult" in hit) {
    selected._highlightResult = hit._highlightResult;
  }
  return selected;
}

function buildAlgoliaHit(args: {
  result: Awaited<ReturnType<typeof hybridSearch>>["results"][number];
  /** The query the hit answers, so matched words can be highlighted. */
  query?: string;
  highlightPreTag?: string;
  highlightPostTag?: string;
  attributesToRetrieve?: string[];
}) {
  const hit = {
    objectID: `${args.result.citation.documentId}:${args.result.citation.chunkIndex}`,
    text: args.result.text,
    filename: args.result.citation.filename,
    pageNumber: args.result.citation.pageNumber,
    headingPath: args.result.citation.headingPath,
    _docslurp: {
      documentId: args.result.citation.documentId,
      filename: args.result.citation.filename,
      pageNumber: args.result.citation.pageNumber,
      pageNumbers: args.result.citation.pageNumbers,
      headingPath: args.result.citation.headingPath,
      chunkIndex: args.result.citation.chunkIndex,
      score: args.result.score,
      regionBoxes: args.result.citation.regionBoxes ?? [],
      regionCoordinateSpace: args.result.citation.regionCoordinateSpace ?? null,
      locator: args.result.citation.locator ?? null,
    },
    // Real highlights (the query's words wrapped in the requested tags), not an always-"none" placeholder.
    _highlightResult: args.highlightPreTag && args.highlightPostTag
      ? {
          text: highlightMatches(args.result.text, args.query ?? "", args.highlightPreTag, args.highlightPostTag),
          filename: highlightMatches(args.result.citation.filename, args.query ?? "", args.highlightPreTag, args.highlightPostTag),
        }
      : undefined,
  };

  return selectAlgoliaHitFields(hit, args.attributesToRetrieve);
}

/**
 * Rows to fetch for a page. Fetching `pageStart + hitsPerPage + 1` made every page a different request, so
 * paging a result list re-ran (and re-billed) the whole search for each page. The size is rounded up to a
 * stable bucket, so pages 1-5 of ten share one search and one cache entry.
 */
export function stableFetchLimit(needed: number): number {
  let limit = 50;
  while (limit < needed && limit < 1000) limit *= 2;
  return Math.min(1000, limit);
}

type CompatSearchResponse = Awaited<ReturnType<typeof hybridSearch>>;

/**
 * One compat search, served from the tenant-scoped response cache when an identical request (same key, user,
 * project, query, filters and fetch size) ran moments ago. Authorization (scope, project) happened before
 * this call; the cache re-checks project access and never stores strict-privacy projects.
 */
async function compatSearch(args: { query: string; apiKey: ValidatedKey; projectId: string; filters: SearchFilters; limit: number }): Promise<Pick<CompatSearchResponse, "results" | "sessionId">> {
  const ttl = searchResponseCacheTtlMs();
  const apiKeyId = cacheableApiKeyId(args.apiKey.keyId, currentRequestApiKeyId());
  const ticket = ttl > 0 && apiKeyId !== undefined
    ? await responseCacheTicket({
        userId: args.apiKey.userId, apiKeyId, projectIds: [args.projectId],
        request: { surface: "algolia-compat", query: args.query, limit: args.limit, filters: args.filters, retrieval: compatRetrievalOptions },
      })
    : null;
  const cached = ticket ? readCachedResponse(ticket, ttl) as Pick<CompatSearchResponse, "results" | "sessionId"> | undefined : undefined;
  if (cached) return cached;
  const response = await hybridSearch(args.query, args.apiKey.userId, {
    runId: undefined,
    limit: args.limit,
    filters: args.filters,
    variant: "algolia-compat",
    ...compatRetrievalOptions,
    mmrLambda: undefined,
  } as never);
  const data = { results: response.results, sessionId: response.sessionId };
  if (ticket && response.availability?.status === "complete") await storeResponse(ticket, data, args.projectId);
  return data;
}

function toAlgoliaSynonymEntries(synonyms: Record<string, string[]>) {
  return Object.entries(synonyms)
    .filter(([, values]) => Array.isArray(values) && values.length > 0)
    .map(([term, values]) => ({
      objectID: `syn-${term}`,
      type: "synonym",
      synonyms: [term, ...values]
    }));
}

function normalizeSynonymPayload(payload: unknown): Record<string, string[]> {
  if (Array.isArray(payload)) {
    const out: Record<string, string[]> = {};
    for (const entry of payload) {
      const item = entry as Record<string, unknown>;
      const type = typeof item.type === "string" ? item.type : "synonym";
      if (type === "synonym" && Array.isArray(item.synonyms)) {
        const terms = item.synonyms.map((value) => String(value).trim()).filter(Boolean);
        for (const term of terms) {
          out[term] = Array.from(new Set(terms.filter((value) => value !== term)));
        }
      } else if (type === "oneWaySynonym" && typeof item.input === "string" && Array.isArray(item.synonyms)) {
        out[item.input] = Array.from(new Set(item.synonyms.map((value) => String(value).trim()).filter(Boolean)));
      }
    }
    return out;
  }

  if (payload && typeof payload === "object") {
    const out: Record<string, string[]> = {};
    for (const [term, values] of Object.entries(payload as Record<string, unknown>)) {
      if (Array.isArray(values)) {
        out[term] = Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean)));
      }
    }
    return out;
  }

  return {};
}

function normalizeRulesPayload(payload: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .filter((value) => value && typeof value === "object")
    .map((value) => ({ ...(value as Record<string, unknown>) }));
}

function mergeCompatSettings(settings: ProjectSearchSettings, patch: Record<string, unknown>) {
  return {
    ...defaultCompatSettings,
    ...settings.compatSettings,
    ...patch
  };
}

async function loadScopedProject(indexName: string, apiKey: ValidatedKey) {
  return await loadApiKeyScopedProject(indexName, apiKey);
}

function requireSearchKey(apiKey: ValidatedKey): Response | null {
  return apiKeyHasAnyScope(apiKey, ["search"]) ? null : Response.json({ message: "search scope required" }, { status: 403 });
}

/**
 * Compatibility settings/synonyms/rules mutations are the "admin" surface: they
 * change a project's search configuration, so they require the dedicated
 * `projects:manage` scope (never granted by default) on top of a server key.
 * Security finding SEC-2026-10-01.
 */
function requireServerManageKey(apiKey: ValidatedKey): Response | null {
  try {
    assertServerApiKey(apiKey);
  } catch (error) {
    return Response.json({ message: reportPublicError(error) }, { status: 403 });
  }
  if (!apiKeyHasAnyScope(apiKey, ["projects:manage"])) {
    return Response.json({ message: "projects:manage scope required" }, { status: 403 });
  }
  return null;
}

/**
 * The key owner must be allowed to edit the target project. The scope check
 * above is org-level; this is the per-project boundary that stops a viewer
 * from rewriting settings through a key they were permitted to mint.
 * Security finding SEC-2026-10-01.
 */
async function requireProjectEditAccess(projectId: string, apiKey: ValidatedKey): Promise<Response | null> {
  if (await userCanEditProjectSettings(projectId, apiKey.userId)) return null;
  return Response.json({ message: "project edit access required" }, { status: 403 });
}

async function persistImport(args: {
  projectId: string;
  userId: string;
  indexName: string;
  body: CompatImportBody;
}) {
  const source = args.body.source ?? "algolia";
  const saved = await mutateProjectSearchSettingsForUser({ projectId: args.projectId, userId: args.userId, mutate: current => {
    const compatSettings = mergeCompatSettings(current, args.body.settings ?? {});
    const synonyms = normalizeSynonymPayload(args.body.synonyms);
    const rules = normalizeRulesPayload(args.body.rules);
    const compatMetadata = {
      ...(current.compatMetadata ?? {}),
      source,
      importedAt: new Date().toISOString(),
      sourceIndexName: args.body.indexName ?? args.body.project ?? args.indexName,
      schema: args.body.schema ?? {},
      metadata: args.body.metadata ?? {}
    };

    const pinnedResults = source === "algolia"
      ? rules.flatMap((rule) => ruleToPins(rule))
      : current.pinnedResults;

    return {
      ...current,
      synonyms: Object.keys(synonyms).length > 0 ? synonyms : current.synonyms,
      rules: rules.length > 0 ? rules : current.rules,
      compatSettings,
      compatMetadata,
      pinnedResults
    };
  } });
  if (!saved) return null;
  const synonyms = normalizeSynonymPayload(args.body.synonyms);
  const rules = normalizeRulesPayload(args.body.rules);
  const compatSettings = saved.compatSettings;

  return {
    source,
    projectId: args.projectId,
    imported: {
      synonyms: Object.keys(synonyms).length,
      rules: rules.length,
      settings: Object.keys(compatSettings).length,
      schemaFields: countSchemaFields(args.body.schema),
      metadataKeys: Object.keys(args.body.metadata ?? {}).length
    }
  };
}

function ruleToPins(rule: Record<string, unknown>) {
  const consequence = rule.consequence;
  if (!consequence || typeof consequence !== "object") {
    return [];
  }
  const params = (consequence as Record<string, unknown>).params;
  if (!params || typeof params !== "object") {
    return [];
  }
  const promoted = (params as Record<string, unknown>).promote;
  if (!Array.isArray(promoted)) {
    return [];
  }
  const queryPattern = typeof rule.condition === "object" && rule.condition
    ? String(((rule.condition as Record<string, unknown>).pattern ?? "") || "")
    : "";
  return promoted.map((entry, index) => {
    const item = entry as Record<string, unknown>;
    return {
      queryPattern: queryPattern || ".*",
      documentId: typeof item.objectID === "string" ? item.objectID : undefined,
      chunkId: typeof item.chunkID === "string" ? item.chunkID : undefined,
      rank: index + 1
    };
  });
}

function countSchemaFields(schema: Record<string, unknown> | undefined) {
  if (!schema || typeof schema !== "object") {
    return 0;
  }
  const properties = (schema as Record<string, unknown>).properties;
  if (properties && typeof properties === "object") {
    return Object.keys(properties as Record<string, unknown>).length;
  }
  return Object.keys(schema).length;
}

async function recordAnalyticsEvent(args: {
  projectId: string;
  userId: string;
  eventType: "click" | "conversion" | "view";
  sessionId?: string;
  objectId?: string;
  queryId?: string;
  metadata?: Record<string, unknown>;
}) {
  await sql`
    insert into audit_log (
      id, user_id, action, resource_type, resource_id, metadata, created_at
    ) values (
      ${randomUUID()},
      ${args.userId},
      ${`compat.algolia.${args.eventType}`},
      'project',
      ${args.projectId},
      ${sql.json({
        sessionId: args.sessionId ?? null,
        objectId: args.objectId ?? null,
        queryId: args.queryId ?? null,
        ...args.metadata
      })},
      now()
    )
  `;
}

const searchBodyLimit = bodyLimit({
  maxSize: 1024 * 1024,
  onError: (c) => c.json({ code: "PAYLOAD_TOO_LARGE", error: "Request body exceeds 1 MB.", message: "Request body exceeds 1 MB.", status: 413 }, 413),
});

export const algoliaCompatRoutes = new Hono()
  .use("*", async (c, next) => {
    let header = c.req.header("Authorization");
    const algoliaKey = c.req.header("X-Algolia-API-Key");
    if (!header && algoliaKey) {
      header = `Bearer ${algoliaKey}`;
      c.req.raw.headers.set("Authorization", header);
    }
    await next();
  })
  .use("*", apiKeyAuth)
  // Search bodies are small; bound them before JSON parsing and filter validation.
  .use("/1/indexes/:indexName/query", searchBodyLimit)
  .use("/1/indexes/:indexName/facets/:facetName/query", searchBodyLimit)
  .use("/1/indexes/*/queries", searchBodyLimit)
  .post("/1/indexes/:indexName/query", zValidator("json", queryBodySchema), async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const indexName = c.req.param("indexName");
    const startedAt = performance.now();
    const body = c.req.valid("json");
    const query = body.query ?? "";

    if (!query) {
      return c.json({ message: "query is required" }, 400);
    }
    // Reject unsupported filters before any lookup or retrieval: ignoring one would widen results.
    const filters = compatFilters(body);
    if (filters instanceof Response) return filters;

    const project = await loadScopedProject(indexName, apiKey);
    if (!project) {
      return c.json({ message: "index (project) not found" }, 404);
    }

    const settings = await getProjectSearchSettings(project.id, apiKey.userId);
    const hitsPerPage = Math.max(1, Math.min(1000, body.hitsPerPage ?? Number(settings.compatSettings.hitsPerPage ?? 10)));
    const page = Math.max(0, body.page ?? 0);
    const pageStart = page * hitsPerPage;
    const fetchLimit = stableFetchLimit(compatFetchLimit(pageStart, hitsPerPage));
    filters.projectId = project.id;

    const { results, sessionId } = await compatSearch({ query, apiKey, projectId: project.id, filters, limit: fetchLimit });

    const pageResults = results.slice(pageStart, pageStart + hitsPerPage);
    const mappedHits = pageResults.map((result) => buildAlgoliaHit({
      result,
      query,
      highlightPreTag: body.highlightPreTag,
      highlightPostTag: body.highlightPostTag,
      attributesToRetrieve: body.attributesToRetrieve
    }));
    const facetHits = results
      .slice(0, Math.min(results.length, pageStart + hitsPerPage))
      .map((result) => buildAlgoliaHit({ result }));
    // The hits found in the ranked window we asked for. Full means more may exist beyond it: nbHits is then a
    // floor, and exhaustiveNbHits says so, instead of inventing "one more hit" for the next page.
    const { nbHits, exhaustive } = compatHitCount(results.length, fetchLimit);

    const response = {
      hits: mappedHits,
      page,
      hitsPerPage,
      nbHits,
      nbPages: nbHits === 0 ? 0 : Math.max(1, Math.ceil(nbHits / hitsPerPage)),
      processingTimeMS: Math.round(performance.now() - startedAt),
      query,
      queryID: sessionId,
      params: "",
      facets: buildFacetResponse(body.facets ?? [], facetHits),
      exhaustiveNbHits: exhaustive
    };

    return c.json(response);
  })
  .post("/1/indexes/*/queries", zValidator("json", batchQuerySchema), async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const { requests } = c.req.valid("json");
    // Validate every request's filters first: one unsupported clause rejects the whole
    // batch before any retrieval runs.
    const requestFilters: SearchFilters[] = [];
    for (const [index, request] of requests.entries()) {
      const filters = compatFilters(request, `requests[${index}]`, ["indexName"]);
      if (filters instanceof Response) return filters;
      requestFilters.push(filters);
    }

    const results = [];
    for (const [index, request] of requests.entries()) {
      const startedAt = performance.now();
      const project = await loadScopedProject(request.indexName, apiKey);
      if (!project || !request.query) {
        results.push({ hits: [], nbHits: 0, page: 0, hitsPerPage: request.hitsPerPage ?? 10, nbPages: 0, processingTimeMS: 0, query: request.query ?? "", params: "" });
        continue;
      }
      const hitsPerPage = Math.max(1, Math.min(1000, request.hitsPerPage ?? 10));
      const page = Math.max(0, request.page ?? 0);
      const pageStart = page * hitsPerPage;
      const fetchLimit = stableFetchLimit(compatFetchLimit(pageStart, hitsPerPage));
      const filters = { ...requestFilters[index]!, projectId: project.id };
      const response = await compatSearch({ query: request.query, apiKey, projectId: project.id, filters, limit: fetchLimit });
      const pageResults = response.results.slice(pageStart, pageStart + hitsPerPage);
      const { nbHits, exhaustive } = compatHitCount(response.results.length, fetchLimit);
      results.push({
        hits: pageResults.map((result) => buildAlgoliaHit({
          result,
          query: request.query,
          highlightPreTag: request.highlightPreTag,
          highlightPostTag: request.highlightPostTag,
          attributesToRetrieve: request.attributesToRetrieve
        })),
        nbHits,
        page,
        hitsPerPage,
        nbPages: nbHits === 0 ? 0 : Math.max(1, Math.ceil(nbHits / hitsPerPage)),
        processingTimeMS: Math.round(performance.now() - startedAt),
        query: request.query,
        queryID: response.sessionId,
        params: "",
        facets: buildFacetResponse(
          request.facets ?? [],
          response.results
            .slice(0, Math.min(response.results.length, pageStart + hitsPerPage))
            .map((result) => buildAlgoliaHit({ result }))
        ),
        exhaustiveNbHits: exhaustive
      });
    }

    return c.json({ results });
  })
  .post("/1/indexes/:indexName/facets/:facetName/query", zValidator("json", facetQuerySchema), async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const body = c.req.valid("json");
    const filters = compatFilters(body);
    if (filters instanceof Response) return filters;
    const project = await loadScopedProject(c.req.param("indexName"), apiKey);
    if (!project) {
      return c.json({ message: "index (project) not found" }, 404);
    }

    const facetName = c.req.param("facetName");
    const maxFacetHits = Math.max(1, Math.min(100, body.maxFacetHits ?? 10));
    const typedQuery = body.query?.trim();
    const query = typedQuery || body.facetQuery?.trim() || "*";
    filters.projectId = project.id;

    const { results } = await hybridSearch(query, apiKey.userId, {
      limit: Math.min(1000, maxFacetHits * 10),
      filters,
      variant: "algolia-compat",
      ...compatRetrievalOptions,
      // A facet-value prefix or the "*" wildcard is not a relevance query: only a typed query is floored.
      ...(typedQuery ? {} : { minScore: 0 }),
    });

    return c.json(buildFacetHits({
      facetName,
      facetQuery: body.facetQuery ?? "",
      hits: results.map((result) => buildAlgoliaHit({ result })),
      maxFacetHits
    }));
  })
  .get("/1/indexes/:indexName/settings", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const project = await loadScopedProject(c.req.param("indexName"), apiKey);
    if (!project) {
      return c.json({ message: "index (project) not found" }, 404);
    }
    const settings = await getProjectSearchSettings(project.id, apiKey.userId);
    return c.json(mergeCompatSettings(settings, {}));
  })
  .put("/1/indexes/:indexName/settings", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireServerManageKey(apiKey);
    if (forbidden) return forbidden;
    const project = await loadScopedProject(c.req.param("indexName"), apiKey);
    if (!project) {
      return c.json({ message: "index (project) not found" }, 404);
    }
    const denied = await requireProjectEditAccess(project.id, apiKey);
    if (denied) return denied;
    const patch = await c.req.json<Record<string, unknown>>();
    const settings = await mutateProjectSearchSettingsForUser({ projectId: project.id, userId: apiKey.userId,
      mutate: current => ({ ...current, compatSettings: mergeCompatSettings(current, patch) }) });
    if (!settings) return c.json({ message: "Project editing permission is required" }, 403);
    return c.json({ ok: true, settings: mergeCompatSettings(settings, {}) });
  })
  .get("/1/indexes/:indexName/synonyms", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const project = await loadScopedProject(c.req.param("indexName"), apiKey);
    if (!project) {
      return c.json({ message: "index (project) not found" }, 404);
    }
    const settings = await getProjectSearchSettings(project.id, apiKey.userId);
    return c.json({ hits: toAlgoliaSynonymEntries(settings.synonyms) });
  })
  .post("/1/indexes/:indexName/synonyms/batch", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireServerManageKey(apiKey);
    if (forbidden) return forbidden;
    const project = await loadScopedProject(c.req.param("indexName"), apiKey);
    if (!project) {
      return c.json({ message: "index (project) not found" }, 404);
    }
    const denied = await requireProjectEditAccess(project.id, apiKey);
    if (denied) return denied;
    const body = await c.req.json<{ synonyms?: unknown }>();
    const synonyms = normalizeSynonymPayload(body.synonyms);
    const saved = await mutateProjectSearchSettingsForUser({ projectId: project.id, userId: apiKey.userId,
      mutate: current => ({ ...current, synonyms }) });
    if (!saved) return c.json({ message: "Project editing permission is required" }, 403);
    return c.json({ updatedAt: new Date().toISOString(), count: Object.keys(synonyms).length });
  })
  .get("/1/indexes/:indexName/rules", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const project = await loadScopedProject(c.req.param("indexName"), apiKey);
    if (!project) {
      return c.json({ message: "index (project) not found" }, 404);
    }
    const settings = await getProjectSearchSettings(project.id, apiKey.userId);
    return c.json({ hits: settings.rules });
  })
  .post("/1/indexes/:indexName/rules/batch", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireServerManageKey(apiKey);
    if (forbidden) return forbidden;
    const project = await loadScopedProject(c.req.param("indexName"), apiKey);
    if (!project) {
      return c.json({ message: "index (project) not found" }, 404);
    }
    const denied = await requireProjectEditAccess(project.id, apiKey);
    if (denied) return denied;
    const body = await c.req.json<{ rules?: unknown }>();
    const rules = normalizeRulesPayload(body.rules);
    const saved = await mutateProjectSearchSettingsForUser({ projectId: project.id, userId: apiKey.userId,
      mutate: current => ({ ...current, rules, pinnedResults: rules.flatMap((rule) => ruleToPins(rule)) }) });
    if (!saved) return c.json({ message: "Project editing permission is required" }, 403);
    return c.json({ updatedAt: new Date().toISOString(), count: rules.length });
  })
  .get("/1/indexes/:indexName/analytics/summary", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const project = await loadScopedProject(c.req.param("indexName"), apiKey);
    if (!project) {
      return c.json({ message: "index (project) not found" }, 404);
    }

    const [summary] = await sql<{
      queries: number;
      zero_results: number;
      clicks: number;
      conversions: number;
    }[]>`
      select
        coalesce((
          select count(*)::int
          from search_sessions s
          where s.metadata->>'projectId' = ${project.id}
        ), 0) as queries,
        coalesce((
          select count(*)::int
          from search_zero_results z
          where z.project_id = ${project.id}
        ), 0) as zero_results,
        coalesce((
          select count(*)::int
          from audit_log a
          where a.resource_type = 'project'
            and a.resource_id = ${project.id}
            and a.action = 'compat.algolia.click'
        ), 0) as clicks,
        coalesce((
          select count(*)::int
          from audit_log a
          where a.resource_type = 'project'
            and a.resource_id = ${project.id}
            and a.action = 'compat.algolia.conversion'
        ), 0) as conversions
    `;

    return c.json({
      queries: summary?.queries ?? 0,
      zeroResults: summary?.zero_results ?? 0,
      clicks: summary?.clicks ?? 0,
      conversions: summary?.conversions ?? 0
    });
  })
  .post("/1/indexes/:indexName/analytics/click", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const project = await loadScopedProject(c.req.param("indexName"), apiKey);
    if (!project) {
      return c.json({ message: "index (project) not found" }, 404);
    }
    const body = await c.req.json<{ queryID?: string; objectIDs?: string[]; positions?: number[] }>();
    await Promise.all((body.objectIDs ?? []).map((objectId, index) => recordAnalyticsEvent({
      projectId: project.id,
      userId: apiKey.userId,
      eventType: "click",
      queryId: body.queryID,
      objectId,
      metadata: {
        position: body.positions?.[index] ?? null
      }
    })));
    return c.json({ status: "ok" });
  })
  .post("/1/indexes/:indexName/analytics/conversion", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const project = await loadScopedProject(c.req.param("indexName"), apiKey);
    if (!project) {
      return c.json({ message: "index (project) not found" }, 404);
    }
    const body = await c.req.json<{ queryID?: string; objectIDs?: string[]; eventName?: string }>();
    await Promise.all((body.objectIDs ?? []).map((objectId) => recordAnalyticsEvent({
      projectId: project.id,
      userId: apiKey.userId,
      eventType: "conversion",
      queryId: body.queryID,
      objectId,
      metadata: {
        eventName: body.eventName ?? "conversion"
      }
    })));
    return c.json({ status: "ok" });
  })
  .post("/1/import", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireServerManageKey(apiKey);
    if (forbidden) return forbidden;
    const body = await c.req.json<CompatImportBody>();
    const indexName = body.project ?? body.indexName ?? "";
    if (!indexName) {
      return c.json({ message: "project or indexName is required" }, 400);
    }
    const project = await loadScopedProject(indexName, apiKey);
    if (!project) {
      return c.json({ message: "index (project) not found" }, 404);
    }
    const denied = await requireProjectEditAccess(project.id, apiKey);
    if (denied) return denied;
    const result = await persistImport({
      projectId: project.id,
      userId: apiKey.userId,
      indexName,
      body
    });
    if (!result) return c.json({ message: "Project editing permission is required" }, 403);
    return c.json(result, 201);
  });

function buildFacetResponse(facets: string[], hits: Array<Record<string, unknown>>) {
  if (!Array.isArray(facets) || facets.length === 0) {
    return {};
  }

  const response: Record<string, Record<string, number>> = {};
  for (const facet of facets) {
    if (facet === "filename") {
      response[facet] = {};
      for (const hit of hits) {
        const value = typeof hit.filename === "string" ? hit.filename : "";
        if (!value) {
          continue;
        }
        response[facet]![value] = (response[facet]![value] ?? 0) + 1;
      }
    }
  }
  return response;
}

function buildFacetHits(args: {
  facetName: string;
  facetQuery: string;
  hits: Array<Record<string, unknown>>;
  maxFacetHits: number;
}) {
  if (args.facetName !== "filename") {
    return {
      facetHits: [],
      exhaustiveFacetsCount: false
    };
  }

  const counts = new Map<string, number>();
  for (const hit of args.hits) {
    const value = typeof hit.filename === "string" ? hit.filename : "";
    if (!value) {
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const normalizedQuery = args.facetQuery.trim().toLowerCase();
  const facetHits = Array.from(counts.entries())
    .filter(([value]) => !normalizedQuery || value.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, args.maxFacetHits)
    .map(([value, count]) => ({
      value,
      highlighted: value,
      count
    }));

  return {
    facetHits,
    exhaustiveFacetsCount: true
  };
}

export default algoliaCompatRoutes;
