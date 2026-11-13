import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { LIFT_ONE_ORG_PER_USER_POLICY } from "./helpers/multi-org.js";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let sweep: typeof import("../services/search-history-expiry.js");

beforeAll(async () => {
  const database = await startMigratedPostgres();
  await database.db.exec(LIFT_ONE_ORG_PER_USER_POLICY);
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  sweep = await import("../services/search-history-expiry.js");
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'history-expiry@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'Org', 'history-expiry', 'u')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('p', 'o', 'u', 'P')`;
  const session = (id: string, expires: string | null) => sql`
    insert into search_sessions (id, user_id, query, result_count, metadata, expires_at)
    values (${id}, 'u', 'q', 1, '{}', ${expires === null ? null : sql`now() + ${expires}::interval`})`;
  await session("expired", "-1 day");
  await session("live", "29 days");
  await session("kept", null);
  for (const id of ["expired", "live", "kept"]) {
    await sql`insert into search_session_results (id, session_id, chunk_id, rank, score) values (${`r-${id}`}, ${id}, 'c', 1, 0.5)`;
    await sql`insert into search_zero_results (id, session_id, user_id, project_id, reason, suggestions) values (${`z-${id}`}, ${id}, 'u', 'p', 'unknown', '[]')`;
  }
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

describe("search history expiry", () => {
  it("deletes only sessions past expires_at, with their result rows and diagnostics", async () => {
    expect(await sweep.sweepExpiredSearchSessions()).toBe(1);
    const sessions = await sql<{ id: string }[]>`select id from search_sessions order by id`;
    expect(sessions.map((row) => row.id)).toEqual(["kept", "live"]);
    const results = await sql<{ session_id: string }[]>`select session_id from search_session_results order by session_id`;
    expect(results.map((row) => row.session_id)).toEqual(["kept", "live"]);
    const zero = await sql<{ session_id: string }[]>`select session_id from search_zero_results order by session_id`;
    expect(zero.map((row) => row.session_id)).toEqual(["kept", "live"]);
    expect(await sweep.sweepExpiredSearchSessions()).toBe(0);
  });

  it("indexes expires_at and the foreign keys the sweep's deletes go through", async () => {
    const [index] = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where indexname = 'search_sessions_expires_at_idx'`;
    expect(index?.indexdef).toMatch(/expires_at IS NOT NULL/i);
    const names = (await sql<{ indexname: string }[]>`select indexname from pg_indexes where indexname in ('search_zero_results_session_idx', 'chat_answer_evidence_spans_search_session_idx')`).map((row) => row.indexname).sort();
    expect(names).toEqual(["chat_answer_evidence_spans_search_session_idx", "search_zero_results_session_idx"]);
  });
});
