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
interface Event { source: "search" | "message" | "run"; event_id: string; event_created_at: string; empty: boolean }
const CAP = 1000;
const eligible = (s: RecommendationVisit) => s.searches >= 20 || s.messages >= 20 || s.runs >= 3;

/** Caller authorizes current session membership on every request. The fixed
 * tracking start + observed event IDs account for transactions that commit late.
 * The review horizon is 30 days; obsolete deduplication rows are pruned on access.
 */
export async function getRecommendationVisit(scope: Scope): Promise<RecommendationVisit> {
  const { userId, orgId, workspaceId } = scope;
  return sql.begin(async tx => {
    await tx`insert into workspace_recommendation_visits (user_id, org_id, workspace_id)
      values (${userId}, ${orgId}, ${workspaceId}) on conflict do nothing`;
    const [row] = await tx<{
      acknowledged_at: string | null; tracking_since: string;
      pending_snapshot: RecommendationVisit | null; pending_events: Event[] | null;
    }[]>`
      select acknowledged_at::text, tracking_since::text, pending_snapshot, pending_events
      from workspace_recommendation_visits
      where user_id = ${userId} and org_id = ${orgId} and workspace_id = ${workspaceId} for update`;
    await tx`delete from workspace_recommendation_seen_events
      where user_id = ${userId} and org_id = ${orgId} and workspace_id = ${workspaceId}
        and event_created_at < clock_timestamp() - interval '30 days'`;
    // First/busy snapshots are immutable until acknowledged. Quiet snapshots
    // may grow on the next visit, but none of their events are silently consumed.
    if (row!.pending_snapshot && (!row!.pending_snapshot.since || eligible(row!.pending_snapshot))) return row!.pending_snapshot;
    const [clock] = await tx<{ through: string; since: string }[]>`
      select clock_timestamp()::text as through,
        greatest(${row!.tracking_since}::timestamptz, clock_timestamp() - interval '30 days')::text as since`;
    const since = row!.acknowledged_at ? clock!.since : null;
    const through = clock!.through;
    let events: Event[] = [];
    if (since) {
      events = await tx<Event[]>`
        with seen as (
          select source, event_id from workspace_recommendation_seen_events
          where user_id = ${userId} and org_id = ${orgId} and workspace_id = ${workspaceId}
        ), searches as (
          select 'search'::text as source, s.id as event_id, s.created_at as event_created_at, s.result_count = 0 as empty
          from search_sessions s join workspaces w on w.id = s.metadata ->> 'workspaceId'
          where w.id = ${workspaceId} and w.org_id = ${orgId}
            and s.created_at > ${since}::timestamptz and s.created_at <= ${through}::timestamptz
            and not exists (select 1 from seen where source = 'search' and event_id = s.id)
          order by s.created_at, s.id limit ${CAP + 1}
        ), messages as (
          select 'message'::text as source, ct.id as event_id, ct.created_at as event_created_at, false as empty
          from chat_turns ct join chat_sessions cs on cs.id = ct.session_id join workspaces w on w.id = cs.workspace_id
          where w.id = ${workspaceId} and w.org_id = ${orgId}
            and ct.created_at > ${since}::timestamptz and ct.created_at <= ${through}::timestamptz
            and not exists (select 1 from seen where source = 'message' and event_id = ct.id)
          order by ct.created_at, ct.id limit ${CAP + 1}
        ), runs as (
          select 'run'::text as source, r.id as event_id, r.created_at as event_created_at, false as empty
          from workspace_runs r where r.workspace_id = ${workspaceId} and r.org_id = ${orgId}
            and r.created_at > ${since}::timestamptz and r.created_at <= ${through}::timestamptz
            and not exists (select 1 from seen where source = 'run' and event_id = r.id)
          order by r.created_at, r.id limit ${CAP + 1}
        ) select source, event_id, event_created_at::text, empty from searches
          union all select source, event_id, event_created_at::text, empty from messages
          union all select source, event_id, event_created_at::text, empty from runs`;
    }
    if (row!.pending_snapshot && JSON.stringify(events.map(e => [e.source, e.event_id, e.empty, e.event_created_at]).sort()) === JSON.stringify(row!.pending_events?.map(e => [e.source, e.event_id, e.empty, e.event_created_at]).sort())) return row!.pending_snapshot;
    const searches = events.filter(e => e.source === "search");
    const messages = events.filter(e => e.source === "message").length;
    const runs = events.filter(e => e.source === "run").length;
    const snapshot: RecommendationVisit = { token: randomUUID(), since, through,
      searches: searches.length, emptySearches: searches.filter(e => e.empty).length,
      messages, runs, capped: Math.max(searches.length, messages, runs) > CAP };
    await tx`update workspace_recommendation_visits set pending_token = ${snapshot.token},
      pending_snapshot = ${tx.json({ ...snapshot })}, pending_events = ${tx.json(events.map(e => ({ ...e })))}
      where user_id = ${userId} and org_id = ${orgId} and workspace_id = ${workspaceId}`;
    return snapshot;
  });
}

/** Consume only IDs actually observed in this token, atomically with clearing it.
 * Late-visible rows remain eligible even when their created_at precedes the last review.
 */
export async function acknowledgeRecommendationVisit(scope: Scope, token: string): Promise<boolean> {
  return sql.begin(async tx => {
    const [row] = await tx<{ pending_events: Event[] }[]>`
      select pending_events from workspace_recommendation_visits
      where user_id = ${scope.userId} and org_id = ${scope.orgId} and workspace_id = ${scope.workspaceId}
        and pending_token = ${token}::uuid for update`;
    if (!row) return false;
    if (row.pending_events.length) await tx`
      insert into workspace_recommendation_seen_events (user_id, org_id, workspace_id, source, event_id, event_created_at)
      select ${scope.userId}, ${scope.orgId}, ${scope.workspaceId}, e.source, e.event_id, e.event_created_at
      from jsonb_to_recordset(${tx.json(row.pending_events.map(e => ({ ...e })))})
        as e(source text, event_id text, event_created_at timestamptz)
      on conflict do nothing`;
    await tx`update workspace_recommendation_visits
      set acknowledged_at = greatest(acknowledged_at, (pending_snapshot ->> 'through')::timestamptz),
        pending_token = null, pending_snapshot = null, pending_events = null
      where user_id = ${scope.userId} and org_id = ${scope.orgId} and workspace_id = ${scope.workspaceId}`;
    return true;
  });
}
