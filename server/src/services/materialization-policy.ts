import {
  DEFAULT_CLIENT_KEY_MATERIALIZATION_POLICY,
  DEFAULT_SERVER_MATERIALIZATION_POLICY,
  materializationPolicyOverridesSchema,
  narrowMaterializationPolicy,
  type MaterializationPolicy,
  type PipelineFeatures,
} from "@docslurp/shared";

import { peekCapabilityToken } from "../lib/capability-tokens.js";
import { getLiveApiKeyById, type ValidatedKey } from "./api-keys.js";

/**
 * Query-time page parsing is capped by a policy resolved most-restrictive-wins
 * across: the key-type default, the workspace pipeline, the presenting API
 * key, the capability's issuing key and the sealed capability itself. No layer
 * can widen another, so a browser holding a capability can only narrow what
 * its issuer was already allowed.
 */

export type CapabilityError = "capability_invalid" | "capability_expired" | "capability_origin" | "capability_scope";

export type ResolvedMaterializationPolicy =
  | { policy: MaterializationPolicy; sources: string[] }
  | { error: CapabilityError };

/** Revocation of an issuing key takes effect within this window. */
export const ISSUER_KEY_CACHE_MS = 60_000;
const ISSUER_CACHE_MAX = 5000;

type IssuerEntry = { at: number; key: Awaited<ReturnType<typeof getLiveApiKeyById>> };
const issuerCache = new Map<string, IssuerEntry>();

export function resetIssuerKeyCacheForTests(): void {
  issuerCache.clear();
}

async function issuerKey(keyId: string, nowMs: number): Promise<IssuerEntry["key"]> {
  const hit = issuerCache.get(keyId);
  if (hit && nowMs - hit.at < ISSUER_KEY_CACHE_MS && nowMs >= hit.at) return hit.key;
  const key = await getLiveApiKeyById(keyId);
  if (issuerCache.size >= ISSUER_CACHE_MAX) issuerCache.delete(issuerCache.keys().next().value!);
  issuerCache.set(keyId, { at: nowMs, key });
  return key;
}

function normalizeOrigin(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, "");
}

export async function resolveMaterializationPolicy(args: {
  workspacePipeline: PipelineFeatures;
  apiKey?: ValidatedKey | null;
  capabilityHeader?: string | null;
  origin?: string | null;
  workspaceId: string;
  nowMs?: number;
}): Promise<ResolvedMaterializationPolicy> {
  const nowMs = args.nowMs ?? Date.now();
  const { apiKey } = args;
  const sources: string[] = [];
  const base = apiKey?.keyType === "client" ? DEFAULT_CLIENT_KEY_MATERIALIZATION_POLICY : DEFAULT_SERVER_MATERIALIZATION_POLICY;
  sources.push(apiKey?.keyType === "client" ? "default:client-key" : "default:server");
  const layers: Array<Partial<MaterializationPolicy>> = [];

  const workspaceLayer = args.workspacePipeline.materialization;
  if (workspaceLayer && Object.keys(workspaceLayer).length > 0) {
    layers.push(workspaceLayer);
    sources.push("workspace");
  }
  if (apiKey?.materializationPolicy && Object.keys(apiKey.materializationPolicy).length > 0) {
    layers.push(apiKey.materializationPolicy);
    sources.push("api-key");
  }

  const header = args.capabilityHeader?.trim();
  if (header) {
    const claims = peekCapabilityToken(header);
    if (!claims) return { error: "capability_invalid" };
    if (claims.exp * 1000 <= nowMs) return { error: "capability_expired" };
    const tokenPolicy = materializationPolicyOverridesSchema.safeParse(claims.policy);
    if (!tokenPolicy.success) return { error: "capability_invalid" };
    if (!claims.workspaceIds.includes(args.workspaceId)) return { error: "capability_scope" };
    if (apiKey?.orgId && apiKey.orgId !== claims.orgId) return { error: "capability_scope" };
    if (claims.allowedOrigins?.length) {
      const origin = args.origin ? normalizeOrigin(args.origin) : null;
      if (!origin || !claims.allowedOrigins.some((allowed) => normalizeOrigin(allowed) === origin)) {
        return { error: "capability_origin" };
      }
    }
    if (claims.boundClientKeyId && apiKey?.keyId !== claims.boundClientKeyId) return { error: "capability_scope" };

    // Sessions have no key to revoke; their capabilities live and die with the short exp.
    if (!claims.issuedByKeyId.startsWith("session:")) {
      const issuer = await issuerKey(claims.issuedByKeyId, nowMs);
      // The issuer's authority is re-checked now, not just at mint time.
      if (!issuer || issuer.keyType !== "server" || !issuer.scopes.includes("search")) return { error: "capability_invalid" };
      if (issuer.workspaceIds.length > 0 && !issuer.workspaceIds.includes(args.workspaceId)) return { error: "capability_scope" };
      if (Object.keys(issuer.materializationPolicy).length > 0) {
        layers.push(issuer.materializationPolicy);
        sources.push("capability-issuer");
      }
    }
    layers.push(tokenPolicy.data);
    sources.push("capability");
  }

  return { policy: narrowMaterializationPolicy(base, ...layers), sources };
}
