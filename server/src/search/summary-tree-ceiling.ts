import { SUMMARY_TREE_SEARCH_MODES, summaryTreeSearchModeSchema, type SummaryTreeSearchMode } from "@docslurp/shared";

import { sql } from "../db.js";
import { currentRequestApiKeyId } from "../lib/request-context.js";
import { canEditProject, getProjectAccess } from "../services/organizations.js";

/*
 * The project's stored retrieval default (`retrievalDefaults.summaryTree`) is a ceiling on what a request may ask for:
 * off < guide < include. Any caller may ask for less. Asking for more is a decision about what the project's readers
 * are shown (model-written summaries of its documents), so it belongs to whoever may change the project's settings:
 *
 * - a signed-in user with edit rights on the project (`canEditProject`);
 * - a server API key with the `projects:manage` scope, in the project's own organization.
 *
 * Everyone else is held to the stored default: a project member or viewer without edit rights, a browser (client) key
 * whatever its scopes, a search- or chat-scoped server key, and an OAuth token. Editors who want `include` for their
 * readers store it as the project's retrieval default.
 *
 * The check costs a query, and runs only for a request that asks for more than the default.
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
 * Whether the caller of this request may ask for a summary-tree mode above the project's retrieval default. Fails
 * closed: a request made with an API key is judged by the key alone (never by its owner's rights), and a key that is
 * revoked, a browser key, lacks `projects:manage`, belongs to another organization or is not an API key at all (an
 * OAuth token id) may not.
 */
export async function callerMayRaiseSummaryTree(args: {
  userId: string;
  projectId: string;
  orgId: string;
  /** The request's API key id; defaults to the current request's. Null: a signed-in user. */
  apiKeyId?: string | null;
}): Promise<boolean> {
  const apiKeyId = args.apiKeyId === undefined ? currentRequestApiKeyId() : args.apiKeyId;
  if (apiKeyId) {
    const [key] = await sql<{ id: string }[]>`
      select id from api_keys
      where id = ${apiKeyId} and org_id = ${args.orgId} and revoked_at is null
        and key_type = 'server' and scopes @> array['projects:manage']::text[]
      limit 1
    `;
    return Boolean(key);
  }
  const access = await getProjectAccess(args.projectId, args.userId);
  return Boolean(access && access.projectId === args.projectId && access.orgId === args.orgId && canEditProject(access, args.userId));
}
