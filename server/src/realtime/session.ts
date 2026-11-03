import { sql } from "../db.js";
import type { RealtimeSession } from "./node.js";

/** Only accepts the identity captured after authenticated Upgrade, never a
 * client-supplied id. One live query checks revocation, expiry and current MFA
 * policy; administrator decoration is irrelevant to socket authority.
 */
export async function revalidateRealtimeSession(session: RealtimeSession, signal: AbortSignal): Promise<RealtimeSession | null> {
  signal.throwIfAborted();
  const query = sql`select s.id from session s join "user" u on u.id=s."userId"
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
