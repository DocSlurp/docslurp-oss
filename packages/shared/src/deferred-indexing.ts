import { z } from "zod";

import { pageCredits } from "./billing.js";
import { formatPrivateModelUri, getPrivateModelEndpointRegistry, lookupPrivateModelRoute } from "./private-endpoints.js";

/** How a workspace indexes documents: eagerly (`full`) or deferred until a query needs pages. */
export const indexingModeSchema = z.enum(["full", "map", "visual"]);
export type IndexingMode = z.infer<typeof indexingModeSchema>;

export const mapRouterModeSchema = z.enum(["off", "auto", "always"]);
export type MapRouterMode = z.infer<typeof mapRouterModeSchema>;

export const materializationPolicySchema = z.object({
  maxPagesPerQuery: z.number().int().min(0).max(2000),
  maxCreditsPerQuery: z.number().min(0).max(100000),
  maxPagesPerDay: z.number().int().min(0).optional(),
  deadlineMs: z.number().int().min(0).max(120000),
  allowFullIndexRequest: z.boolean(),
  allowAgentDiscovery: z.boolean(),
  mapRouter: mapRouterModeSchema,
});
export type MaterializationPolicy = z.infer<typeof materializationPolicySchema>;
export const materializationPolicyOverridesSchema = materializationPolicySchema.partial();

export const DEFAULT_SERVER_MATERIALIZATION_POLICY: MaterializationPolicy = {
  maxPagesPerQuery: 40,
  maxCreditsPerQuery: 25,
  deadlineMs: 20000,
  allowFullIndexRequest: true,
  allowAgentDiscovery: true,
  mapRouter: "always",
};

export const DEFAULT_CLIENT_KEY_MATERIALIZATION_POLICY: MaterializationPolicy = {
  ...DEFAULT_SERVER_MATERIALIZATION_POLICY,
  allowFullIndexRequest: false,
};

const ROUTER_RANK: Record<MapRouterMode, number> = { off: 0, auto: 1, always: 2 };

/**
 * Most-restrictive-wins merge: min of numbers, AND of booleans, lower router.
 * A layer can never widen the base; `undefined`/missing fields leave it unchanged.
 */
export function narrowMaterializationPolicy(
  base: MaterializationPolicy,
  ...layers: Array<Partial<MaterializationPolicy> | null | undefined>
): MaterializationPolicy {
  const result: MaterializationPolicy = { ...base };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.maxPagesPerQuery !== undefined) {
      result.maxPagesPerQuery = Math.min(result.maxPagesPerQuery, layer.maxPagesPerQuery);
    }
    if (layer.maxCreditsPerQuery !== undefined) {
      result.maxCreditsPerQuery = Math.min(result.maxCreditsPerQuery, layer.maxCreditsPerQuery);
    }
    if (layer.maxPagesPerDay !== undefined) {
      result.maxPagesPerDay =
        result.maxPagesPerDay === undefined
          ? layer.maxPagesPerDay
          : Math.min(result.maxPagesPerDay, layer.maxPagesPerDay);
    }
    if (layer.deadlineMs !== undefined) {
      result.deadlineMs = Math.min(result.deadlineMs, layer.deadlineMs);
    }
    if (layer.allowFullIndexRequest !== undefined) {
      result.allowFullIndexRequest = result.allowFullIndexRequest && layer.allowFullIndexRequest;
    }
    if (layer.allowAgentDiscovery !== undefined) {
      result.allowAgentDiscovery = result.allowAgentDiscovery && layer.allowAgentDiscovery;
    }
    if (layer.mapRouter !== undefined && ROUTER_RANK[layer.mapRouter] < ROUTER_RANK[result.mapRouter]) {
      result.mapRouter = layer.mapRouter;
    }
  }
  return result;
}

/**
 * Starter orgs (never funded) defer (`map`); funded orgs index fully.
 * Never `visual`: page-image embedding is an explicit, priced opt-in.
 */
export function defaultIndexingModeForOrg(input: { funded: boolean }): IndexingMode {
  return input.funded ? "full" : "map";
}

/** Typical image-page token count and Gemini image price, for page-embedding cost estimates. */
export const PAGE_EMBED_ESTIMATED_PAGE_TOKENS = 258;
export const GEMINI_IMAGE_USD_PER_MTOK = 0.45;

export const JINA_NANO_MODEL_SUFFIX = "jina-embeddings-v5-omni-nano";

/** URI of a registered Jina v5 omni nano private embedding endpoint, if any. */
export function findJinaNanoUri(): string | null {
  try {
    for (const endpoint of getPrivateModelEndpointRegistry().endpoints) {
      for (const model of endpoint.models) {
        if (model.capability === "embedding" && model.id.endsWith(JINA_NANO_MODEL_SUFFIX)) {
          return formatPrivateModelUri({ alias: endpoint.alias, model: model.id });
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Whether `visualPages.route` resolves to a registered private Jina endpoint (else hosted Gemini). */
export function pageEmbedRoutesPrivate(route: "auto" | "jina-private" | "gemini" = "auto"): boolean {
  const uri = route === "gemini" ? null : findJinaNanoUri();
  return uri !== null && lookupPrivateModelRoute({ ref: uri, capability: "embedding" }).ok;
}

/**
 * Estimated credits to embed `pages` page images. A page a model reads as an image is a Rich page
 * (PRICE_CARD), whichever route (hosted Gemini or a private endpoint) embeds it.
 */
export function estimatePageEmbedCredits(pages: number, _route: "auto" | "jina-private" | "gemini" = "auto"): number {
  return pageCredits("rich", Math.max(0, pages));
}

export type QueryTemperature = "cold" | "warm" | "hot";

export function classifyTemperature(candidatePages: number, indexedCandidatePages: number): QueryTemperature {
  if (candidatePages <= 0 || indexedCandidatePages >= candidatePages) return "hot";
  return indexedCandidatePages <= 0 ? "cold" : "warm";
}

export type PageLedgerState =
  | "unseen"
  | "claimed"
  | "parsed"
  | "pii-checked"
  | "indexed"
  | "failed"
  | "blocked-pii";

export type RetrievalStageLabel = "chunk" | "page-text" | "map-node" | "page-image";

export interface MaterializePagesInput {
  runId: string;
  documentId: string;
  pages: number[];
  reason: "query" | "full-index" | "backfill";
  sessionId: string | null;
  maxCredits: number;
}

/**
 * Deterministic Temporal workflow id for materializing a page set of one
 * document: identical concurrent starts dedupe on it. Pure (53-bit cyrb53 hash
 * of the sorted unique pages), so it behaves the same in any runtime.
 */
export function materializeWorkflowId(documentId: string, pages: number[]): string {
  const key = [...new Set(pages)].sort((a, b) => a - b).join(",");
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  return `materialize:${documentId}:${hash}`;
}

export const MATERIALIZE_WORKFLOW = "materializePages";
export const DEFAULT_MATERIALIZE_TASK_QUEUE = "docslurp-materialize";

export interface CapabilityClaims {
  v: 1;
  orgId: string;
  workspaceIds: string[];
  policy: Partial<MaterializationPolicy>;
  issuedByKeyId: string;
  boundClientKeyId?: string;
  allowedOrigins?: string[];
  exp: number;
  jti: string;
}

export const deferredSearchStatsSchema = z.object({
  temperature: z.enum(["cold", "warm", "hot"]),
  candidatePages: z.number().int(),
  indexedCandidatePages: z.number().int(),
  materializedPages: z.number().int(),
  pendingPages: z.number().int(),
  materializeMs: z.number(),
  creditsSpent: z.number(),
  routerUsed: z.boolean(),
  fallbackUsed: z.boolean(),
  stoppedBy: z.enum(["policy", "credits", "deadline"]).nullable(),
});
export type DeferredSearchStats = z.infer<typeof deferredSearchStatsSchema>;

export function deferredProfilesEnabled(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): boolean {
  return env.DOCSLURP_DEFERRED_PROFILES === "1";
}

/** With the flag off every requested or stored mode behaves as `full`. */
export function effectiveIndexingMode(mode: IndexingMode | null | undefined): IndexingMode {
  return deferredProfilesEnabled() ? (mode ?? "full") : "full";
}
