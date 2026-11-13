import type { SearchMode } from "@docslurp/shared";

import { currentRequestApiKeyProjectIds } from "../lib/request-context.js";
import { searchModeOfScopes } from "../lib/search-tiers.js";

/**
 * Who may search what, passed explicitly into `hybridSearch` and `chatProject`
 * by every caller. The search module verifies each project it touches against
 * it (same org, inside the allowlist, and the user's own project access), and
 * refuses to run without one: an absent scope is never "everything".
 *
 * - `orgId`: the tenant. A project in any other org is refused, even when the
 *   user can reach it through a project share.
 * - `projectIds`: the projects of that org the caller may use, or `"org"` for
 *   every project of the org the user can access. An empty list allows none.
 * - `modeCeiling`: the most an API key may search (`search:<mode>` scope);
 *   null for sessions. Searches a chat turn runs belong to the answer and are
 *   governed by the `chat` scope instead (search/search-mode.ts).
 */
export interface SearchAccessScope {
  readonly orgId: string;
  readonly projectIds: readonly string[] | "org";
  readonly modeCeiling: SearchMode | null;
}

/** No (or a malformed) search scope was passed: refused, never widened. */
export class MissingSearchAccessScopeError extends Error {
  constructor() {
    super("Search requires an explicit access scope");
    this.name = "MissingSearchAccessScopeError";
  }
}

/** Throws unless `scope` is a well-formed SearchAccessScope. */
export function assertSearchAccessScope(scope: unknown): asserts scope is SearchAccessScope {
  const candidate = scope as Partial<SearchAccessScope> | null | undefined;
  if (
    !candidate
    || typeof candidate.orgId !== "string" || !candidate.orgId.trim()
    || !(candidate.projectIds === "org" || (Array.isArray(candidate.projectIds) && candidate.projectIds.every((id) => typeof id === "string" && id.length > 0)))
  ) {
    throw new MissingSearchAccessScopeError();
  }
}

/**
 * The project allowlist a query should apply: the scope's list intersected
 * with the request's API key allowlist when one is set (defense in depth), or
 * null when neither restricts the org.
 */
export function effectiveProjectAllowlist(scope: SearchAccessScope): readonly string[] | null {
  const requestAllowlist = currentRequestApiKeyProjectIds();
  if (scope.projectIds === "org") return requestAllowlist;
  return requestAllowlist ? scope.projectIds.filter((id) => requestAllowlist.includes(id)) : scope.projectIds;
}

/** Whether a project (already known to be readable by the user) is inside the scope. */
export function searchScopeAllowsProject(scope: SearchAccessScope, project: { projectId: string; orgId: string }): boolean {
  if (project.orgId !== scope.orgId) return false;
  const allowlist = effectiveProjectAllowlist(scope);
  return !allowlist || allowlist.includes(project.projectId);
}

type ScopeActor =
  | { type: "session" }
  | { type: "apiKey"; apiKey: { orgId: string | null; projectIds?: readonly string[]; keyType?: string; scopes: readonly string[] } };

/**
 * The scope of a request actor working in `project`'s organization. Sessions
 * get the project's org (the module still requires the user's own access to
 * every project); an API key gets its own org, its allowlist (a browser key
 * with none reaches no project) and its search-mode ceiling. Null when the
 * actor can never search there (a key without an org, or another org).
 */
export function searchAccessScopeFor(actor: ScopeActor, project: { orgId: string }): SearchAccessScope | null {
  if (actor.type === "session") return { orgId: project.orgId, projectIds: "org", modeCeiling: null };
  const key = actor.apiKey;
  if (!key.orgId || key.orgId !== project.orgId) return null;
  const allowlist = key.projectIds ?? [];
  return {
    orgId: key.orgId,
    projectIds: allowlist.length > 0 ? [...allowlist] : key.keyType === "client" ? [] : "org",
    // A key without a search scope reaches search only inside a chat turn (exempt), so outside one it is held to keyword.
    modeCeiling: searchModeOfScopes(key.scopes) ?? "keyword",
  };
}
