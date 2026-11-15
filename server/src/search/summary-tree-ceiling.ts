import { SUMMARY_TREE_SEARCH_MODES, summaryTreeSearchModeSchema, type SummaryTreeSearchMode } from "@docslurp/shared";

import { sql } from "../db.js";
import { currentRequestApiKeyId } from "../lib/request-context.js";
import { canEditProject, getProjectAccess } from "../services/organizations.js";
import type { SearchScopeActor } from "./access-scope.js";

/*
 * The project's stored retrieval default (`retrievalDefaults.summaryTree`) is a ceiling on what a request may ask for:
 * off < guide < include. Any caller may ask for less. Asking for more is a decision about what the project's readers
 * are shown (model-written summaries of its documents), so it belongs to whoever may change the project's settings:
 *
 * - a signed-in user with edit rights on the project (`canEditProject`);
 * - a server API key with the `projects:manage` scope, in the project's own organization.
 *
 * Everyone else is held to the stored default: a project member or viewer without edit rights, a browser (client) key
 * whatever its scopes, a search- or chat-scoped server key, a delegated OAuth token whatever scopes its grant holds
 * (a grant is consent to act for a user in a client, not a decision of the project's editors), and a caller the
 * search was not told about. Editors who want `include` for their readers store it as the project's retrieval
 * default.
 *
 * The caller is named by the search's access scope (`SearchAccessScope.actor`), which the request's own actor builds;
 * it is never inferred from who owns a key. The check costs a query, and runs only for a request that asks for more
 * than the default.
 */

const rank = (mode: SummaryTreeSearchMode): number => SUMMARY_TREE_SEARCH_MODES.indexOf(mode);

/** A stored or requested mode as a known mode; anything else is `off`. */
export function knownSummaryTreeMode(value: unknown): SummaryTreeSearchMode {
  const parsed = summaryTreeSearchModeSchema.safeParse(value);
  return parsed.success ? parsed.data : "off";
}

/** Whether `asked` is more than `ceiling` allows (off < guide < include). */
export function exceedsSummaryTreeCeiling(asked: SummaryTreeSearchMode, ceiling: SummaryTreeSearchMode): boolean {
  return rank(asked) > rank(ceiling);
}

/** `asked`, lowered to `ceiling` when it is above it. */
export function clampSummaryTreeMode(asked: SummaryTreeSearchMode, ceiling: SummaryTreeSearchMode): SummaryTreeSearchMode {
  return exceedsSummaryTreeCeiling(asked, ceiling) ? ceiling : asked;
}

/**
 * Whether the caller of this search may ask for a summary-tree mode above the project's retrieval default. Fails
 * closed:
 *
 * - no actor (the search's scope names no caller): no;
 * - an API key is judged by the key alone, never by its owner's rights: only a live server key of the project's
 *   organization with `projects:manage`. A key without an id, a delegated OAuth token, a revoked key, a browser key
 *   and a key of another organization may not;
 * - a signed-in user needs edit rights on the project. A scope that says "signed-in user" while the request itself
 *   was authenticated with an API key is not believed: the key's owner's rights are never used for a key's request.
 */
export async function callerMayRaiseSummaryTree(args: {
  userId: string;
  projectId: string;
  orgId: string;
  /** Who is asking, from the search's access scope. Undefined: unknown, and refused. */
  actor: SearchScopeActor | undefined;
}): Promise<boolean> {
  const actor = args.actor;
  if (!actor) return false;
  if (actor.type === "apiKey") {
    if (!actor.apiKeyId || actor.delegated) return false;
    const [key] = await sql<{ id: string }[]>`
      select id from api_keys
      where id = ${actor.apiKeyId} and org_id = ${args.orgId} and revoked_at is null
        and key_type = 'server' and scopes @> array['projects:manage']::text[]
      limit 1
    `;
    return Boolean(key);
  }
  if (actor.type !== "session") return false;
  if (currentRequestApiKeyId()) return false;
  const access = await getProjectAccess(args.projectId, args.userId);
  return Boolean(access && access.projectId === args.projectId && access.orgId === args.orgId && canEditProject(access, args.userId));
}
