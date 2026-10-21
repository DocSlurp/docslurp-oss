import type postgres from "postgres";
import { randomBytes, randomUUID, createHash } from "node:crypto";

import { apiKeyRateLimitRulesSchema, materializationPolicyOverridesSchema, type ApiKeyRateLimitRule, type MaterializationPolicy } from "@docslurp/shared";

import { sql } from "../db.js";
import { recordApiKeyRequest } from "./api-key-usage.js";
import { ensurePersonalOrganization, getOrganization, OrganizationError, withOrganizationLock } from "./organizations.js";

type ApiKeyRow = {
  id: string;
  user_id: string;
  org_id: string | null;
  key_hash: string;
  name: string;
  key_type: string | null;
  allowed_domains: string[] | null;
  scopes: string[];
  rate_limit_rpm: number | null;
  rate_limit_ppd: number;
  rate_limits: unknown;
  workspace_ids: string[] | null;
  materialization_policy?: unknown;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
  requests_last_minute?: number;
  pages_today?: number;
};

export const defaultApiKeyScopes = ["ingest", "search", "artifacts"] as const;
/** Client (browser) keys are search-only unless the creator opts in to more. */
export const defaultClientApiKeyScopes = ["search"] as const;
/** Scopes a public client key may hold only with an explicit opt-in and a workspace allowlist. */
export const sensitiveClientApiKeyScopes = ["ingest", "artifacts"] as const;
/** Opt-in scopes; never granted by default. workspaces:manage renames workspaces and changes their settings. */
export const supportedApiKeyScopes = [...defaultApiKeyScopes, "organizations:read", "organizations:manage", "workspaces:manage"] as const;
export const apiKeyTypes = ["server", "client"] as const;
export type ApiKeyType = (typeof apiKeyTypes)[number];

export interface ApiKey {
  id: string;
  userId: string;
  orgId: string | null;
  name: string;
  keyType: ApiKeyType;
  allowedDomains: string[];
  scopes: string[];
  /** Optional requests-per-minute cap below the plan's per-category limits; null means the plan's limits. */
  rateLimitRpm: number | null;
  rateLimitPpd: number;
  /** Custom request and spend limits; see packages/shared/src/rate-limits.ts. */
  rateLimits: ApiKeyRateLimitRule[];
  /** Workspaces this key may use; empty means every workspace the owner can reach in the key's org. */
  workspaceIds: string[];
  /** Per-key caps on query-time page parsing; `{}` adds no restriction. */
  materializationPolicy?: Partial<MaterializationPolicy>;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  requestsLastMinute?: number;
  pagesToday?: number;
}

/**
 * Key prefixes make a key's exposure class visible wherever it is pasted or leaked:
 * `dslp_pub_` keys are browser/embed (client) keys, `dslp_priv_` keys are server keys.
 * Keys issued before typed prefixes (`dslp_<hex>`) keep working.
 */
export const apiKeyPrefixes = { client: "dslp_pub_", server: "dslp_priv_" } as const satisfies Record<ApiKeyType, string>;

function generateRawKey(keyType: ApiKeyType): string {
  return `${apiKeyPrefixes[keyType]}${randomBytes(32).toString("hex")}`;
}

/** The type a raw key's prefix claims, or null for legacy untyped keys. */
export function apiKeyTypeFromPrefix(rawKey: string): ApiKeyType | null {
  if (rawKey.startsWith(apiKeyPrefixes.client)) return "client";
  if (rawKey.startsWith(apiKeyPrefixes.server)) return "server";
  return null;
}

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

function parseApiKeyType(value: string | null | undefined): ApiKeyType {
  return value === "client" ? "client" : "server";
}

function normalizeAllowedDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new Error("Allowed domains cannot be empty");
  }

  const withoutWildcard = trimmed.replace(/^\*\./, "").replace(/^\./, "");
  const candidate = /^[a-z]+:\/\//.test(withoutWildcard) ? withoutWildcard : `https://${withoutWildcard}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid allowed domain: ${value}`);
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error(`Allowed domains must be hostnames only: ${value}`);
  }

  const hostname = parsed.hostname.trim().toLowerCase();
  if (!hostname) {
    throw new Error(`Invalid allowed domain: ${value}`);
  }

  return hostname;
}

function normalizeAllowedDomains(allowedDomains: string[] | undefined | null, keyType: ApiKeyType): string[] {
  const normalized = [...new Set((allowedDomains ?? []).map(normalizeAllowedDomain))];
  if (keyType === "client" && normalized.length === 0) {
    throw new Error("Client API keys must include at least one allowed domain");
  }
  return keyType === "server" ? [] : normalized;
}

function resolveRequestHostname(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") {
    return null;
  }

  try {
    return new URL(trimmed).hostname.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

function isAllowedClientHostname(requestHostname: string | null, allowedDomains: string[]): boolean {
  if (!requestHostname || allowedDomains.length === 0) {
    return false;
  }

  return allowedDomains.some((allowedDomain) =>
    requestHostname === allowedDomain || requestHostname.endsWith(`.${allowedDomain}`)
  );
}

/** Stored rules are re-validated on read so a malformed row can never break auth. */
export function parseApiKeyRateLimits(value: unknown): ApiKeyRateLimitRule[] {
  const parsed = apiKeyRateLimitRulesSchema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

/** Stored policy is re-validated on read so a malformed row can never break auth; invalid means no overrides. */
export function parseKeyMaterializationPolicy(value: unknown): Partial<MaterializationPolicy> {
  const parsed = materializationPolicyOverridesSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

function mapApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    name: row.name,
    keyType: parseApiKeyType(row.key_type),
    allowedDomains: row.allowed_domains ?? [],
    scopes: row.scopes ?? [...defaultApiKeyScopes],
    rateLimitRpm: row.rate_limit_rpm,
    rateLimitPpd: row.rate_limit_ppd,
    rateLimits: parseApiKeyRateLimits(row.rate_limits),
    workspaceIds: row.workspace_ids ?? [],
    materializationPolicy: parseKeyMaterializationPolicy(row.materialization_policy),
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    requestsLastMinute: row.requests_last_minute ?? 0,
    pagesToday: row.pages_today ?? 0,
  };
}

export async function createApiKey(
  userId: string,
  name: string,
  limits?: {
    /** Requests-per-minute cap; omitted or null leaves the key on the plan's limits. */
    rpm?: number | null;
    ppd?: number;
    rateLimits?: ApiKeyRateLimitRule[];
    scopes?: string[];
    orgId?: string | null;
    keyType?: ApiKeyType;
    allowedDomains?: string[];
    workspaceIds?: string[];
    /** Required to give a client key ingest or artifacts (with a workspace allowlist). */
    allowClientSensitiveScopes?: boolean;
    materializationPolicy?: Partial<MaterializationPolicy>;
  }
): Promise<{ key: ApiKey; rawKey: string }> {
  const id = randomUUID();
  const requestedOrg = limits?.orgId ? await getOrganization(limits.orgId, userId) : null;
  if (limits?.orgId && !requestedOrg) {
    throw new OrganizationError(404, "organization_not_found", "Organization not found");
  }
  const orgId = requestedOrg?.id ?? (await ensurePersonalOrganization(userId)).id;
  const keyType = limits?.keyType ?? ((limits?.allowedDomains?.length ?? 0) > 0 ? "client" : "server");
  const rawKey = generateRawKey(keyType);
  const keyHash = hashKey(rawKey);
  const allowedDomains = normalizeAllowedDomains(limits?.allowedDomains, keyType);
  const scopes = limits?.scopes?.length
    ? [...new Set(limits.scopes)]
    : [...(keyType === "client" ? defaultClientApiKeyScopes : defaultApiKeyScopes)];
  return await withOrganizationLock(orgId, userId, async (tx, actor) => {
    assertOrganizationKeyScopes(keyType, scopes, actor.role);
    const workspaceIds = await normalizeKeyWorkspaceIds(tx, orgId, userId, limits?.workspaceIds);
    assertClientKeySensitiveScopes(keyType, scopes, workspaceIds, limits?.allowClientSensitiveScopes === true);
    const [row] = await tx<ApiKeyRow[]>`
      insert into api_keys (id, user_id, org_id, key_hash, name, key_type, allowed_domains, scopes, rate_limit_rpm, rate_limit_ppd, rate_limits, workspace_ids, materialization_policy)
      values (${id}, ${userId}, ${orgId}, ${keyHash}, ${name}, ${keyType}, ${tx.array(allowedDomains)},
        ${tx.array(scopes)}, ${limits?.rpm ?? null}, ${limits?.ppd ?? 10000},
        ${tx.json(apiKeyRateLimitRulesSchema.parse(limits?.rateLimits ?? []) as never)}, ${tx.array(workspaceIds)},
        ${tx.json(materializationPolicyOverridesSchema.parse(limits?.materializationPolicy ?? {}) as never)})
      returning *`;
    return { key: mapApiKey(row!), rawKey };
  });
}

export async function listApiKeys(userId: string): Promise<ApiKey[]> {
  const rows = await sql<ApiKeyRow[]>`
    select
      k.*,
      coalesce((
        select sum(u.request_count)::int
        from api_key_usage u
        where u.key_id = k.id
          and u.minute_bucket >= date_trunc('minute', now())
      ), 0) as requests_last_minute,
      coalesce((
        select sum(u.page_count)::int
        from api_key_usage u
        where u.key_id = k.id
          and u.minute_bucket >= date_trunc('day', now())
      ), 0) as pages_today
    from api_keys k
    where k.user_id = ${userId}
    order by created_at desc
  `;
  return rows.map(mapApiKey);
}

async function requireOrgAdmin(orgId: string, userId: string): Promise<void> {
  const organization = await getOrganization(orgId, userId);
  if (!organization) {
    throw new OrganizationError(404, "organization_not_found", "Organization not found");
  }

  if (organization.memberRole !== "owner" && organization.memberRole !== "admin") {
    throw new OrganizationError(403, "organization_forbidden", "Organization admin access required");
  }
}

export async function listOrganizationApiKeys(orgId: string, userId: string): Promise<ApiKey[]> {
  await requireOrgAdmin(orgId, userId);

  const rows = await sql<ApiKeyRow[]>`
    select
      k.*,
      coalesce((
        select sum(u.request_count)::int
        from api_key_usage u
        where u.key_id = k.id
          and u.minute_bucket >= date_trunc('minute', now())
      ), 0) as requests_last_minute,
      coalesce((
        select sum(u.page_count)::int
        from api_key_usage u
        where u.key_id = k.id
          and u.minute_bucket >= date_trunc('day', now())
      ), 0) as pages_today
    from api_keys k
    where k.org_id = ${orgId}
    order by created_at desc
  `;

  return rows.map(mapApiKey);
}

export async function revokeOrganizationApiKeys(orgId: string, userId: string): Promise<ApiKey[]> {
  return await withOrganizationLock(orgId, userId, async (tx, actor) => {
    if (actor.role !== "owner" && actor.role !== "admin") throw new OrganizationError(403, "organization_forbidden", "Organization admin access required");
    const rows = await tx<ApiKeyRow[]>`update api_keys set revoked_at = now() where org_id = ${orgId} and revoked_at is null returning *`;
    await tx`insert into audit_log (id, org_id, user_id, action, resource_type, resource_id, metadata)
      values (${randomUUID()}, ${orgId}, ${userId}, 'organization.api_keys.revoked', 'organization', ${orgId}, ${tx.json({ revokedCount: rows.length })})`;
    return rows.map(mapApiKey);
  });
}

function assertOrganizationKeyScopes(keyType: ApiKeyType, scopes: string[], role: string) {
  if (scopes.some(scope => !(supportedApiKeyScopes as readonly string[]).includes(scope))) throw new OrganizationError(400, "invalid_key_scope", "Unsupported API key scope");
  if (keyType === "client" && scopes.includes("workspaces:manage")) {
    throw new OrganizationError(400, "invalid_key_scope", "Client API keys cannot manage workspaces");
  }
  if (!scopes.some(scope => scope.startsWith("organizations:"))) return;
  if (keyType === "client") throw new OrganizationError(400, "invalid_key_scope", "Client API keys cannot access organizations");
  if (scopes.includes("organizations:manage") && !["owner", "admin"].includes(role))
    throw new OrganizationError(403, "organization_forbidden", "Organization management keys require admin access");
}

type KeyTransaction = postgres.TransactionSql<Record<string, postgres.PostgresType>>;

/**
 * A public client key that can upload or read raw artifacts is a standing
 * credential in someone's page source. Allow it only when the creator opts in
 * and binds the key to specific workspaces.
 */
export function assertClientKeySensitiveScopes(keyType: ApiKeyType, scopes: string[], workspaceIds: string[], optedIn: boolean) {
  if (keyType !== "client") return;
  const sensitive = scopes.filter(scope => (sensitiveClientApiKeyScopes as readonly string[]).includes(scope));
  if (sensitive.length === 0) return;
  if (!optedIn) {
    throw new OrganizationError(400, "client_key_scope_opt_in_required",
      `Client API keys are search-only by default. Set allowClientSensitiveScopes to grant ${sensitive.join(" and ")}.`);
  }
  if (workspaceIds.length === 0) {
    throw new OrganizationError(400, "client_key_workspaces_required",
      `Client API keys with ${sensitive.join(" or ")} must be limited to specific workspaces.`);
  }
}

/** Runtime guard for rows written before the opt-in rule: no allowlist, no sensitive client scopes. */
export function effectiveKeyScopes(keyType: ApiKeyType, scopes: string[], workspaceIds: string[]): string[] {
  if (keyType !== "client" || workspaceIds.length > 0) return scopes;
  const narrowed = scopes.filter(scope => !(sensitiveClientApiKeyScopes as readonly string[]).includes(scope));
  return narrowed.length > 0 ? narrowed : [...defaultClientApiKeyScopes];
}

/** Every allowlisted workspace must be in the key's org and reachable by its owner. */
async function normalizeKeyWorkspaceIds(tx: KeyTransaction, orgId: string, userId: string, workspaceIds: string[] | undefined): Promise<string[]> {
  const requested = [...new Set((workspaceIds ?? []).map(id => id.trim()).filter(Boolean))];
  if (requested.length === 0) return [];
  if (requested.length > 100) throw new OrganizationError(400, "invalid_key_workspaces", "An API key can be limited to at most 100 workspaces");
  const rows = await tx<{ id: string }[]>`
    select w.id from workspaces w
    where w.id = any(${tx.array(requested)}) and w.org_id = ${orgId}
      and (
        w.user_id = ${userId}
        or exists (select 1 from workspace_members wm where wm.workspace_id = w.id and wm.user_id = ${userId})
        or exists (select 1 from org_memberships om where om.org_id = w.org_id and om.user_id = ${userId} and (om.role in ('owner', 'admin') or w.is_default))
      )`;
  const found = new Set(rows.map(row => row.id));
  const missing = requested.filter(id => !found.has(id));
  if (missing.length > 0) {
    throw new OrganizationError(400, "invalid_key_workspaces", `Workspace not found in this key's organization: ${missing.join(", ")}`);
  }
  return requested;
}
async function withOwnedKeyLock<T>(id: string, userId: string, operation: (tx: KeyTransaction, existing: ApiKeyRow, role: string) => Promise<T>): Promise<T | null> {
  const [binding] = await sql<{ org_id: string | null }[]>`select org_id from api_keys where id = ${id} and user_id = ${userId} and revoked_at is null`;
  if (!binding?.org_id) return null;
  return await withOrganizationLock(binding.org_id, userId, async (tx, actor) => {
    const [existing] = await tx<ApiKeyRow[]>`select * from api_keys where id = ${id} and user_id = ${userId} and revoked_at is null for update`;
    if (!existing) return null;
    return await operation(tx, existing, actor.role);
  });
}

export class ApiKeyTypeChangeError extends Error {
  readonly status = 409;
  readonly code = "api_key_type_immutable";
  constructor() {
    super("A key's type is fixed when it is created. Create a new key of the other type instead.");
  }
}

export async function updateApiKey(id: string, userId: string, updates: {
  name?: string; scopes?: string[]; rateLimitRpm?: number | null; rateLimitPpd?: number; rateLimits?: ApiKeyRateLimitRule[]; keyType?: ApiKeyType; allowedDomains?: string[];
  workspaceIds?: string[]; allowClientSensitiveScopes?: boolean; materializationPolicy?: Partial<MaterializationPolicy>;
}): Promise<ApiKey | null> {
  return await withOwnedKeyLock(id, userId, async (tx, existing, role) => {
    const nextKeyType = parseApiKeyType(existing.key_type);
    // The secret's prefix records its type, so a browser key can never be promoted in place.
    if (updates.keyType !== undefined && updates.keyType !== nextKeyType) {
      throw new ApiKeyTypeChangeError();
    }
    const nextScopes = updates.scopes ? [...new Set(updates.scopes)] : existing.scopes;
    assertOrganizationKeyScopes(nextKeyType, nextScopes, role);
    const nextWorkspaceIds = updates.workspaceIds !== undefined
      ? await normalizeKeyWorkspaceIds(tx, existing.org_id!, userId, updates.workspaceIds)
      : existing.workspace_ids ?? [];
    if (updates.scopes !== undefined || updates.workspaceIds !== undefined) {
      assertClientKeySensitiveScopes(nextKeyType, nextScopes, nextWorkspaceIds, updates.allowClientSensitiveScopes === true);
    }
    const normalizedAllowedDomains = updates.allowedDomains !== undefined
      ? normalizeAllowedDomains(updates.allowedDomains ?? existing.allowed_domains ?? [], nextKeyType) : null;
    const [row] = await tx<ApiKeyRow[]>`update api_keys set
      name = coalesce(${updates.name ?? null}, name), allowed_domains = coalesce(${normalizedAllowedDomains ? tx.array(normalizedAllowedDomains) : null}, allowed_domains),
      scopes = coalesce(${updates.scopes ? tx.array(nextScopes) : null}, scopes),
      workspace_ids = ${tx.array(nextWorkspaceIds)},
      rate_limit_rpm = case when ${updates.rateLimitRpm !== undefined} then ${updates.rateLimitRpm ?? null}::int else rate_limit_rpm end, rate_limit_ppd = coalesce(${updates.rateLimitPpd ?? null}, rate_limit_ppd),
      rate_limits = coalesce(${updates.rateLimits ? tx.json(apiKeyRateLimitRulesSchema.parse(updates.rateLimits) as never) : null}::jsonb, rate_limits),
      materialization_policy = coalesce(${updates.materializationPolicy ? tx.json(materializationPolicyOverridesSchema.parse(updates.materializationPolicy) as never) : null}::jsonb, materialization_policy)
      where id = ${id} and user_id = ${userId} and revoked_at is null returning *`;
    return row ? mapApiKey(row) : null;
  });
}

export async function rotateApiKey(id: string, userId: string): Promise<{ key: ApiKey; rawKey: string } | null> {
  return await withOwnedKeyLock(id, userId, async (tx, existing, role) => {
    assertOrganizationKeyScopes(parseApiKeyType(existing.key_type), existing.scopes, role);
    const rawKey = generateRawKey(parseApiKeyType(existing.key_type));
    const [row] = await tx<ApiKeyRow[]>`update api_keys set key_hash = ${hashKey(rawKey)}, last_used_at = null
      where id = ${id} and user_id = ${userId} and revoked_at is null returning *`;
    return row ? { key: mapApiKey(row), rawKey } : null;
  });
}

export async function revokeApiKey(id: string, userId: string): Promise<ApiKey | null> {
  const [row] = await sql<ApiKeyRow[]>`
    update api_keys
    set revoked_at = now()
    where id = ${id} and user_id = ${userId} and revoked_at is null
    returning *
  `;
  return row ? mapApiKey(row) : null;
}

export interface ValidatedKey {
  keyId: string;
  userId: string;
  orgId: string | null;
  keyType: ApiKeyType;
  allowedDomains: string[];
  scopes: string[];
  /** Optional requests-per-minute cap; null (or 0) means the plan's limits apply. */
  rateLimitRpm: number | null;
  rateLimitPpd: number;
  rateLimits: ApiKeyRateLimitRule[];
  /** Workspace allowlist; empty means every workspace the owner can reach in `orgId`. */
  workspaceIds: string[];
  /** Per-key materialization caps; absent or `{}` adds no restriction. */
  materializationPolicy?: Partial<MaterializationPolicy>;
}

export async function validateApiKey(
  rawKey: string,
  requestContext?: { origin?: string | null; referer?: string | null }
): Promise<ValidatedKey | null> {
  const keyHash = hashKey(rawKey);

  const [row] = await sql<ApiKeyRow[]>`
    select * from api_keys
    where key_hash = ${keyHash} and revoked_at is null
      and exists (
        select 1 from org_memberships om
        where om.org_id = api_keys.org_id and om.user_id = api_keys.user_id
      )
  `;

  if (!row || !row.org_id) return null;

  const keyType = parseApiKeyType(row.key_type);
  // Defense in depth: a typed prefix that disagrees with the stored type never authenticates.
  const claimedType = apiKeyTypeFromPrefix(rawKey);
  if (claimedType && claimedType !== keyType) return null;
  const allowedDomains = row.allowed_domains ?? [];
  if (
    keyType === "client" &&
    !isAllowedClientHostname(
      resolveRequestHostname(requestContext?.origin != null ? requestContext.origin : requestContext?.referer),
      allowedDomains
    )
  ) {
    return null;
  }

  // Usage statistics are buffered; every limit, including the daily page cap,
  // is enforced by the rate-limit middleware.
  recordApiKeyRequest(row.id);

  return {
    keyId: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    keyType,
    allowedDomains,
    scopes: effectiveKeyScopes(keyType, row.scopes ?? [...defaultApiKeyScopes], row.workspace_ids ?? []),
    rateLimitRpm: row.rate_limit_rpm,
    rateLimitPpd: row.rate_limit_ppd,
    rateLimits: parseApiKeyRateLimits(row.rate_limits),
    workspaceIds: row.workspace_ids ?? [],
    materializationPolicy: parseKeyMaterializationPolicy(row.materialization_policy),
  };
}

/**
 * Liveness and policy of one key by id, for sealed capability tokens issued
 * under it. Skips the type/domain checks: the token holder is not the key.
 * Null when the key is revoked, gone, or its owner left the organization.
 */
export async function getLiveApiKeyById(keyId: string): Promise<{ keyType: ApiKeyType; scopes: string[]; workspaceIds: string[]; materializationPolicy: Partial<MaterializationPolicy> } | null> {
  const [row] = await sql<ApiKeyRow[]>`
    select * from api_keys
    where id = ${keyId} and revoked_at is null
      and exists (
        select 1 from org_memberships om
        where om.org_id = api_keys.org_id and om.user_id = api_keys.user_id
      )
  `;
  const keyType = row ? parseApiKeyType(row.key_type) : null;
  return row && keyType ? { keyType, scopes: effectiveKeyScopes(keyType, row.scopes ?? [...defaultApiKeyScopes], row.workspace_ids ?? []), workspaceIds: row.workspace_ids ?? [], materializationPolicy: parseKeyMaterializationPolicy(row.materialization_policy) } : null;
}
