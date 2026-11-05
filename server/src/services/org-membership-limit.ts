import type postgres from "postgres";

/**
 * How many organizations one user may belong to. A policy, not a data-model assumption: every query stays keyed on an explicit
 * organization (request, session or API key), and nothing derives a tenant from the user id.
 *
 * While the limit is 1 it is enforced twice: here, for every path that adds a membership (accepting an organization or
 * workspace invite, creating an organization), and by the unique index org_memberships_one_org_per_user (migration 0127).
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
