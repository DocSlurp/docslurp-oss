import { reportPublicError } from "../lib/public-errors.js";
import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { WorkspaceSearchSettings } from "@docslurp/shared";

import { sql } from "../db.js";
import {
  apiKeyHasAnyScope,
  assertServerApiKey,
  loadApiKeyScopedWorkspace
} from "../lib/api-key-authorization.js";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { hybridSearch } from "../services/search.js";
import type { ValidatedKey } from "../services/api-keys.js";
import { parseFilters } from "../search/filters.js";
import {
  getWorkspaceSearchSettings,
  upsertWorkspaceSearchSettings
} from "../services/search-controls.js";

const queryBodySchema = z.object({
  query: z.string().max(10_000).optional(),
  page: z.number().int().nonnegative().optional(),
  hitsPerPage: z.number().int().min(1).max(1000).optional(),
  filters: z.string().optional(),
  facetFilters: z.unknown().optional(),
  numericFilters: z.unknown().optional(),
  attributesToRetrieve: z.array(z.string()).optional(),
  facets: z.array(z.string()).optional(),
  highlightPreTag: z.string().optional(),
  highlightPostTag: z.string().optional(),
}).passthrough();

const batchQuerySchema = z.object({
  requests: z.array(queryBodySchema.extend({ indexName: z.string().min(1) })).max(10),
});

const facetQuerySchema = queryBodySchema.pick({ query: true, filters: true, facetFilters: true, numericFilters: true }).extend({
  facetQuery: z.string().max(10_000).optional(),
  maxFacetHits: z.number().int().min(1).max(100).optional(),
});

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
  workspaceId?: string;
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

function collectFilterClauses(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectFilterClauses(entry));
  }
  return [];
}

function applyCompatFilterClause(filters: Record<string, string>, rawClause: string) {
  const clause = rawClause.trim();
  if (!clause) {
    return;
  }

  const [left, ...rest] = clause.split(":");
  const key = (left ?? "").trim();
  const value = rest.join(":").trim().replace(/^"|"$/g, "");
  if (!value) {
    return;
  }

  if (key === "tag" || key === "tags") {
    filters.tags = filters.tags ? `${filters.tags},${value}` : value;
  } else if (key === "mime_type" || key === "mimeType") {
    filters.mimeTypes = filters.mimeTypes ? `${filters.mimeTypes},${value}` : value;
  } else if (key === "documentId") {
    filters.documentId = value;
  } else if (key === "runId") {
    filters.runId = value;
  } else if (key === "language") {
    filters.language = value;
  } else if (key === "heading") {
    filters.heading = value;
  } else if (key === "filename" || key === "filenameContains") {
    filters.filenameContains = value;
  }
}

function applyNumericFilterClause(filters: Record<string, string>, rawClause: string) {
  const clause = rawClause.trim();
  if (!clause) {
    return;
  }

  const match = clause.match(/^(page|pageNumber|page_number)\s*(<=|>=|=|<|>)\s*(\d+)$/i);
  if (!match) {
    return;
  }

  const operator = match[2];
  const numericValue = match[3];
  if (!numericValue) {
    return;
  }

  if (operator === "=") {
    filters.pageFrom = numericValue;
    filters.pageTo = numericValue;
  } else if (operator === ">=" || operator === ">") {
    filters.pageFrom = operator === ">" ? String(Number(numericValue) + 1) : numericValue;
  } else if (operator === "<=" || operator === "<") {
    filters.pageTo = operator === "<" ? String(Math.max(0, Number(numericValue) - 1)) : numericValue;
  }
}

function parseCompatFilters(args: {
  filtersText?: string;
  facetFilters?: unknown;
  numericFilters?: unknown;
}) {
  const filters = {
    documentId: "",
    runId: "",
    workspaceId: "",
    filenameContains: "",
    mimeTypes: "",
    tags: "",
    pageFrom: "",
    pageTo: "",
    language: "",
    heading: "",
    dateFrom: "",
    dateTo: "",
  };

  const raw = (args.filtersText ?? "").trim();
  if (raw) {
    for (const clause of raw.split(/\s+AND\s+/i)) {
      applyCompatFilterClause(filters, clause);
    }
  }

  for (const clause of collectFilterClauses(args.facetFilters)) {
    applyCompatFilterClause(filters, clause);
  }
  for (const clause of collectFilterClauses(args.numericFilters)) {
    applyNumericFilterClause(filters, clause);
  }

  return parseFilters(filters);
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
    _highlightResult: args.highlightPreTag && args.highlightPostTag
      ? {
          text: {
            value: args.result.text,
            matchLevel: "none",
            matchedWords: [],
          },
        }
      : undefined,
  };

  return selectAlgoliaHitFields(hit, args.attributesToRetrieve);
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

function mergeCompatSettings(settings: WorkspaceSearchSettings, patch: Record<string, unknown>) {
  return {
    ...defaultCompatSettings,
    ...settings.compatSettings,
    ...patch
  };
}

async function loadScopedWorkspace(indexName: string, apiKey: ValidatedKey) {
  return await loadApiKeyScopedWorkspace(indexName, apiKey);
}

function requireSearchKey(apiKey: ValidatedKey): Response | null {
  return apiKeyHasAnyScope(apiKey, ["search"]) ? null : Response.json({ message: "search scope required" }, { status: 403 });
}

function requireServerSearchKey(apiKey: ValidatedKey): Response | null {
  try {
    assertServerApiKey(apiKey);
  } catch (error) {
    return Response.json({ message: reportPublicError(error) }, { status: 403 });
  }
  return requireSearchKey(apiKey);
}

async function persistImport(args: {
  settings: WorkspaceSearchSettings;
  source: string;
  indexName: string;
  body: CompatImportBody;
}) {
  const source = args.body.source ?? "algolia";
  const compatSettings = mergeCompatSettings(args.settings, args.body.settings ?? {});
  const synonyms = normalizeSynonymPayload(args.body.synonyms);
  const rules = normalizeRulesPayload(args.body.rules);
  const compatMetadata = {
    ...(args.settings.compatMetadata ?? {}),
    source,
    importedAt: new Date().toISOString(),
    sourceIndexName: args.body.indexName ?? args.body.workspaceId ?? args.indexName,
    schema: args.body.schema ?? {},
    metadata: args.body.metadata ?? {}
  };

  const pinnedResults = source === "algolia"
    ? rules.flatMap((rule) => ruleToPins(rule))
    : args.settings.pinnedResults;

  await upsertWorkspaceSearchSettings({
    ...args.settings,
    synonyms: Object.keys(synonyms).length > 0 ? synonyms : args.settings.synonyms,
    rules: rules.length > 0 ? rules : args.settings.rules,
    compatSettings,
    compatMetadata,
    pinnedResults
  });

  return {
    source,
    workspaceId: args.settings.workspaceId,
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
  workspaceId: string;
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
      'workspace',
      ${args.workspaceId},
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

    const workspace = await loadScopedWorkspace(indexName, apiKey);
    if (!workspace) {
      return c.json({ message: "index (workspace) not found" }, 404);
    }

    const settings = await getWorkspaceSearchSettings(workspace.id, apiKey.userId);
    const hitsPerPage = Math.max(1, Math.min(1000, body.hitsPerPage ?? Number(settings.compatSettings.hitsPerPage ?? 10)));
    const page = Math.max(0, body.page ?? 0);
    const pageStart = page * hitsPerPage;
    const fetchLimit = Math.max(1, Math.min(1000, pageStart + hitsPerPage + 1));
    const filters = parseCompatFilters({
      filtersText: body.filters,
      facetFilters: body.facetFilters,
      numericFilters: body.numericFilters
    });
    filters.workspaceId = workspace.id;

    const { results, sessionId } = await hybridSearch(query, apiKey.userId, {
      runId: undefined,
      limit: fetchLimit,
      filters,
      variant: "algolia-compat",
      ...compatRetrievalOptions,
      mmrLambda: undefined,
    } as never);

    const hasMore = results.length > pageStart + hitsPerPage;
    const pageResults = results.slice(pageStart, pageStart + hitsPerPage);
    const mappedHits = pageResults.map((result) => buildAlgoliaHit({
      result,
      highlightPreTag: body.highlightPreTag,
      highlightPostTag: body.highlightPostTag,
      attributesToRetrieve: body.attributesToRetrieve
    }));
    const facetHits = results
      .slice(0, Math.min(results.length, pageStart + hitsPerPage))
      .map((result) => buildAlgoliaHit({ result }));
    const nbHits = hasMore
      ? pageStart + mappedHits.length + 1
      : Math.min(results.length, pageStart + mappedHits.length);

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
      exhaustiveNbHits: !hasMore && fetchLimit < 1000
    };

    return c.json(response);
  })
  .post("/1/indexes/*/queries", zValidator("json", batchQuerySchema), async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const { requests } = c.req.valid("json");

    const results = [];
    for (const request of requests) {
      const startedAt = performance.now();
      const workspace = await loadScopedWorkspace(request.indexName, apiKey);
      if (!workspace || !request.query) {
        results.push({ hits: [], nbHits: 0, page: 0, hitsPerPage: request.hitsPerPage ?? 10, nbPages: 0, processingTimeMS: 0, query: request.query ?? "", params: "" });
        continue;
      }
      const hitsPerPage = Math.max(1, Math.min(1000, request.hitsPerPage ?? 10));
      const page = Math.max(0, request.page ?? 0);
      const pageStart = page * hitsPerPage;
      const fetchLimit = Math.max(1, Math.min(1000, pageStart + hitsPerPage + 1));
      const filters = parseCompatFilters({
        filtersText: request.filters,
        facetFilters: request.facetFilters,
        numericFilters: request.numericFilters
      });
      filters.workspaceId = workspace.id;
      const response = await hybridSearch(request.query, apiKey.userId, {
        limit: fetchLimit,
        filters,
        variant: "algolia-compat",
        ...compatRetrievalOptions,
      });
      const hasMore = response.results.length > pageStart + hitsPerPage;
      const pageResults = response.results.slice(pageStart, pageStart + hitsPerPage);
      const nbHits = hasMore
        ? pageStart + pageResults.length + 1
        : Math.min(response.results.length, pageStart + pageResults.length);
      results.push({
        hits: pageResults.map((result) => buildAlgoliaHit({
          result,
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
        exhaustiveNbHits: !hasMore && fetchLimit < 1000
      });
    }

    return c.json({ results });
  })
  .post("/1/indexes/:indexName/facets/:facetName/query", zValidator("json", facetQuerySchema), async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const workspace = await loadScopedWorkspace(c.req.param("indexName"), apiKey);
    if (!workspace) {
      return c.json({ message: "index (workspace) not found" }, 404);
    }

    const facetName = c.req.param("facetName");
    const body = c.req.valid("json");
    const maxFacetHits = Math.max(1, Math.min(100, body.maxFacetHits ?? 10));
    const query = body.query?.trim() || body.facetQuery?.trim() || "*";
    const filters = parseCompatFilters({
      filtersText: body.filters,
      facetFilters: body.facetFilters,
      numericFilters: body.numericFilters
    });
    filters.workspaceId = workspace.id;

    const { results } = await hybridSearch(query, apiKey.userId, {
      limit: Math.min(1000, maxFacetHits * 10),
      filters,
      variant: "algolia-compat",
      ...compatRetrievalOptions,
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
    const workspace = await loadScopedWorkspace(c.req.param("indexName"), apiKey);
    if (!workspace) {
      return c.json({ message: "index (workspace) not found" }, 404);
    }
    const settings = await getWorkspaceSearchSettings(workspace.id, apiKey.userId);
    return c.json(mergeCompatSettings(settings, {}));
  })
  .put("/1/indexes/:indexName/settings", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireServerSearchKey(apiKey);
    if (forbidden) return forbidden;
    const workspace = await loadScopedWorkspace(c.req.param("indexName"), apiKey);
    if (!workspace) {
      return c.json({ message: "index (workspace) not found" }, 404);
    }
    const patch = await c.req.json<Record<string, unknown>>();
    const settings = await getWorkspaceSearchSettings(workspace.id, apiKey.userId);
    await upsertWorkspaceSearchSettings({
      ...settings,
      compatSettings: mergeCompatSettings(settings, patch)
    });
    return c.json({ ok: true, settings: mergeCompatSettings(settings, patch) });
  })
  .get("/1/indexes/:indexName/synonyms", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const workspace = await loadScopedWorkspace(c.req.param("indexName"), apiKey);
    if (!workspace) {
      return c.json({ message: "index (workspace) not found" }, 404);
    }
    const settings = await getWorkspaceSearchSettings(workspace.id, apiKey.userId);
    return c.json({ hits: toAlgoliaSynonymEntries(settings.synonyms) });
  })
  .post("/1/indexes/:indexName/synonyms/batch", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireServerSearchKey(apiKey);
    if (forbidden) return forbidden;
    const workspace = await loadScopedWorkspace(c.req.param("indexName"), apiKey);
    if (!workspace) {
      return c.json({ message: "index (workspace) not found" }, 404);
    }
    const body = await c.req.json<{ synonyms?: unknown }>();
    const settings = await getWorkspaceSearchSettings(workspace.id, apiKey.userId);
    const synonyms = normalizeSynonymPayload(body.synonyms);
    await upsertWorkspaceSearchSettings({
      ...settings,
      synonyms
    });
    return c.json({ updatedAt: new Date().toISOString(), count: Object.keys(synonyms).length });
  })
  .get("/1/indexes/:indexName/rules", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const workspace = await loadScopedWorkspace(c.req.param("indexName"), apiKey);
    if (!workspace) {
      return c.json({ message: "index (workspace) not found" }, 404);
    }
    const settings = await getWorkspaceSearchSettings(workspace.id, apiKey.userId);
    return c.json({ hits: settings.rules });
  })
  .post("/1/indexes/:indexName/rules/batch", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireServerSearchKey(apiKey);
    if (forbidden) return forbidden;
    const workspace = await loadScopedWorkspace(c.req.param("indexName"), apiKey);
    if (!workspace) {
      return c.json({ message: "index (workspace) not found" }, 404);
    }
    const body = await c.req.json<{ rules?: unknown }>();
    const settings = await getWorkspaceSearchSettings(workspace.id, apiKey.userId);
    const rules = normalizeRulesPayload(body.rules);
    await upsertWorkspaceSearchSettings({
      ...settings,
      rules,
      pinnedResults: rules.flatMap((rule) => ruleToPins(rule))
    });
    return c.json({ updatedAt: new Date().toISOString(), count: rules.length });
  })
  .get("/1/indexes/:indexName/analytics/summary", async (c) => {
    const apiKey = c.get("apiKey");
    const forbidden = requireSearchKey(apiKey);
    if (forbidden) return forbidden;
    const workspace = await loadScopedWorkspace(c.req.param("indexName"), apiKey);
    if (!workspace) {
      return c.json({ message: "index (workspace) not found" }, 404);
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
          where s.metadata->>'workspaceId' = ${workspace.id}
        ), 0) as queries,
        coalesce((
          select count(*)::int
          from search_zero_results z
          where z.workspace_id = ${workspace.id}
        ), 0) as zero_results,
        coalesce((
          select count(*)::int
          from audit_log a
          where a.resource_type = 'workspace'
            and a.resource_id = ${workspace.id}
            and a.action = 'compat.algolia.click'
        ), 0) as clicks,
        coalesce((
          select count(*)::int
          from audit_log a
          where a.resource_type = 'workspace'
            and a.resource_id = ${workspace.id}
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
    const workspace = await loadScopedWorkspace(c.req.param("indexName"), apiKey);
    if (!workspace) {
      return c.json({ message: "index (workspace) not found" }, 404);
    }
    const body = await c.req.json<{ queryID?: string; objectIDs?: string[]; positions?: number[] }>();
    await Promise.all((body.objectIDs ?? []).map((objectId, index) => recordAnalyticsEvent({
      workspaceId: workspace.id,
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
    const workspace = await loadScopedWorkspace(c.req.param("indexName"), apiKey);
    if (!workspace) {
      return c.json({ message: "index (workspace) not found" }, 404);
    }
    const body = await c.req.json<{ queryID?: string; objectIDs?: string[]; eventName?: string }>();
    await Promise.all((body.objectIDs ?? []).map((objectId) => recordAnalyticsEvent({
      workspaceId: workspace.id,
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
    const forbidden = requireServerSearchKey(apiKey);
    if (forbidden) return forbidden;
    const body = await c.req.json<CompatImportBody>();
    const indexName = body.workspaceId ?? body.indexName ?? "";
    if (!indexName) {
      return c.json({ message: "workspaceId or indexName is required" }, 400);
    }
    const workspace = await loadScopedWorkspace(indexName, apiKey);
    if (!workspace) {
      return c.json({ message: "index (workspace) not found" }, 404);
    }
    const settings = await getWorkspaceSearchSettings(workspace.id, apiKey.userId);
    const result = await persistImport({
      settings,
      source: body.source ?? "algolia",
      indexName,
      body
    });
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
