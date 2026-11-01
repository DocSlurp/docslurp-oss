import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
let sql: postgres.Sql;
let stop: () => Promise<void>;
let getVisit: typeof import("../services/workspace-recommendation-visits.js").getRecommendationVisit;
let ack: typeof import("../services/workspace-recommendation-visits.js").acknowledgeRecommendationVisit;
const scope = { userId: "u", orgId: "o", workspaceId: "w" };
beforeAll(async () => {
  const db = await startMigratedPostgres(); stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  const service = await import("../services/workspace-recommendation-visits.js");
  getVisit = service.getRecommendationVisit; ack = service.acknowledgeRecommendationVisit;
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test'), ('v', 'V', 'v@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'O', 'o', 'u'), ('other', 'Other', 'other', 'v')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'o', 'u', 'W'), ('other', 'other', 'v', 'Other')`;
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
it("shares immutable pending evidence across devices and never acknowledges merely by reading", async () => {
  const first = await getVisit(scope);
  expect(first.since).toBeNull();
  expect(await getVisit(scope)).toEqual(first);
  const [row] = await sql`select acknowledged_at from workspace_recommendation_visits where workspace_id = 'w'`;
  expect(row!.acknowledged_at).toBeNull();
  expect(await ack(scope, first.token)).toBe(true);
  expect(await ack(scope, first.token)).toBe(false);
});
it("scopes activity and tokens, serializes concurrent reads, and retains activity after the snapshot", async () => {
  await sql`update workspace_recommendation_visits set acknowledged_at = now() - interval '1 day' where workspace_id = 'w'`;
  await sql`insert into search_sessions (id, user_id, query, result_count, metadata) values
    ('s', 'u', 'private query never returned', 0, '{"workspaceId":"w"}'),
    ('other', 'v', 'secret', 0, '{"workspaceId":"other"}')`;
  const [a, b] = await Promise.all([getVisit(scope), getVisit(scope)]);
  expect(a).toEqual(b); expect(a.searches).toBe(1); expect(a.emptySearches).toBe(1);
  expect(JSON.stringify(a)).not.toContain('private query');
  expect(await ack({ ...scope, userId: 'v' }, a.token)).toBe(false);
  expect(await ack({ ...scope, orgId: 'other', workspaceId: 'other' }, a.token)).toBe(false);
  await sql`insert into search_sessions (id, user_id, query, result_count, metadata) values ('later', 'u', 'later', 2, '{"workspaceId":"w"}')`;
  expect(await getVisit(scope)).toEqual(a);
  expect((await Promise.all([ack(scope, a.token), ack(scope, a.token)])).sort()).toEqual([false, true]);
  const next = await getVisit(scope);
  expect(next.searches).toBe(1); expect(next.emptySearches).toBe(0);
  expect(await ack(scope, a.token)).toBe(false);
  expect(await getVisit(scope)).toEqual(next);
});
it("bounds retained evidence and labels truncation", async () => {
  const pending = await getVisit(scope); await ack(scope, pending.token);
  await sql`insert into search_sessions (id, user_id, query, result_count, metadata)
    select 'bulk-' || n, 'u', 'q', 0, '{"workspaceId":"w"}'::jsonb from generate_series(1, 1100) n`;
  const next = await getVisit(scope);
  expect(next.searches).toBe(1001); expect(next.capped).toBe(true);
});
