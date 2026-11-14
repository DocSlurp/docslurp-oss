import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyRemainingMigrations, createMigratedDatabase, serveOnRandomPort, startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * project_activity_stats (migration 0163) against a database built from db/migrations: every counter equals the
 * aggregate over search_sessions / chat_turns it replaced, after every kind of write, and the project reads return
 * those numbers only for projects the caller can see.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let projects: typeof import("../services/projects.js");
let board: typeof import("../services/project-board-telemetry.js");
let backfill: typeof import("../services/search-session-project-backfill.js");
/**
 * PGlite runs one statement at a time, so it cannot show lost updates, lock waits or deadlocks. Point this at an
 * isolated PostgreSQL database migrated with db/migrate.mjs to run the concurrency block at the end of this file.
 */
const raceDatabaseUrl = process.env.PROJECT_ACTIVITY_STATS_RACE_DATABASE_URL;

type Totals = {
  project_id: string; search_sessions: number; search_result_count: number; zero_result_searches: number;
  search_duration_count: number; search_duration_ms: string; chat_turns: number;
};

/** The history aggregates the project list and board ran before 0163, for every project. */
async function oracle(client: postgres.Sql = sql): Promise<Totals[]> {
  return await client<Totals[]>`
    select w.id as project_id,
      (select count(*)::int from search_sessions s where s.project_id = w.id) as search_sessions,
      (select coalesce(sum(s.result_count), 0)::int from search_sessions s where s.project_id = w.id) as search_result_count,
      (select count(*)::int from search_sessions s where s.project_id = w.id and s.result_count = 0) as zero_result_searches,
      (select count(n.metadata ->> 'durationMs')::int from (
        select case when jsonb_typeof(s.metadata) = 'string' then (s.metadata #>> '{}')::jsonb else s.metadata end as metadata
        from search_sessions s where s.project_id = w.id) n) as search_duration_count,
      (select coalesce(sum((n.metadata ->> 'durationMs')::numeric), 0)::text from (
        select case when jsonb_typeof(s.metadata) = 'string' then (s.metadata #>> '{}')::jsonb else s.metadata end as metadata
        from search_sessions s where s.project_id = w.id) n) as search_duration_ms,
      (select count(*)::int from chat_turns t join chat_sessions cs on cs.id = t.session_id where cs.project_id = w.id) as chat_turns
    from projects w order by w.id
  `;
}

async function counters(client: postgres.Sql = sql): Promise<Totals[]> {
  return await client<Totals[]>`
    select w.id as project_id,
      coalesce(sum(a.search_sessions), 0)::int as search_sessions,
      coalesce(sum(a.search_result_count), 0)::int as search_result_count,
      coalesce(sum(a.zero_result_searches), 0)::int as zero_result_searches,
      coalesce(sum(a.search_duration_count), 0)::int as search_duration_count,
      coalesce(sum(a.search_duration_ms), 0)::text as search_duration_ms,
      coalesce(sum(a.chat_turns), 0)::int as chat_turns
    from projects w left join project_activity_stats a on a.project_id = w.id
    group by w.id order by w.id
  `;
}

async function expectCountersMatchHistory(client: postgres.Sql = sql) {
  expect(await counters(client)).toEqual(await oracle(client));
}

async function totals(projectId: string) {
  return (await counters()).find((row) => row.project_id === projectId)!;
}

let seq = 0;
async function addSearch(projectId: string | null, options: { results?: number; durationMs?: unknown; metadata?: string; id?: string } = {}) {
  const id = options.id ?? `s-${++seq}`;
  const metadata = options.metadata ?? JSON.stringify({
    ...(projectId ? { projectId } : {}), queryHash: id,
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
  });
  await sql`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
    values (${id}, 'u-a', ${projectId}, 'q', ${options.results ?? 3}, ${metadata}::text::jsonb)`;
  return id;
}

async function addChat(projectId: string, turns: number, userId = "u-a") {
  const id = `c-${++seq}`;
  await sql`insert into chat_sessions (id, project_id, user_id) values (${id}, ${projectId}, ${userId})`;
  if (turns > 0) {
    await sql`insert into chat_turns (id, session_id, role, content)
      select ${id} || '-t' || g, ${id}, 'user', 'hello' from generate_series(1, ${turns}::int) g`;
  }
  return id;
}

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u-a', 'A', 'a@activity.test'), ('u-b', 'B', 'b@activity.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('org-a', 'A', 'activity-a', 'u-a'), ('org-b', 'B', 'activity-b', 'u-b')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('org-a', 'u-a', 'owner'), ('org-b', 'u-b', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name) values
    ('p-a1', 'org-a', 'u-a', 'A one'), ('p-a2', 'org-a', 'u-a', 'A two'), ('p-b1', 'org-b', 'u-b', 'B one')`;
  projects = await import("../services/projects.js");
  board = await import("../services/project-board-telemetry.js");
  backfill = await import("../services/search-session-project-backfill.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

describe("search session counters", () => {
  it("counts inserts, zero-result searches and durations per project", async () => {
    await addSearch("p-a1", { results: 4, durationMs: 120 });
    await addSearch("p-a1", { results: 0, durationMs: 80 });
    await addSearch("p-a1", { results: 2 }); // no duration recorded
    await addSearch("p-a2", { results: 7, durationMs: 55 });
    expect(await totals("p-a1")).toMatchObject({
      search_sessions: 3, search_result_count: 6, zero_result_searches: 1, search_duration_count: 2, search_duration_ms: "200",
    });
    expect(await totals("p-a2")).toMatchObject({ search_sessions: 1, search_result_count: 7, search_duration_ms: "55" });
    expect(await totals("p-b1")).toMatchObject({ search_sessions: 0, search_result_count: 0, search_duration_count: 0 });
    await expectCountersMatchHistory();
  });

  it("counts one multi-row statement across projects once per project", async () => {
    await sql`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
      select 'bulk-' || g, 'u-a', case when g % 3 = 0 then 'p-a2' else 'p-a1' end, 'q', g % 4,
        jsonb_build_object('durationMs', g * 10)
      from generate_series(1, 60) g`;
    await expectCountersMatchHistory();
  });

  it("follows the persist upsert: a re-persisted session replaces its result count and duration", async () => {
    const id = await addSearch("p-a1", { results: 0, durationMs: 100 });
    const before = await totals("p-a1");
    await sql`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
      values (${id}, 'u-a', 'p-a1', 'q', 5, ${JSON.stringify({ projectId: "p-a1", queryHash: id, durationMs: 340 })}::text::jsonb)
      on conflict (id) do update set result_count = excluded.result_count, metadata = excluded.metadata`;
    const after = await totals("p-a1");
    expect(after.search_sessions).toBe(before.search_sessions);
    expect(after.search_result_count).toBe(before.search_result_count + 5);
    expect(after.zero_result_searches).toBe(before.zero_result_searches - 1);
    expect(Number(after.search_duration_ms)).toBe(Number(before.search_duration_ms) + 240);
    await expectCountersMatchHistory();
  });

  it("writes nothing when an update changes no counted value", async () => {
    const id = await addSearch("p-a2", { results: 1, durationMs: 10 });
    const [before] = await sql<{ rows: unknown }[]>`select jsonb_agg(to_jsonb(a) order by a.slot) as rows from project_activity_stats a where project_id = 'p-a2'`;
    await sql`update search_sessions set variant = 'b', query = 'other' where id = ${id}`;
    const [after] = await sql<{ rows: unknown }[]>`select jsonb_agg(to_jsonb(a) order by a.slot) as rows from project_activity_stats a where project_id = 'p-a2'`;
    expect(after!.rows).toEqual(before!.rows);
  });

  it("removes deleted sessions, including a batch across projects", async () => {
    await sql`delete from search_sessions where id = 'bulk-1'`;
    await expectCountersMatchHistory();
    await sql`delete from search_sessions where id like 'bulk-%' and result_count = 0`;
    await expectCountersMatchHistory();
  });

  it("moves a session between projects", async () => {
    const id = await addSearch("p-a1", { results: 9, durationMs: 77 });
    const from = await totals("p-a1");
    const to = await totals("p-a2");
    await sql`update search_sessions set project_id = 'p-a2' where id = ${id}`;
    expect((await totals("p-a1")).search_sessions).toBe(from.search_sessions - 1);
    expect((await totals("p-a2")).search_sessions).toBe(to.search_sessions + 1);
    expect((await totals("p-a2")).search_result_count).toBe(to.search_result_count + 9);
    await expectCountersMatchHistory();
  });

  it("leaves sessions without a project out, and counts them when the 0152 sweep fills project_id", async () => {
    const before = await totals("p-a1");
    // Rows as they were before 0152: no column value. The 0152 insert trigger would fill it, so disable it here.
    await sql`alter table search_sessions disable trigger search_sessions_set_project_id`;
    await sql`insert into search_sessions (id, user_id, query, result_count, metadata) values
      ('legacy-1', 'u-a', 'q', 0, '{"projectId":"p-a1","durationMs":40}'),
      ('legacy-2', 'u-a', 'q', 6, '{"projectId":"p-a1"}'),
      ('legacy-gone', 'u-a', 'q', 6, '{"projectId":"deleted-project","durationMs":5}'),
      ('legacy-none', 'u-a', 'q', 2, '{"durationMs":5}')`;
    await sql`alter table search_sessions enable trigger search_sessions_set_project_id`;
    expect(await totals("p-a1")).toEqual(before);
    await expectCountersMatchHistory();

    expect(await backfill.sweepSearchSessionProjectBackfill({ sql, batchSize: 2 })).toBe(2);
    expect(await totals("p-a1")).toMatchObject({
      search_sessions: before.search_sessions + 2,
      search_result_count: before.search_result_count + 6,
      zero_result_searches: before.zero_result_searches + 1,
      search_duration_count: before.search_duration_count + 1,
    });
    await expectCountersMatchHistory();
    // Deleting sessions that never had a project changes no counter.
    await sql`delete from search_sessions where id in ('legacy-gone', 'legacy-none')`;
    await expectCountersMatchHistory();
  });

  it("reads older metadata shapes as the board did, and never fails a write on any metadata", async () => {
    const before = await totals("p-a2");
    await addSearch("p-a2", { durationMs: "250" }); // numeric string
    await addSearch("p-a2", { metadata: JSON.stringify(JSON.stringify({ durationMs: 50 })) }); // object stored as a JSON string
    expect(await totals("p-a2")).toMatchObject({
      search_duration_count: before.search_duration_count + 2,
      search_duration_ms: String(Number(before.search_duration_ms) + 300),
    });
    await expectCountersMatchHistory();

    const counted = await totals("p-a2");
    const odd = [
      JSON.stringify({ durationMs: "fast" }), JSON.stringify({ durationMs: "NaN" }), JSON.stringify({ durationMs: "Infinity" }),
      JSON.stringify({ durationMs: null }), JSON.stringify({ durationMs: { ms: 1 } }), JSON.stringify({ durationMs: [1] }),
      JSON.stringify({ durationMs: true }), JSON.stringify("not json at all"), JSON.stringify("[1,2]"), "[]", "null", "7",
    ];
    const ids: string[] = [];
    for (const metadata of odd) ids.push(await addSearch("p-a2", { metadata }));
    expect(await totals("p-a2")).toMatchObject({
      search_sessions: counted.search_sessions + odd.length,
      search_duration_count: counted.search_duration_count,
      search_duration_ms: counted.search_duration_ms,
    });
    await sql`update search_sessions set result_count = result_count + 1 where id = any(${ids})`;
    await sql`delete from search_sessions where id = any(${ids})`;
    expect(await totals("p-a2")).toEqual(counted);
    await expectCountersMatchHistory();
  });

  it("removes expired sessions through the retention sweep", async () => {
    await sql`update search_sessions set expires_at = now() - interval '1 hour' where id in (select id from search_sessions where project_id = 'p-a1' order by id limit 3)`;
    const { sweepExpiredSearchSessions } = await import("../services/search-history-expiry.js");
    expect(await sweepExpiredSearchSessions()).toBe(3);
    await expectCountersMatchHistory();
  });
});

describe("chat turn counters", () => {
  it("counts turns in the project of their session", async () => {
    const before = await totals("p-a1");
    const chat = await addChat("p-a1", 4);
    await addChat("p-a2", 2);
    await addChat("p-a1", 0);
    expect((await totals("p-a1")).chat_turns).toBe(before.chat_turns + 4);
    await sql`delete from chat_turns where id = ${chat + "-t1"}`;
    expect((await totals("p-a1")).chat_turns).toBe(before.chat_turns + 3);
    await expectCountersMatchHistory();
  });

  it("removes a deleted session's turns once, single or in a batch", async () => {
    const one = await addChat("p-a1", 5);
    await addChat("p-a1", 3);
    await addChat("p-a2", 6);
    await sql`delete from chat_sessions where id = ${one}`;
    await expectCountersMatchHistory();
    await sql`delete from chat_sessions where user_id = 'u-a' and project_id in ('p-a1', 'p-a2')`;
    expect((await totals("p-a1")).chat_turns).toBe(0);
    expect((await totals("p-a2")).chat_turns).toBe(0);
    await expectCountersMatchHistory();
  });

  it("moves the turns of a session that changes project, and a turn that changes session", async () => {
    const chat = await addChat("p-a1", 4);
    const other = await addChat("p-a2", 1);
    await sql`update chat_sessions set project_id = 'p-a2' where id = ${chat}`;
    expect((await totals("p-a1")).chat_turns).toBe(0);
    expect((await totals("p-a2")).chat_turns).toBe(5);
    await sql`update chat_sessions set search_overrides = '{"topK":3}' where id = ${chat}`;
    await sql`update chat_sessions set project_id = 'p-a1' where id = ${other}`;
    await sql`update chat_turns set session_id = ${other} where id = ${chat + "-t1"}`;
    expect((await totals("p-a1")).chat_turns).toBe(2);
    expect((await totals("p-a2")).chat_turns).toBe(3);
    await expectCountersMatchHistory();
  });
});

describe("project reads", () => {
  it("returns the counters from listProjects, getProject and the board summaries", async () => {
    const history = await oracle();
    const listed = await projects.listProjects("u-a");
    expect(listed.map((project) => project.id).sort()).toEqual(["p-a1", "p-a2"]);
    for (const project of listed) {
      const expected = history.find((row) => row.project_id === project.id)!;
      expect(project.searchSessionCount).toBe(expected.search_sessions);
      expect(project.chatMessageCount).toBe(expected.chat_turns);
      const single = await projects.getProject(project.id, "u-a");
      expect(single).toMatchObject({ searchSessionCount: expected.search_sessions, chatMessageCount: expected.chat_turns });
    }
    const summaries = await board.listProjectBoardSummaries(["p-a1", "p-a2"]);
    for (const [projectId, summary] of summaries) {
      const expected = history.find((row) => row.project_id === projectId)!;
      expect(summary.searchSessions).toBe(expected.search_sessions);
      expect(summary.searchResultCount).toBe(expected.search_result_count);
      expect(summary.zeroResultSearches).toBe(expected.zero_result_searches);
      // The double avg() returned over the same sessions.
      const [avg] = await sql<{ avg: number | null }[]>`
        select avg((case when jsonb_typeof(metadata) = 'string' then (metadata #>> '{}')::jsonb else metadata end ->> 'durationMs')::double precision) as avg
        from search_sessions where project_id = ${projectId}`;
      expect(summary.averageSearchMs).toBe(avg!.avg);
    }
    expect(summaries.get("p-a1")!.searchSessions).toBeGreaterThan(0);
  });

  it("reports no searches and a null average for a project without history", async () => {
    await sql`insert into projects (id, org_id, user_id, name) values ('p-empty', 'org-a', 'u-a', 'Empty')`;
    const summary = (await board.listProjectBoardSummaries(["p-empty"])).get("p-empty")!;
    expect(summary).toMatchObject({ searchSessions: 0, searchResultCount: 0, zeroResultSearches: 0, averageSearchMs: null });
    expect(await projects.getProject("p-empty", "u-a")).toMatchObject({ searchSessionCount: 0, chatMessageCount: 0 });
    // Sessions that come and go leave zeros and still no average.
    const id = await addSearch("p-empty", { durationMs: 12 });
    await sql`delete from search_sessions where id = ${id}`;
    expect((await board.listProjectBoardSummaries(["p-empty"])).get("p-empty")!).toMatchObject({ searchSessions: 0, averageSearchMs: null });
    await sql`delete from projects where id = 'p-empty'`;
  });
});

describe("tenant boundary", () => {
  it("never returns another organization's counters", async () => {
    await sql`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
      select 'b-' || g, 'u-b', 'p-b1', 'q', 2, '{"durationMs":900}' from generate_series(1, 7) g`;
    await sql`insert into chat_sessions (id, project_id, user_id) values ('b-chat', 'p-b1', 'u-b')`;
    await sql`insert into chat_turns (id, session_id, role, content) select 'b-turn-' || g, 'b-chat', 'user', 'x' from generate_series(1, 3) g`;

    // Organization A's member: B's project is absent from the list and unreadable by id.
    const listedForA = await projects.listProjects("u-a");
    expect(listedForA.some((project) => project.id === "p-b1" || project.orgId === "org-b")).toBe(false);
    expect(await projects.getProject("p-b1", "u-a")).toBeNull();
    // The already-authorized read is pinned to the organization: the wrong organization gets nothing.
    expect(await projects.getAuthorizedProjectRecord("p-b1", "org-a")).toBeNull();
    expect(await projects.getAuthorizedProjectRecord("p-b1", "org-b")).toMatchObject({ searchSessionCount: 7, chatMessageCount: 3 });

    // B's member sees exactly B's numbers, and none of A's.
    const listedForB = await projects.listProjects("u-b");
    expect(listedForB.map((project) => project.id)).toEqual(["p-b1"]);
    expect(listedForB[0]).toMatchObject({ searchSessionCount: 7, chatMessageCount: 3 });
    expect(await projects.getProject("p-a1", "u-b")).toBeNull();

    // Board summaries return only the requested projects.
    const summaries = await board.listProjectBoardSummaries(["p-a1"]);
    expect([...summaries.keys()]).toEqual(["p-a1"]);
    expect(summaries.get("p-a1")!.searchSessions).not.toBe(7);
  });

  it("never changes another project's counters, whatever is written", async () => {
    const stored = async (projectId: string) => (await sql<{ rows: unknown }[]>`
      select jsonb_agg(to_jsonb(a) order by a.slot) as rows from project_activity_stats a where a.project_id = ${projectId}`)[0]!.rows;
    const bystander = await stored("p-b1");
    expect(bystander).not.toBeNull();

    await addSearch("p-a1", { results: 0, durationMs: 1 });
    await sql`update search_sessions set result_count = result_count + 1 where project_id = 'p-a1'`;
    await sql`delete from search_sessions where id in (select id from search_sessions where project_id = 'p-a2' limit 2)`;
    const chat = await addChat("p-a1", 2);
    await sql`delete from chat_sessions where id = ${chat}`;
    // Metadata naming another organization's project does not move a session that has its own project_id.
    await sql`update search_sessions set metadata = metadata || '{"projectId":"p-b1"}' where project_id = 'p-a1'`;
    expect(await stored("p-b1")).toEqual(bystander);

    // Deleting a whole project removes its counters and nothing else.
    await sql`insert into projects (id, org_id, user_id, name) values ('p-a3', 'org-a', 'u-a', 'A three')`;
    await addSearch("p-a3", { durationMs: 5 });
    await addChat("p-a3", 3);
    const neighbour = await stored("p-a2");
    await sql`delete from projects where id = 'p-a3'`;
    expect(await sql`select 1 from project_activity_stats where project_id = 'p-a3'`).toHaveLength(0);
    expect(await stored("p-b1")).toEqual(bystander);
    expect(await stored("p-a2")).toEqual(neighbour);
    await expectCountersMatchHistory();
  });

  it("rejects a counter row for a project that does not exist", async () => {
    await expect(sql`insert into project_activity_stats (project_id, slot, search_sessions) values ('no-such-project', 0, 5)`)
      .rejects.toThrow(/foreign key/);
    await expect(sql`insert into project_activity_stats (project_id, slot) values ('p-a1', 8)`).rejects.toThrow(/slot_check/);
  });

  it("zeroes the counters when a table is truncated", async () => {
    await sql`truncate chat_turns`;
    await expectCountersMatchHistory();
    await sql`truncate search_sessions cascade`;
    await expectCountersMatchHistory();
    expect((await totals("p-b1")).search_sessions).toBe(0);
  });
});

describe("migration 0163 backfill", () => {
  it("counts existing history, skips sessions without a project, and is the same on a second run", async () => {
    const db = await createMigratedDatabase({ stopBefore: "project_activity_stats" });
    const { server, port } = await serveOnRandomPort(db);
    const old = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await old`insert into "user" (id, name, email) values ('u', 'U', 'backfill@activity.test')`;
      await old`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'O', 'activity-backfill', 'u')`;
      await old`insert into projects (id, org_id, user_id, name) values ('p1', 'o', 'u', 'One'), ('p2', 'o', 'u', 'Two'), ('p3', 'o', 'u', 'Three')`;
      await old`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
        select 'h-' || g, 'u', case when g % 4 = 0 then 'p2' else 'p1' end, 'q', g % 3,
          case when g % 5 = 0 then '{}'::jsonb else jsonb_build_object('durationMs', g * 3) end
        from generate_series(1, 200) g`;
      await old`alter table search_sessions disable trigger search_sessions_set_project_id`;
      await old`insert into search_sessions (id, user_id, query, result_count, metadata) values
        ('h-null', 'u', 'q', 4, '{"projectId":"p1","durationMs":10}')`;
      await old`alter table search_sessions enable trigger search_sessions_set_project_id`;
      await old`insert into chat_sessions (id, project_id, user_id) values ('hc1', 'p1', 'u'), ('hc2', 'p2', 'u')`;
      await old`insert into chat_turns (id, session_id, role, content)
        select 'ht-' || g, case when g % 3 = 0 then 'hc2' else 'hc1' end, 'user', 'x' from generate_series(1, 30) g`;

      await applyRemainingMigrations(db, "project_activity_stats");
      await expectCountersMatchHistory(old);
      const first = await counters(old);
      expect(first.find((row) => row.project_id === "p1")).toMatchObject({ search_sessions: 150, chat_turns: 20 });
      expect(first.find((row) => row.project_id === "p3")).toMatchObject({ search_sessions: 0, chat_turns: 0 });

      // Writes after the migration land on top of the backfilled totals.
      await old`insert into search_sessions (id, user_id, project_id, query, result_count, metadata) values ('h-new', 'u', 'p1', 'q', 1, '{"durationMs":9}')`;
      await old`update search_sessions set project_id = 'p1' where id = 'h-null'`;
      await expectCountersMatchHistory(old);

      const beforeRerun = await counters(old);
      await applyRemainingMigrations(db, "project_activity_stats");
      expect(await counters(old)).toEqual(beforeRerun);
      await expectCountersMatchHistory(old);
    } finally {
      await old.end();
      await server.stop();
      await db.close();
    }
  }, 120_000);
});

describe.skipIf(!raceDatabaseUrl)("concurrent writers (native PostgreSQL)", () => {
  const CONNECTIONS = 16;
  let pool: postgres.Sql;
  const failures: string[] = [];
  /**
   * Expected refusals: a foreign-key violation for a write into a session or project deleted meanwhile, and a
   * deadlock abort when a single turn is deleted while its session is (0163 documents it). Neither may cost a count.
   */
  const attempt = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "23503" && code !== "40P01") failures.push(`${code ?? "?"} ${(error as Error).message}`);
    }
  };

  beforeAll(async () => {
    pool = postgres(raceDatabaseUrl!, { max: CONNECTIONS, prepare: false, onnotice: () => {} });
    await pool`delete from projects where id like 'race-%'`;
    await pool`insert into "user" (id, name, email) values ('race-u', 'Race', 'race@activity.test') on conflict (id) do nothing`;
    await pool`insert into organizations (id, name, slug, created_by_user_id) values ('race-o', 'Race', 'activity-race', 'race-u') on conflict (id) do nothing`;
    await pool`insert into projects (id, org_id, user_id, name) select 'race-p' || g, 'race-o', 'race-u', 'Race ' || g from generate_series(1, 4) g`;
  }, 60_000);

  afterAll(async () => {
    await pool`delete from projects where id like 'race-%'`;
    await pool`delete from organizations where id = 'race-o'`;
    await pool`delete from "user" where id = 'race-u'`;
    await pool.end();
  });

  it("keeps every counter exact under concurrent inserts, re-persists, moves and deletes in one project", async () => {
    await Promise.all(Array.from({ length: CONNECTIONS }, async (_, worker) => {
      for (let i = 0; i < 150; i += 1) {
        const id = `race-s-${worker}-${i % 40}`;
        const metadata = JSON.stringify({ projectId: "race-p1", queryHash: id, ...(i % 7 === 0 ? {} : { durationMs: 10 + ((worker * 31 + i) % 500) }) });
        const step = (worker + i) % 6;
        if (step <= 2) {
          await attempt(() => pool.begin(async (tx) => {
            await tx`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
              values (${id}, 'race-u', 'race-p1', 'q', ${i % 5}, ${metadata}::text::jsonb)
              on conflict (id) do update set result_count = excluded.result_count, metadata = excluded.metadata`;
          }));
        } else if (step === 3) {
          await attempt(() => pool`update search_sessions set project_id = case when project_id = 'race-p1' then 'race-p2' else 'race-p1' end where id = ${id}`);
        } else if (step === 4) {
          await attempt(() => pool`delete from search_sessions where id = ${id}`);
        } else {
          // One statement over several projects, in an order that differs between workers.
          await attempt(() => pool`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
            select 'race-m-' || ${worker}::int || '-' || ${i}::int || '-' || g, 'race-u', 'race-p' || (1 + (g + ${worker}::int) % 4), 'q', g % 3, '{"durationMs":7}'
            from generate_series(1, 6) g order by case when ${worker}::int % 2 = 0 then g else -g end`);
        }
      }
    }));
    expect(failures).toEqual([]);
    const rows = await counters(pool);
    expect(rows.filter((row) => row.project_id.startsWith("race-"))).toEqual((await oracle(pool)).filter((row) => row.project_id.startsWith("race-")));
    expect(rows.find((row) => row.project_id === "race-p1")!.search_sessions).toBeGreaterThan(0);
    // The writers really were spread over several counter rows.
    const [{ slots }] = await pool<{ slots: number }[]>`select count(*)::int as slots from project_activity_stats where project_id = 'race-p1'`;
    expect(slots).toBeGreaterThan(1);
  }, 120_000);

  it("counts chat turns exactly while sessions are deleted and moved under the inserts", async () => {
    await pool`insert into chat_sessions (id, project_id, user_id) select 'race-c' || g, 'race-p' || (1 + g % 2), 'race-u' from generate_series(1, 60) g`;
    const writers = Array.from({ length: CONNECTIONS - 4 }, async (_, worker) => {
      for (let i = 0; i < 200; i += 1) {
        const session = `race-c${1 + ((worker * 7 + i) % 60)}`;
        await attempt(() => pool`insert into chat_turns (id, session_id, role, content) values (${`race-t-${worker}-${i}`}, ${session}, 'user', 'x')`);
        if (i % 25 === 0) await attempt(() => pool`delete from chat_turns where id = ${`race-t-${worker}-${i - 3}`}`);
      }
    });
    const removers = Array.from({ length: 2 }, async (_, worker) => {
      for (let i = 0; i < 20; i += 1) await attempt(() => pool`delete from chat_sessions where id = ${`race-c${1 + worker + i * 2}`}`);
    });
    const movers = Array.from({ length: 2 }, async (_, worker) => {
      for (let i = 0; i < 40; i += 1) {
        await attempt(() => pool`update chat_sessions set project_id = case when project_id = 'race-p1' then 'race-p3' else 'race-p1' end
          where id = ${`race-c${41 + ((worker * 5 + i) % 20)}`}`);
      }
    });
    await Promise.all([...writers, ...removers, ...movers]);
    expect(failures).toEqual([]);
    const rows = (await counters(pool)).filter((row) => row.project_id.startsWith("race-"));
    expect(rows).toEqual((await oracle(pool)).filter((row) => row.project_id.startsWith("race-")));
    expect(rows.reduce((sum, row) => sum + row.chat_turns, 0)).toBeGreaterThan(0);
  }, 120_000);

  it("removes a project and its counters while searches are still arriving for it", async () => {
    const inserts = Array.from({ length: 8 }, async (_, worker) => {
      for (let i = 0; i < 100; i += 1) {
        await attempt(() => pool`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
          values (${`race-d-${worker}-${i}`}, 'race-u', 'race-p4', 'q', 1, '{"durationMs":3}')`);
      }
    });
    const removal = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await pool`delete from projects where id = 'race-p4'`;
    })();
    await Promise.all([...inserts, removal]);
    expect(failures).toEqual([]);
    expect(await pool`select 1 from project_activity_stats where project_id = 'race-p4'`).toHaveLength(0);
    expect(await pool`select 1 from search_sessions where project_id = 'race-p4'`).toHaveLength(0);
    const rows = (await counters(pool)).filter((row) => row.project_id.startsWith("race-"));
    expect(rows).toEqual((await oracle(pool)).filter((row) => row.project_id.startsWith("race-")));
  }, 120_000);
});
