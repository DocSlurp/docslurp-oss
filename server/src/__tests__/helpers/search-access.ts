import type { RequestActor } from "../../lib/request-actor.js";
import type { AuthorizedProjectSearch, DeniedProjectSearch } from "../../lib/search-access.js";
import { searchAccessScopeFor, searchScopeAllowsProject } from "../../search/access-scope.js";
import { SEARCH_SCOPES } from "../../lib/search-tiers.js";

type ProjectLookup = (projectId: string, userId: string) => Promise<unknown>;

/**
 * A stand-in for lib/search-access.ts authorizeActorProjectSearch in route tests that arrange project access through
 * a getProject mock: the same key-scope, org and allowlist rules (search/access-scope.ts), with the project read from
 * the mock instead of the database. The real function is covered in chat-turn-scope.db.test.ts.
 */
export function authorizeFromProjectMock(getProject: ProjectLookup) {
  return async (actor: RequestActor, projectId: string, required: "search" | "chat"): Promise<AuthorizedProjectSearch | DeniedProjectSearch> => {
    if (actor.type === "apiKey") {
      const wanted = required === "search" ? [...SEARCH_SCOPES] as string[] : [required];
      if (!wanted.some((scope) => actor.apiKey.scopes.includes(scope))) return { ok: false, status: 403 };
    }
    const project = await getProject(projectId, actor.userId) as { id?: string; orgId?: string; pipeline?: unknown } | null | undefined;
    // null: no access; undefined (a test that arranges no project): an org-1 project.
    if (project === null) return { ok: false, status: 404 };
    const orgId = project?.orgId ?? "org-1";
    const access = { projectId, orgId, projectOwnerUserId: actor.userId, orgRole: "owner" as const, projectRole: null, pipeline: project?.pipeline ?? {} };
    const scope = searchAccessScopeFor(actor, access);
    if (!scope || !searchScopeAllowsProject(scope, access)) return { ok: false, status: 404 };
    return { ok: true, access, scope };
  };
}
