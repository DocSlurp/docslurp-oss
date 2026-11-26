import { sha256Hex } from "./hash.js";

/**
 * Organization isolation for caches, memo maps and reuse keys.
 *
 * The organization is the only tenant scope. Every value computed from one
 * organization's data (or for one organization's request) that is kept for
 * reuse must be keyed by that organization, so identical inputs from another
 * organization can never hit it, not even as a latency difference. A missing
 * organization is refused, never treated as a shared scope.
 */
export class OrgScopeRequiredError extends Error {
  constructor(what: string) {
    super(`${what} requires an organization id; refusing an unscoped cache or reuse key`);
    this.name = "OrgScopeRequiredError";
  }
}

/** The trimmed organization id, or throws: an empty, blank or non-string id is never a scope. */
export function requireOrgId(orgId: unknown, what = "org-scoped key"): string {
  if (typeof orgId !== "string" || !orgId.trim()) throw new OrgScopeRequiredError(what);
  return orgId.trim();
}

/**
 * A cache or reuse key bound to one organization: a SHA-256 over a versioned
 * namespace, the organization id and the JSON of every part. Throws without an
 * organization. Two organizations never share a key, whatever the other parts.
 * Pure TypeScript (no node:crypto), so the browser-safe index can export it;
 * hash large inputs (vectors) yourself and pass the digest as a part.
 */
export function orgScopedCacheKey(orgId: unknown, namespace: string, ...parts: unknown[]): string {
  const org = requireOrgId(orgId, namespace);
  return sha256Hex(JSON.stringify(["org-scoped/v1", namespace, org, ...parts]));
}
