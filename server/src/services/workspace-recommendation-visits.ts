import { randomUUID } from "node:crypto";
import { sql } from "../db.js";

export interface RecommendationVisit {
  token: string;
  since: string | null;
  through: string;
  searches: number;
  emptySearches: number;
  messages: number;
  runs: number;
  capped: boolean;
}
interface Scope { userId: string; orgId: string; workspaceId: string }
const CAP = 1000;

/** Caller must authorize the current session's workspace membership on every request.
 * A locked row shares one immutable pending snapshot across tabs/devices. Failed
 * reads never acknowledge it; old tokens cannot consume a newer window.
 */
export async function getRecommendationVisit(scope: Scope): Promise<RecommendationVisit> {
  const { userId, orgId, workspaceId } = scope;
  return sql.begin(async tx => {
    await tx`insert into workspace_recommendation_visits (user_id, org_id, workspace_id)
      values (${userId}, ${orgId}, ${workspaceId}) on conflict do nothing`;
    const [row] = await tx<{ acknowledged_at: string | null; pending_snapshot: RecommendationVisit | null }[]>`
      select acknowledged_at::text, pending_snapshot from workspace_recommendation_visits
      where user_id = ${userId} and org_id = ${orgId} and workspace_id = ${workspaceId} for update`;
    if (row!.pending_snapshot) return row!.pending_snapshot;
    const [clock] = await tx<{ through: string }[]>`select clock_timestamp()::text as through`;
    const since = row!.acknowledged_at;
    const through = clock!.through;
    let counts = { searches: 0, empty_searches: 0, messages: 0, runs: 0 };
    if (since) {
      // Retained workspace-wide activity, bounded to 1,001 rows per source. No
      // raw query, document content, provider credentials or user identifiers leave SQL.
      const [activity] = await tx<typeof counts[]>`
        with searches as (
          select s.result_count from search_sessions s
          join workspaces w on w.id = s.metadata ->> 'workspaceId'
          where w.id = ${workspaceId} and w.org_id = ${orgId}
            and s.created_at > ${since}::timestamptz and s.created_at <= ${through}::timestamptz
          order by s.created_at desc limit ${CAP + 1}
        ), messages as (
          select ct.id from chat_turns ct join chat_sessions cs on cs.id = ct.session_id
          join workspaces w on w.id = cs.workspace_id
          where w.id = ${workspaceId} and w.org_id = ${orgId}
            and ct.created_at > ${since}::timestamptz and ct.created_at <= ${through}::timestamptz
          order by ct.created_at desc limit ${CAP + 1}
        ), runs as (
          select id from workspace_runs where workspace_id = ${workspaceId} and org_id = ${orgId}
            and created_at > ${since}::timestamptz and created_at <= ${through}::timestamptz
          order by created_at desc limit ${CAP + 1}
        ) select (select count(*)::int from searches) as searches,
          (select count(*)::int from searches where result_count = 0) as empty_searches,
          (select count(*)::int from messages) as messages, (select count(*)::int from runs) as runs`;
      counts = activity!;
    }
    const snapshot: RecommendationVisit = { token: randomUUID(), since, through,
      searches: counts.searches, emptySearches: counts.empty_searches,
      messages: counts.messages, runs: counts.runs,
      capped: Math.max(counts.searches, counts.messages, counts.runs) > CAP };
    await tx`update workspace_recommendation_visits set pending_token = ${snapshot.token},
      pending_snapshot = ${tx.json({ ...snapshot })}
      where user_id = ${userId} and org_id = ${orgId} and workspace_id = ${workspaceId}`;
    return snapshot;
  });
}

/** Compare-and-set: replay or another tab's completed token cannot move the watermark. */
export async function acknowledgeRecommendationVisit(scope: Scope, token: string): Promise<boolean> {
  const rows = await sql`
    update workspace_recommendation_visits
    set acknowledged_at = greatest(acknowledged_at, (pending_snapshot ->> 'through')::timestamptz),
      pending_token = null, pending_snapshot = null
    where user_id = ${scope.userId} and org_id = ${scope.orgId} and workspace_id = ${scope.workspaceId}
      and pending_token = ${token}::uuid returning workspace_id`;
  return rows.length === 1;
}
