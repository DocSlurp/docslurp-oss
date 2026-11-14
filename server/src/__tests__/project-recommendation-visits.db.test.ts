import postgres from "postgres";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
let sql: postgres.Sql;
let stop: () => Promise<void>;
let getVisit: typeof import("../services/project-recommendation-visits.js").getRecommendationVisit;
let ack: typeof import("../services/project-recommendation-visits.js").acknowledgeRecommendationVisit;
const scope = { userId: "u", orgId: "o", projectId: "w" };
beforeAll(async () => {
  const external = process.env.RECOMMENDATION_TEST_DATABASE_URL;
  const db = external ? null : await startMigratedPostgres();
  stop = db?.stop ?? (async () => {});
  sql = postgres(external ?? db!.url, { max: external ? 4 : 1, prepare: false, onnotice: () => {} });
  const [existing] = external ? await sql`select to_regclass('project_recommendation_visits') as relation` : [];
  if (external && !existing?.relation) {
    // Dedicated disposable DB only: apply the actual migration journal, never an ad-hoc schema.
    const base = new URL("../../db/migrations/", import.meta.url);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", base), "utf8"));
    for (const entry of journal.entries) await sql.begin(async tx => {
      for (const statement of readFileSync(new URL(`${entry.tag}.sql`, base), "utf8").split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.unsafe(statement);
      }
    });
  }
  vi.doMock("../db.js", () => ({ sql }));
  const service = await import("../services/project-recommendation-visits.js");
  getVisit = service.getRecommendationVisit; ack = service.acknowledgeRecommendationVisit;
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test'), ('v', 'V', 'v@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'O', 'o', 'u'), ('other', 'Other', 'other', 'v')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('w', 'o', 'u', 'W'), ('other', 'other', 'v', 'Other')`;
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
it("shares immutable pending evidence across devices and never acknowledges merely by reading", async () => {
  const first = await getVisit(scope);
  expect(first.since).toBeNull();
  expect(await getVisit(scope)).toEqual(first);
  const [row] = await sql`select acknowledged_at from project_recommendation_visits where project_id = 'w'`;
  expect(row!.acknowledged_at).toBeNull();
  expect(await ack(scope, first.token)).toBe(true);
  expect(await ack(scope, first.token)).toBe(false);
});
it("scopes activity and tokens, serializes concurrent reads, and retains activity after the snapshot", async () => {
  await sql`update project_recommendation_visits set tracking_since = now() - interval '1 day' where project_id = 'w'`;
  await sql`insert into search_sessions (id, user_id, query, result_count, metadata, project_id) values
    ('s', 'u', 'private query never returned', 0, '{"projectId":"w"}', 'w'),
    ('other', 'v', 'secret', 0, '{"projectId":"other"}', 'other')`;
  await sql`insert into search_sessions (id, user_id, query, result_count, metadata, project_id)
    select 'busy-' || n, 'u', 'q', 1, '{"projectId":"w"}'::jsonb, 'w' from generate_series(1, 19) n`;
  const [a, b] = await Promise.all([getVisit(scope), getVisit(scope)]);
  expect(a).toEqual(b); expect(a.searches).toBe(20); expect(a.emptySearches).toBe(1);
  expect(JSON.stringify(a)).not.toContain('private query');
  expect(await ack({ ...scope, userId: 'v' }, a.token)).toBe(false);
  expect(await ack({ ...scope, orgId: 'other', projectId: 'other' }, a.token)).toBe(false);
  await sql`insert into search_sessions (id, user_id, query, result_count, metadata, project_id) values ('later', 'u', 'later', 2, '{"projectId":"w"}', 'w')`;
  expect(await getVisit(scope)).toEqual(a);
  expect((await Promise.all([ack(scope, a.token), ack(scope, a.token)])).sort()).toEqual([false, true]);
  const next = await getVisit(scope);
  expect(next.searches).toBe(1); expect(next.emptySearches).toBe(0);
  expect(await ack(scope, a.token)).toBe(false);
  expect(await getVisit(scope)).toEqual(next);
});
it("bounds retained evidence and labels truncation", async () => {
  const pending = await getVisit(scope); await ack(scope, pending.token);
  await sql`insert into search_sessions (id, user_id, query, result_count, metadata, project_id)
    select 'bulk-' || n, 'u', 'q', 0, '{"projectId":"w"}'::jsonb, 'w' from generate_series(1, 1100) n`;
  const next = await getVisit(scope);
  expect(next.searches).toBe(1001); expect(next.capped).toBe(true);
});

it("quiet activity accumulates across reads and acknowledgement consumes only observed IDs", async () => {
  const current = await getVisit(scope); await ack(scope, current.token);
  // Complete any capped remainder, then start a quiet batch.
  const remainder = await getVisit(scope); await ack(scope, remainder.token);
  await sql`insert into search_sessions (id, user_id, query, result_count, metadata, project_id)
    select 'quiet-' || n, 'u', 'q', 1, '{"projectId":"w"}'::jsonb, 'w' from generate_series(1, 19) n`;
  const quiet = await getVisit(scope); expect(quiet.searches).toBe(19);
  expect(await getVisit(scope)).toEqual(quiet);
  await sql`insert into search_sessions (id, user_id, query, result_count, metadata, project_id) values ('threshold', 'u', 'q', 1, '{"projectId":"w"}', 'w')`;
  const busy = await getVisit(scope); expect(busy.searches).toBe(20);
  expect(await ack(scope, quiet.token)).toBe(false);
  expect(await ack(scope, busy.token)).toBe(true);
});

it.skipIf(!process.env.RECOMMENDATION_TEST_DATABASE_URL)("retains a transaction committed after its snapshot on a different PostgreSQL backend", async () => {
  const writer = postgres(process.env.RECOMMENDATION_TEST_DATABASE_URL!, { max: 1, prepare: false });
  let pending!: Awaited<ReturnType<typeof getVisit>>;
  try {
    await writer.begin(async tx => {
      const [a] = await tx`select pg_backend_pid() as pid`;
      const [b] = await sql`select pg_backend_pid() as pid`;
      expect(a!.pid).not.toBe(b!.pid);
      await tx`insert into search_sessions (id, user_id, query, result_count, metadata, project_id)
        values ('late-commit', 'u', 'q', 0, '{"projectId":"w"}', 'w')`;
      pending = await getVisit(scope);
      expect(pending.searches).toBe(0);
    });
    expect(await ack(scope, pending.token)).toBe(true);
    const late = await getVisit(scope);
    expect(late.searches).toBe(1); expect(late.emptySearches).toBe(1);
    expect(await ack(scope, late.token)).toBe(true);
    expect((await getVisit(scope)).searches).toBe(0);
  } finally { await writer.end(); }
});

it("rechecks persisted membership on both mounted endpoints after revocation", async () => {
  const { projectRecommendationVisitsRoutes } = await import("../routes/project-recommendation-visits.js");
  const app = new Hono().use('*', async (c, next) => {
    c.set('sessionUser', { id: 'u', email: 'u@example.test', name: 'U' }); await next();
  }).route('/v1/projects', projectRecommendationVisitsRoutes);
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  const response = await app.request('/v1/projects/w/recommendation-visit');
  expect(response.status).toBe(200);
  const pending = await response.json();
  await sql`delete from org_memberships where org_id = 'o' and user_id = 'u'`;
  expect((await app.request('/v1/projects/w/recommendation-visit')).status).toBe(404);
  expect((await app.request('/v1/projects/w/recommendation-visit/acknowledge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: pending.token }),
  })).status).toBe(404);
  expect(await getVisit(scope)).toEqual(pending);
});

it("cascades deduplication state when a visit or project is deleted", async () => {
  await sql`delete from project_recommendation_visits where user_id = 'u' and org_id = 'o' and project_id = 'w'`;
  const [row] = await sql`select count(*)::int as count from project_recommendation_seen_events where project_id = 'w'`;
  expect(row!.count).toBe(0);
});
