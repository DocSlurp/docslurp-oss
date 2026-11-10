import { realtimeCanaryOrgIds } from "./rollout-scope.js";
import type postgres from "postgres";
import { sql } from "../db.js";
import type { RealtimeSession } from "./node.js";

/** Only accepts the identity captured after authenticated Upgrade, never a
 * client-supplied id. One live query checks revocation, expiry and current MFA
 * policy; administrator decoration is irrelevant to socket authority.
 */
export async function revalidateRealtimeSession(session: RealtimeSession, signal: AbortSignal, client: postgres.Sql | postgres.TransactionSql = sql): Promise<RealtimeSession | null> {
  signal.throwIfAborted();
  const query = client`select s.id from session s join "user" u on u.id=s."userId"
    where s.id=${session.sessionId} and s."userId"=${session.userId}
      and s."expiresAt">clock_timestamp() and u.deleted_at is null
      and (not coalesce(u."twoFactorEnabled",false) or s."mfaVerified" is true)
      and (s."mfaVerified" is true or not exists (
        select 1 from org_memberships m join organizations o on o.id=m.org_id
        where m.user_id=${session.userId} and o.require_mfa and o.deleted_at is null
          and greatest(coalesce(o.require_mfa_since,clock_timestamp()),m.created_at)
            +make_interval(days=>o.mfa_grace_period_days)<=clock_timestamp()
      ))`;
  const cancel = () => { void Promise.resolve(query.cancel()).catch(() => {}); };
  signal.addEventListener("abort",cancel,{once:true});
  try {
    signal.throwIfAborted();
    const rows=await query;
    signal.throwIfAborted();
    return rows.length===1 ? session : null;
  } finally { signal.removeEventListener("abort",cancel); }
}

/** Cohort admission is separate from execution policy: accepted tasks keep their
 * existing session/project/deadline checks when rollout membership changes. */
export async function hasRealtimeCanaryMembership(userId: string, orgId?: string, signal: AbortSignal = AbortSignal.timeout(5000), client: postgres.Sql | postgres.TransactionSql = sql): Promise<boolean> {
  signal.throwIfAborted();
  const ids = realtimeCanaryOrgIds();
  if (ids === null) return true;
  if (orgId && !ids.includes(orgId.toLowerCase())) return false;
  const query = client`select 1 from org_memberships m join organizations o on o.id=m.org_id
    where m.user_id=${userId} and o.deleted_at is null
      and m.org_id=any(${client.array(orgId ? [orgId] : ids)}) limit 1`;
  const cancel = () => { void Promise.resolve(query.cancel()).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const rows = await query;
    signal.throwIfAborted();
    return rows.length === 1;
  } finally { signal.removeEventListener("abort", cancel); }
}
