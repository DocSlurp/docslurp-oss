import type postgres from "postgres";

/**
 * How many organizations one user may belong to. A policy, not a data-model assumption: every query stays keyed on an explicit
 * organization (request, session or API key), and nothing derives a tenant from the user id.
 *
 * While the limit is 1 it is enforced twice: here, for every path that adds a membership (accepting an organization or
 * project invite, creating an organization), and by the unique index org_memberships_one_org_per_user (migration 0127).
 * To allow several organizations per user: drop that index in a migration and raise DOCSLURP_MAX_ORGS_PER_USER
 * (docs/api-sdk.md#one-organization-per-user).
 */
export function maxOrgsPerUser(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DOCSLURP_MAX_ORGS_PER_USER?.trim();
  if (!raw) return 1;
  const parsed = Number(raw);
  // A malformed value never widens the limit.
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * Startup check: a limit above 1 while org_memberships_one_org_per_user still exists cannot take effect. Every join past the
 * first passes the check and is then refused by the index (409 user_already_in_org), so the setting would only mislead.
 * Logged loudly rather than refusing to boot: the outcome is the stricter policy, and a database that is down at boot must
 * not block startup. Returns whether the mismatch was found.
 */
export async function warnOrgLimitAboveOneWithUniqueIndex(
  oneOrgIndexExists: () => Promise<boolean>,
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.error,
): Promise<boolean> {
  const limit = maxOrgsPerUser(env);
  if (limit <= 1) return false;
  try {
    if (!(await oneOrgIndexExists())) return false;
  } catch (error) {
    log(`[org-limit] could not check org_memberships_one_org_per_user: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  log(`[org-limit] DOCSLURP_MAX_ORGS_PER_USER=${limit} has no effect: the unique index org_memberships_one_org_per_user still limits every user to one organization. Drop it in a migration first (docs/api-sdk.md#one-organization-per-user).`);
  return true;
}

/** The user already has as many organizations as the policy allows (HTTP 409, `user_already_in_org`). */
export class UserAlreadyInOrgError extends Error {
  readonly status = 409 as const;
  readonly code = "user_already_in_org" as const;
  constructor() {
    super("You already belong to an organization. Leave it before joining or creating another one.");
    this.name = "UserAlreadyInOrgError";
  }
}

type Tx = postgres.TransactionSql<Record<string, postgres.PostgresType>> | postgres.TransactionSql;

/**
 * Checks, inside the transaction that adds the membership, that the user may join `targetOrgId` (null: an organization
 * being created). Locks the user's memberships so two concurrent joins cannot both pass. Returns the user's personal
 * organization to delete when it holds no data and is all that stands in the way (it is replaced by the new one);
 * otherwise throws UserAlreadyInOrgError.
 */
export async function assertUserMayJoinOrg(tx: Tx, userId: string, targetOrgId: string | null, limit = maxOrgsPerUser()): Promise<{ replacePersonalOrgId: string | null }> {
  const memberships = await (tx as postgres.TransactionSql)<{ org_id: string; is_personal: boolean; empty: boolean }[]>`
    select om.org_id, o.is_personal, o.personal_owner_user_id = ${userId} and docslurp_personal_org_is_empty(o.id) as empty
    from org_memberships om
    join organizations o on o.id = om.org_id
    where om.user_id = ${userId} and om.org_id is distinct from ${targetOrgId}
    for update of om
  `;
  if (memberships.length < limit) return { replacePersonalOrgId: null };
  const replaceable = memberships.filter((membership) => membership.is_personal && membership.empty);
  if (memberships.length - replaceable.length < limit && replaceable[0]) return { replacePersonalOrgId: replaceable[0].org_id };
  throw new UserAlreadyInOrgError();
}
