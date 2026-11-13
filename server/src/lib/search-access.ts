import { addTraceMetadata } from "@docslurp/shared/observability";

import { searchAccessScopeFor, searchScopeAllowsProject, type SearchAccessScope } from "../search/access-scope.js";
import { getProjectAccessWithPipeline, type ProjectAccess } from "../services/organizations.js";
import { actorHasAnyApiKeyScope, type RequestActor } from "./request-actor.js";
import { setCurrentRequestOrgId } from "./request-context.js";
import { SEARCH_SCOPES } from "./search-tiers.js";

export type AuthorizedProjectSearch = {
  ok: true;
  /** The one access read of this request: project, org, roles and pipeline. Pass it along; do not re-read it. */
  access: ProjectAccess & { pipeline: unknown };
  /** The explicit scope `hybridSearch` and `chatProject` require. */
  scope: SearchAccessScope;
};
export type DeniedProjectSearch = { ok: false; status: 403 | 404 };

/**
 * The one access decision a search or chat request makes before retrieval:
 * the API key's scope (`search` admits any search scope, answers need
 * `chat`), the user's project access (G-06) with the key's org and allowlist,
 * and the explicit search access scope built from it. Session actors are
 * checked too (the project's org becomes their scope's org). A project the
 * actor may not use is a 404, indistinguishable from a missing one.
 */
export async function authorizeActorProjectSearch(
  actor: RequestActor,
  projectId: string,
  required: "search" | "chat",
): Promise<AuthorizedProjectSearch | DeniedProjectSearch> {
  if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, required === "search" ? [...SEARCH_SCOPES] : [required])) {
    return { ok: false, status: 403 };
  }
  const access = projectId.trim() ? await getProjectAccessWithPipeline(projectId, actor.userId) : null;
  if (!access || access.projectId !== projectId) return { ok: false, status: 404 };
  const scope = searchAccessScopeFor(actor, access);
  if (!scope || !searchScopeAllowsProject(scope, access)) return { ok: false, status: 404 };
  addTraceMetadata({ projectId, orgId: access.orgId });
  setCurrentRequestOrgId(access.orgId);
  return { ok: true, access, scope };
}
