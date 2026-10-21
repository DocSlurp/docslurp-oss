import {
  DEFAULT_CLIENT_KEY_MATERIALIZATION_POLICY,
  type MaterializationPolicy,
  type PipelineFeatures,
} from "@docslurp/shared";

import { currentRequestApiKeyId, currentRequestCapability } from "../../lib/request-context.js";
import { getLiveApiKeyById, type ValidatedKey } from "../../services/api-keys.js";
import { resolveMaterializationPolicy } from "../../services/materialization-policy.js";
import type { DeferredRequestContext } from "./deferred-context.js";

/** No page may be materialized; already-indexed results are still returned. */
export const FAIL_CLOSED_POLICY: MaterializationPolicy = {
  ...DEFAULT_CLIENT_KEY_MATERIALIZATION_POLICY,
  maxPagesPerQuery: 0,
  maxCreditsPerQuery: 0,
  allowAgentDiscovery: false,
  mapRouter: "off",
};

export interface RequestPolicyDeps {
  keyId(): string | null;
  /** The request's `X-DocSlurp-Capability` token and `Origin`, for routes that carry no deferred context. */
  capability?(): { header: string | null; origin: string | null };
  lookupKey: typeof getLiveApiKeyById;
  resolve: typeof resolveMaterializationPolicy;
}

/** A revoked key stops narrowing/identifying requests within this window (same as the capability issuer cache). */
const KEY_CACHE_MS = 60_000;
const KEY_CACHE_MAX = 5000;
type LiveKey = Awaited<ReturnType<typeof getLiveApiKeyById>>;
const keyCache = new Map<string, { at: number; key: LiveKey }>();

export function resetRequestPolicyCacheForTests(): void {
  keyCache.clear();
}

async function cachedLiveKey(keyId: string, lookup: RequestPolicyDeps["lookupKey"], nowMs = Date.now()): Promise<LiveKey> {
  const hit = keyCache.get(keyId);
  if (hit && nowMs - hit.at < KEY_CACHE_MS && nowMs >= hit.at) return hit.key;
  const key = await lookup(keyId);
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value!);
  keyCache.set(keyId, { at: nowMs, key });
  return key;
}

const defaultDeps: RequestPolicyDeps = {
  keyId: currentRequestApiKeyId,
  capability: currentRequestCapability,
  lookupKey: getLiveApiKeyById,
  resolve: resolveMaterializationPolicy,
};

/**
 * Policy for one search. Routes with a request context supply it; callers
 * without one (chat completions, Algolia/search compat, aggregate, automation)
 * still run under the request's own API key, never the server defaults. A key
 * that cannot be resolved fails closed rather than widening.
 */
export async function resolveSearchMaterializationPolicy(
  args: { context?: DeferredRequestContext; workspacePipeline: PipelineFeatures; workspaceId: string },
  deps: RequestPolicyDeps = defaultDeps,
): Promise<MaterializationPolicy> {
  if (args.context?.policy) return args.context.policy;
  let apiKey: ValidatedKey | null = args.context?.apiKey ?? null;
  if (!apiKey) {
    const keyId = deps.keyId();
    if (keyId) {
      const live = await cachedLiveKey(keyId, deps.lookupKey).catch(() => null);
      if (!live) return FAIL_CLOSED_POLICY;
      apiKey = { ...live, keyId, userId: "", orgId: null, allowedDomains: [], rateLimitRpm: null, rateLimitPpd: 0, rateLimits: [] } as ValidatedKey;
    }
  }
  const capability = args.context ? null : deps.capability?.() ?? null;
  const resolved = await deps.resolve({
    workspacePipeline: args.workspacePipeline, apiKey, workspaceId: args.workspaceId,
    ...(capability?.header ? { capabilityHeader: capability.header, origin: capability.origin } : {}),
  });
  return "error" in resolved ? FAIL_CLOSED_POLICY : resolved.policy;
}
