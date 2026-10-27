import type postgres from "postgres";
import { randomBytes, randomUUID, createHash } from "node:crypto";

import { apiKeyRateLimitRulesSchema, materializationPolicyOverridesSchema, type ApiKeyRateLimitRule, type MaterializationPolicy } from "@docslurp/shared";

import { sql } from "../db.js";
import { ipInRange, parseCidr, parseIp } from "@docslurp/shared/client-ip";
import { AllowedOriginError, normalizeAllowedOriginEntry, originMatchesAllowlist } from "../lib/allowed-origins.js";
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
  expires_at?: string | Date | null;
  last_used_ip?: string | null;
  ip_allowlist?: string[] | null;
  max_output_tokens?: number | null;
  rotated_from_key_id?: string | null;
  requests_last_minute?: number;
  pages_today?: number;
};

/**
 * `search` returns passages; `chat` generates answers (a model call on the
 * owner's credits) through /v1/chat, /v1/chat/completions and the MCP chat tool.
 */
export const defaultApiKeyScopes = ["ingest", "search", "chat", "artifacts"] as const;
/** Client (browser) keys are search-only unless the creator adds `chat`. */
export const defaultClientApiKeyScopes = ["search"] as const;
/** Everything a browser (client) key may ever hold: it sits in page source, so never more than search and chat. */
export const clientApiKeyScopes = ["search", "chat"] as const;
/**
 * Scopes a browser key never holds. Keys written before this rule may still
 * carry them; effectiveKeyScopes drops them at request time.
 */
export const sensitiveClientApiKeyScopes = ["ingest", "artifacts", "web"] as const;

/** Chat answer output caps a key may set (model max output tokens). */
export const clientMaxOutputTokenChoices = [500, 1000, 2000] as const;
export const serverMaxOutputTokenChoices = [500, 1000, 2000, 4000] as const;
/** A browser key without its own setting answers with at most this many output tokens. */
export const CLIENT_DEFAULT_MAX_OUTPUT_TOKENS = 1000;
/** Longest expiry a key may be given at creation (Better Auth's API key plugin default ceiling). */
export const API_KEY_MAX_EXPIRY_DAYS = 365;
/** Longest window an old key keeps working after an overlapping rotation. */
export const API_KEY_MAX_ROTATION_OVERLAP_SECONDS = 7 * 24 * 60 * 60;
export const API_KEY_MAX_IP_ALLOWLIST = 50;
/**
 * Opt-in scopes; never granted by default. workspaces:manage renames workspaces and changes their settings.
 * `web` is client-key only: server keys use web tools through `search`.
 */
export const supportedApiKeyScopes = [...defaultApiKeyScopes, "web", "organizations:read", "organizations:manage", "workspaces:manage"] as const;
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
  /** Client address of the latest request (buffered with lastUsedAt). */
  lastUsedIp: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** When the key stops authenticating; null means no expiry. */
  expiresAt: string | null;
  /** Server keys: CIDRs the key may be used from; empty means any address. */
  ipAllowlist: string[];
  /** The key's own chat output cap as stored (null: browser default 1000, or no cap for server keys). */
  maxOutputTokens: number | null;
  /** The key this one replaced in an overlapping rotation. */
  rotatedFromKeyId: string | null;
  requestsLastMinute?: number;
  pagesToday?: number;
}

const isoOrNull = (value: string | Date | null | undefined): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/** The chat output cap that applies to a key: its own setting, else 1000 for browser keys, else none. */
export function effectiveMaxOutputTokens(keyType: ApiKeyType, stored: number | null | undefined): number | null {
  if (typeof stored === "number" && stored > 0) return stored;
  return keyType === "client" ? CLIENT_DEFAULT_MAX_OUTPUT_TOKENS : null;
}

function normalizeMaxOutputTokens(keyType: ApiKeyType, value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const choices: readonly number[] = keyType === "client" ? clientMaxOutputTokenChoices : serverMaxOutputTokenChoices;
  if (!choices.includes(value)) {
    throw new OrganizationError(400, "invalid_max_output_tokens", `${keyType === "client" ? "Browser" : "Server"} keys can cap chat output at ${choices.join(", ")} tokens${keyType === "server" ? ", or have no cap" : ""}.`);
  }
  return value;
}

function normalizeExpiresAt(value: string | null | undefined, now = Date.now()): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || at.getTime() <= now) throw new OrganizationError(400, "invalid_key_expiry", "A key's expiry must be a future date and time.");
  if (at.getTime() > now + API_KEY_MAX_EXPIRY_DAYS * 86_400_000) throw new OrganizationError(400, "invalid_key_expiry", `A key can expire at most ${API_KEY_MAX_EXPIRY_DAYS} days from now.`);
  return at;
}

function normalizeIpAllowlist(keyType: ApiKeyType, entries: string[] | undefined | null): string[] {
  const list = [...new Set((entries ?? []).map((entry) => entry.trim()).filter(Boolean))];
  if (list.length === 0) return [];
  if (keyType === "client") throw new OrganizationError(400, "invalid_ip_allowlist", "Browser keys are used from visitors' addresses, so they can't have an IP allowlist. Limit them by website instead.");
  if (list.length > API_KEY_MAX_IP_ALLOWLIST) throw new OrganizationError(400, "invalid_ip_allowlist", `An API key can list at most ${API_KEY_MAX_IP_ALLOWLIST} IP ranges.`);
  return list.map((entry) => {
    const range = parseCidr(entry);
    if (!range) throw new OrganizationError(400, "invalid_ip_allowlist", `Not an IP address or CIDR range: ${entry}`);
    const max = range.family === 4 ? 32 : 128;
    if (range.bits === 0) throw new OrganizationError(400, "invalid_ip_allowlist", `${entry} allows every address; leave the list empty instead.`);
    return range.bits === max ? entry.split("/")[0]!.trim() : entry;
  });
}

/** Whether a request address is inside a key's CIDR allowlist; an unknown address never is. */
export function ipAllowed(ip: string | null | undefined, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const parsed = parseIp(ip);
  if (!parsed) return false;
  return allowlist.some((entry) => {
    const range = parseCidr(entry);
    return range ? ipInRange(parsed, range) : false;
  });
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

function normalizeAllowedDomains(allowedDomains: string[] | undefined | null, keyType: ApiKeyType): string[] {
  let normalized: string[];
  try {
    normalized = [...new Set((allowedDomains ?? []).map(normalizeAllowedOriginEntry))];
  } catch (error) {
    if (error instanceof AllowedOriginError) throw new OrganizationError(400, "invalid_allowed_domain", error.message);
    throw error;
  }
  if (keyType === "client" && normalized.length === 0) {
    throw new OrganizationError(400, "invalid_allowed_domain", "Client API keys must include at least one allowed domain");
  }
  return keyType === "server" ? [] : normalized;
}

/** How to fix a browser key that has no workspace allowlist; shown on refusal and on save. */
export const CLIENT_KEY_WORKSPACES_REQUIRED_MESSAGE = "Browser (client) API keys must be limited to specific workspaces. Edit the key on the API keys page, or PATCH /v1/api-keys/:id with workspaceIds, and choose the workspaces it may use.";

/**
 * A browser key is public, so it must name the workspaces it may reach: an
 * empty allowlist would otherwise mean every workspace its owner can reach.
 */
export function assertClientKeyWorkspaces(keyType: ApiKeyType, workspaceIds: string[]): void {
  if (keyType === "client" && workspaceIds.length === 0) {
    throw new OrganizationError(400, "client_key_workspaces_required", CLIENT_KEY_WORKSPACES_REQUIRED_MESSAGE);
  }
}

/**
 * A browser key refused for a reason its owner can fix. Answered with its own
 * code and copy instead of the generic invalid-key refusal: the key is public
 * (it sits in page source), so naming the reason reveals nothing secret.
 */
export class ApiKeyPolicyError extends Error {
  readonly status = 403;
  constructor(readonly code: "client_key_workspaces_required" | "client_key_origin_not_allowed" | "api_key_ip_not_allowed", message: string) {
    super(message);
  }
}

/** A stored browser key without a workspace allowlist (written before the rule); refused at request time. */
export class ClientKeyWorkspacesRequiredError extends ApiKeyPolicyError {
  constructor() {
    super("client_key_workspaces_required", CLIENT_KEY_WORKSPACES_REQUIRED_MESSAGE);
  }
}

export const CLIENT_KEY_ORIGIN_NOT_ALLOWED_MESSAGE = "This browser API key isn't allowed on this website. Add the site to the key's allowed websites (for example docs.example.com, or *.example.com for its subdomains), or call DocSlurp from your server with a server key.";

/** A server key with an IP allowlist, used from another address (or one we couldn't determine). */
export class ApiKeyIpNotAllowedError extends ApiKeyPolicyError {
  constructor() {
    super("api_key_ip_not_allowed", "This API key can't be used from this IP address. Add the address or its range to the key's IP allowlist, or call from an allowed server.");
  }
}

/** The request's Origin (or Referer) is not on the browser key's allowed websites. */
export class ClientKeyOriginNotAllowedError extends ApiKeyPolicyError {
  constructor() {
    super("client_key_origin_not_allowed", CLIENT_KEY_ORIGIN_NOT_ALLOWED_MESSAGE);
  }
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
    scopes: effectiveKeyScopes(parseApiKeyType(row.key_type), row.scopes ?? [], row.workspace_ids ?? []),
    rateLimitRpm: row.rate_limit_rpm,
    rateLimitPpd: row.rate_limit_ppd,
    rateLimits: parseApiKeyRateLimits(row.rate_limits),
    workspaceIds: row.workspace_ids ?? [],
    materializationPolicy: parseKeyMaterializationPolicy(row.materialization_policy),
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip ?? null,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    expiresAt: isoOrNull(row.expires_at),
    ipAllowlist: row.ip_allowlist ?? [],
    maxOutputTokens: row.max_output_tokens ?? null,
    rotatedFromKeyId: row.rotated_from_key_id ?? null,
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
    /** Ignored: browser keys never hold ingest, artifacts or web (kept so older callers still validate). */
    allowClientSensitiveScopes?: boolean;
    materializationPolicy?: Partial<MaterializationPolicy>;
    /** ISO date-time; null or omitted for no expiry (at most 365 days ahead). */
    expiresAt?: string | null;
    /** Server keys only: CIDRs the key may be used from. */
    ipAllowlist?: string[];
    /** Chat answer output cap: browser 500/1000/2000 (default 1000), server 500/1000/2000/4000 or null. */
    maxOutputTokens?: number | null;
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
  const expiresAt = normalizeExpiresAt(limits?.expiresAt);
  const ipAllowlist = normalizeIpAllowlist(keyType, limits?.ipAllowlist);
  const maxOutputTokens = normalizeMaxOutputTokens(keyType, limits?.maxOutputTokens);
  const scopes = limits?.scopes?.length
    ? [...new Set(limits.scopes)]
    : [...(keyType === "client" ? defaultClientApiKeyScopes : defaultApiKeyScopes)];
  return await withOrganizationLock(orgId, userId, async (tx, actor) => {
    assertOrganizationKeyScopes(keyType, scopes, actor.role);
    const workspaceIds = await normalizeKeyWorkspaceIds(tx, orgId, userId, limits?.workspaceIds);
    assertClientKeyWorkspaces(keyType, workspaceIds);
    const [row] = await tx<ApiKeyRow[]>`
      insert into api_keys (id, user_id, org_id, key_hash, name, key_type, allowed_domains, scopes, rate_limit_rpm, rate_limit_ppd, rate_limits, workspace_ids, materialization_policy, expires_at, ip_allowlist, max_output_tokens)
      values (${id}, ${userId}, ${orgId}, ${keyHash}, ${name}, ${keyType}, ${tx.array(allowedDomains)},
        ${tx.array(scopes)}, ${limits?.rpm ?? null}, ${limits?.ppd ?? 10000},
        ${tx.json(apiKeyRateLimitRulesSchema.parse(limits?.rateLimits ?? []) as never)}, ${tx.array(workspaceIds)},
        ${tx.json(materializationPolicyOverridesSchema.parse(limits?.materializationPolicy ?? {}) as never)},
        ${expiresAt}, ${tx.array(ipAllowlist)}, ${maxOutputTokens})
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
  // A browser key sits in page source: search and chat only, never server powers.
  const serverOnly = keyType === "client" ? scopes.filter(scope => !(clientApiKeyScopes as readonly string[]).includes(scope)) : [];
  if (serverOnly.length > 0) {
    throw new OrganizationError(400, "invalid_key_scope", `Browser keys can only search and chat. ${serverOnly.join(", ")} needs a server key used from your backend.`);
  }
  if (keyType !== "client" && scopes.includes("web")) {
    throw new OrganizationError(400, "invalid_key_scope", "The web scope applies to client API keys; server keys use web tools with search");
  }
  if (keyType === "client" && scopes.includes("workspaces:manage")) {
    throw new OrganizationError(400, "invalid_key_scope", "Client API keys cannot manage workspaces");
  }
  // `workspaces:manage` changes workspace configuration, so a key that carries it
  // must be minted by an organization owner/admin. The per-workspace edit check
  // on the route is the second layer. Security finding SEC-2026-10-01.
  if (keyType !== "client" && scopes.includes("workspaces:manage") && !["owner", "admin"].includes(role)) {
    throw new OrganizationError(403, "organization_forbidden", "Workspace management keys require organization admin access");
  }
  if (!scopes.some(scope => scope.startsWith("organizations:"))) return;
  if (keyType === "client") throw new OrganizationError(400, "invalid_key_scope", "Client API keys cannot access organizations");
  if (scopes.includes("organizations:manage") && !["owner", "admin"].includes(role))
    throw new OrganizationError(403, "organization_forbidden", "Organization management keys require admin access");
}

type KeyTransaction = postgres.TransactionSql<Record<string, postgres.PostgresType>>;

/**
 * A public client key that can upload, read raw artifacts or spend credits on web tools is a standing
 * credential in someone's page source. Allow it only when the creator opts in
 * and binds the key to specific workspaces.
 */
/** Runtime guard for rows written before the rule: a browser key keeps only search and chat. */
export function effectiveKeyScopes(keyType: ApiKeyType, scopes: string[], _workspaceIds: string[]): string[] {
  if (keyType !== "client") return scopes;
  // Narrowing an old row can remove every scope. Defaults belong to creation:
  // adding search here would grant a permission the owner never selected.
  return scopes.filter(scope => (clientApiKeyScopes as readonly string[]).includes(scope));
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
  /** ISO date-time, or null to remove the expiry; omitted keeps it. */
  expiresAt?: string | null;
  ipAllowlist?: string[];
  /** A number sets the cap, null removes it (browser keys fall back to 1000); omitted keeps it. */
  maxOutputTokens?: number | null;
}): Promise<ApiKey | null> {
  return await withOwnedKeyLock(id, userId, async (tx, existing, role) => {
    const nextKeyType = parseApiKeyType(existing.key_type);
    // The secret's prefix records its type, so a browser key can never be promoted in place.
    if (updates.keyType !== undefined && updates.keyType !== nextKeyType) {
      throw new ApiKeyTypeChangeError();
    }
    // A legacy browser key saved without new scopes is narrowed to what it may hold.
    const nextScopes = updates.scopes ? [...new Set(updates.scopes)] : effectiveKeyScopes(nextKeyType, existing.scopes ?? [], existing.workspace_ids ?? []);
    assertOrganizationKeyScopes(nextKeyType, nextScopes, role);
    const nextWorkspaceIds = updates.workspaceIds !== undefined
      ? await normalizeKeyWorkspaceIds(tx, existing.org_id!, userId, updates.workspaceIds)
      : existing.workspace_ids ?? [];
    // Every save of a browser key must leave it bound to workspaces, including a legacy key with none.
    assertClientKeyWorkspaces(nextKeyType, nextWorkspaceIds);
    const nextExpiresAt = updates.expiresAt !== undefined ? normalizeExpiresAt(updates.expiresAt) : undefined;
    const nextIpAllowlist = updates.ipAllowlist !== undefined ? normalizeIpAllowlist(nextKeyType, updates.ipAllowlist) : undefined;
    const nextMaxOutput = updates.maxOutputTokens !== undefined ? normalizeMaxOutputTokens(nextKeyType, updates.maxOutputTokens) : undefined;
    const normalizedAllowedDomains = updates.allowedDomains !== undefined
      ? normalizeAllowedDomains(updates.allowedDomains ?? existing.allowed_domains ?? [], nextKeyType) : null;
    const [row] = await tx<ApiKeyRow[]>`update api_keys set
      name = coalesce(${updates.name ?? null}, name), allowed_domains = coalesce(${normalizedAllowedDomains ? tx.array(normalizedAllowedDomains) : null}, allowed_domains),
      scopes = ${tx.array(nextScopes)},
      expires_at = case when ${nextExpiresAt !== undefined} then ${nextExpiresAt ?? null}::timestamptz else expires_at end,
      ip_allowlist = coalesce(${nextIpAllowlist ? tx.array(nextIpAllowlist) : null}, ip_allowlist),
      max_output_tokens = case when ${nextMaxOutput !== undefined} then ${nextMaxOutput ?? null}::int else max_output_tokens end,
      workspace_ids = ${tx.array(nextWorkspaceIds)},
      rate_limit_rpm = case when ${updates.rateLimitRpm !== undefined} then ${updates.rateLimitRpm ?? null}::int else rate_limit_rpm end, rate_limit_ppd = coalesce(${updates.rateLimitPpd ?? null}, rate_limit_ppd),
      rate_limits = coalesce(${updates.rateLimits ? tx.json(apiKeyRateLimitRulesSchema.parse(updates.rateLimits) as never) : null}::jsonb, rate_limits),
      materialization_policy = coalesce(${updates.materializationPolicy ? tx.json(materializationPolicyOverridesSchema.parse(updates.materializationPolicy) as never) : null}::jsonb, materialization_policy)
      where id = ${id} and user_id = ${userId} and revoked_at is null returning *`;
    return row ? mapApiKey(row) : null;
  });
}

/**
 * Rotation. Without an overlap the secret is replaced in place (the old one
 * stops at once). With `overlapSeconds` a new key is created with the same
 * settings (`rotatedFromKeyId` names the old one) and the old key keeps
 * working until the overlap ends (its expiry moves no later than that), so a
 * deployment can switch secrets without downtime.
 */
export async function rotateApiKey(id: string, userId: string, options: { overlapSeconds?: number } = {}): Promise<{ key: ApiKey; rawKey: string; previous?: ApiKey } | null> {
  const overlap = options.overlapSeconds ?? 0;
  if (!Number.isInteger(overlap) || overlap < 0 || overlap > API_KEY_MAX_ROTATION_OVERLAP_SECONDS) {
    throw new OrganizationError(400, "invalid_rotation_overlap", `The old key can keep working for at most ${API_KEY_MAX_ROTATION_OVERLAP_SECONDS / 86_400} days.`);
  }
  return await withOwnedKeyLock(id, userId, async (tx, existing, role) => {
    const keyType = parseApiKeyType(existing.key_type);
    const scopes = effectiveKeyScopes(keyType, existing.scopes ?? [], existing.workspace_ids ?? []);
    assertOrganizationKeyScopes(keyType, scopes, role);
    const rawKey = generateRawKey(keyType);
    if (overlap === 0) {
      const [row] = await tx<ApiKeyRow[]>`update api_keys set key_hash = ${hashKey(rawKey)}, last_used_at = null, last_used_ip = null, scopes = ${tx.array(scopes)}
        where id = ${id} and user_id = ${userId} and revoked_at is null returning *`;
      return row ? { key: mapApiKey(row), rawKey } : null;
    }
    const newId = randomUUID();
    const [created] = await tx<ApiKeyRow[]>`
      insert into api_keys (id, user_id, org_id, key_hash, name, key_type, allowed_domains, scopes, rate_limit_rpm, rate_limit_ppd, rate_limits, workspace_ids, materialization_policy, expires_at, ip_allowlist, max_output_tokens, rotated_from_key_id)
      select ${newId}, user_id, org_id, ${hashKey(rawKey)}, name, key_type, allowed_domains, ${tx.array(scopes)}, rate_limit_rpm, rate_limit_ppd, rate_limits, workspace_ids, materialization_policy, expires_at, ip_allowlist, max_output_tokens, id
      from api_keys where id = ${id} and user_id = ${userId} and revoked_at is null
      returning *`;
    if (!created) return null;
    const [previous] = await tx<ApiKeyRow[]>`update api_keys
      set expires_at = least(coalesce(expires_at, 'infinity'::timestamptz), now() + make_interval(secs => ${overlap}))
      where id = ${id} and user_id = ${userId} and revoked_at is null returning *`;
    return { key: mapApiKey(created), rawKey, ...(previous ? { previous: mapApiKey(previous) } : {}) };
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
  /** Workspace allowlist; empty (server keys only) means every workspace the owner can reach in `orgId`. Browser keys always have one. */
  workspaceIds: string[];
  /** Per-key materialization caps; absent or `{}` adds no restriction. */
  materializationPolicy?: Partial<MaterializationPolicy>;
  /** Cap on a chat answer's model output tokens for this key (browser keys default to 1000); null means no key cap. */
  maxOutputTokens?: number | null;
}

export async function validateApiKey(
  rawKey: string,
  requestContext?: { origin?: string | null; referer?: string | null; ip?: string | null }
): Promise<ValidatedKey | null> {
  const keyHash = hashKey(rawKey);

  // An expired key (including the old key after a rotation overlap) never authenticates.
  const [row] = await sql<ApiKeyRow[]>`
    select * from api_keys
    where key_hash = ${keyHash} and revoked_at is null
      and (expires_at is null or expires_at > now())
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
    !originMatchesAllowlist(requestContext?.origin != null ? requestContext.origin : requestContext?.referer, allowedDomains)
  ) {
    throw new ClientKeyOriginNotAllowedError();
  }
  // A browser key written before workspace allowlists were required: refuse it
  // with how to fix it, never widen it to every workspace its owner can reach.
  if (keyType === "client" && (row.workspace_ids ?? []).length === 0) {
    throw new ClientKeyWorkspacesRequiredError();
  }

  // A server key with an IP allowlist works only from those ranges; an unknown address is refused.
  const ipAllowlist = row.ip_allowlist ?? [];
  if (keyType === "server" && ipAllowlist.length > 0 && !ipAllowed(requestContext?.ip, ipAllowlist)) {
    throw new ApiKeyIpNotAllowedError();
  }

  // Usage statistics are buffered; every limit, including the daily page cap,
  // is enforced by the rate-limit middleware.
  recordApiKeyRequest(row.id, Date.now(), requestContext?.ip ?? null);

  return {
    keyId: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    keyType,
    allowedDomains,
    scopes: effectiveKeyScopes(keyType, row.scopes ?? [], row.workspace_ids ?? []),
    rateLimitRpm: row.rate_limit_rpm,
    rateLimitPpd: row.rate_limit_ppd,
    rateLimits: parseApiKeyRateLimits(row.rate_limits),
    workspaceIds: row.workspace_ids ?? [],
    materializationPolicy: parseKeyMaterializationPolicy(row.materialization_policy),
    maxOutputTokens: effectiveMaxOutputTokens(keyType, row.max_output_tokens),
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
      and (expires_at is null or expires_at > now())
      and exists (
        select 1 from org_memberships om
        where om.org_id = api_keys.org_id and om.user_id = api_keys.user_id
      )
  `;
  const keyType = row ? parseApiKeyType(row.key_type) : null;
  return row && keyType ? { keyType, scopes: effectiveKeyScopes(keyType, row.scopes ?? [], row.workspace_ids ?? []), workspaceIds: row.workspace_ids ?? [], materializationPolicy: parseKeyMaterializationPolicy(row.materialization_policy) } : null;
}
