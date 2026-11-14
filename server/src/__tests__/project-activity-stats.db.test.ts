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
let driftService: typeof import("../services/project-activity-stats-drift.js");
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
  driftService = await import("../services/project-activity-stats-drift.js");
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

  it("keeps counter rows only for projects that exist", async () => {
    // No foreign key (a counter write must never wait for a project row): the trigger on projects removes the rows,
    // and no write above left one behind for a project that is gone.
    expect(await sql`select project_id from project_activity_stats a where not exists (select 1 from projects w where w.id = a.project_id)`).toHaveLength(0);
    const [fk] = await sql<{ count: number }[]>`
      select count(*)::int as count from pg_constraint where conrelid = 'project_activity_stats'::regclass and contype = 'f'`;
    expect(fk!.count).toBe(0);
    // The cleanup trigger sorts after every foreign-key cascade trigger on projects, so it runs once the delete
    // holds all of the project's sessions and turns.
    const names = (await sql<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'projects'::regclass and tgtype & 8 = 8 and tgtype & 1 = 1 and tgtype & 2 = 0
      order by tgname::text collate "C"`).map((row) => row.tgname);
    expect(names.at(-1)).toBe("zz_projects_activity_stats_delete");
    expect(names.some((name) => name.startsWith("RI_ConstraintTrigger_"))).toBe(true);
  });

  it("zeroes the counters when a table is truncated", async () => {
    await sql`truncate chat_turns`;
    await expectCountersMatchHistory();
    await sql`truncate search_sessions cascade`;
    await expectCountersMatchHistory();
    expect((await totals("p-b1")).search_sessions).toBe(0);
  });
});

describe("drift check and rebuild", () => {
  const drifted = async (projectIds?: string[]) => await driftService.findProjectActivityStatsDrift({ sql, projectIds });

  it("reports nothing while the triggers maintain the counters", async () => {
    await addSearch("p-a1", { results: 2, durationMs: 30 });
    await addSearch("p-a2", { results: 0, durationMs: 7 });
    await addSearch("p-b1", { results: 5 });
    await addChat("p-a1", 3);
    await addChat("p-b1", 2);
    await expectCountersMatchHistory();
    expect(await drifted()).toEqual([]);
    expect(await driftService.sweepProjectActivityStatsDrift({ sql, force: true })).toEqual([]);
  });

  it("reports every way the counters can leave history, per project and for a sample", async () => {
    const exact = await counters();
    // Writes that bypass the triggers, as logical replication apply and some restore tools do.
    await sql`set session_replication_role = replica`;
    await sql`insert into search_sessions (id, user_id, project_id, query, result_count, metadata) values
      ('drift-1', 'u-a', 'p-a1', 'q', 0, '{"durationMs":40}'), ('drift-2', 'u-a', 'p-a1', 'q', 6, '{}')`;
    await sql`insert into chat_turns (id, session_id, role, content)
      select 'drift-turn-' || g, (select id from chat_sessions where project_id = 'p-b1' order by id limit 1), 'user', 'x' from generate_series(1, 4) g`;
    await sql`set session_replication_role = origin`;
    // A trigger disabled for a while.
    await sql`alter table search_sessions disable trigger search_sessions_activity_stats_delete`;
    await sql`delete from search_sessions where id in (select id from search_sessions where project_id = 'p-a2' order by id limit 1)`;
    await sql`alter table search_sessions enable trigger search_sessions_activity_stats_delete`;
    // A counter row left for a project that does not exist.
    await sql`insert into project_activity_stats (project_id, search_sessions) values ('gone-project', 9)`;
    expect(await counters()).toEqual(exact); // nothing above moved a counter

    const all = await drifted();
    expect(all.map((row) => row.projectId)).toEqual(["gone-project", "p-a1", "p-a2", "p-b1"]);
    const a1 = all.find((row) => row.projectId === "p-a1")!;
    const before = exact.find((row) => row.project_id === "p-a1")!;
    expect(a1.projectExists).toBe(true);
    expect(a1.stored).toMatchObject({ search_sessions: before.search_sessions, zero_result_searches: before.zero_result_searches });
    expect(a1.actual).toMatchObject({
      search_sessions: before.search_sessions + 2, search_result_count: before.search_result_count + 6,
      zero_result_searches: before.zero_result_searches + 1, search_duration_count: before.search_duration_count + 1,
      search_duration_ms: Number(before.search_duration_ms) + 40, chat_turns: before.chat_turns,
    });
    const b1 = all.find((row) => row.projectId === "p-b1")!;
    expect(b1.actual.chat_turns).toBe(b1.stored.chat_turns + 4);
    expect(b1.actual.search_sessions).toBe(b1.stored.search_sessions);
    expect(all.find((row) => row.projectId === "gone-project")).toMatchObject({ projectExists: false, stored: { search_sessions: 9 }, actual: { search_sessions: 0 } });

    // Limited to the named projects: another project's drift is neither read nor reported.
    expect((await drifted(["p-a2"])).map((row) => row.projectId)).toEqual(["p-a2"]);
    expect(await drifted(["p-empty-none"])).toEqual([]);

    // The maintenance sweep samples projects, reports the difference and repairs nothing.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const found = await driftService.sweepProjectActivityStatsDrift({ sql, force: true, sample: 100 });
      expect(found.map((row) => row.projectId)).toEqual(["p-a1", "p-a2", "p-b1"]);
      expect(logged.mock.calls.flat().join(" ")).toMatch(/\[project-activity-stats\] counter drift in 3 of \d+ sampled projects/);
    } finally {
      logged.mockRestore();
    }
    expect(await counters()).toEqual(exact);
  });

  it("rebuilds every counter exactly, into one row per project, and reports no drift afterwards", async () => {
    const history = await oracle();
    const [{ written }] = await sql<{ written: string }[]>`select rebuild_project_activity_stats() as written`;
    const withHistory = history.filter((row) => row.search_sessions > 0 || row.chat_turns > 0);
    expect(Number(written)).toBe(withHistory.length);
    await expectCountersMatchHistory();
    expect(await drifted()).toEqual([]);
    const rows = await sql<{ project_id: string; rows: number }[]>`
      select project_id, count(*)::int as rows from project_activity_stats group by project_id order by project_id`;
    expect(rows).toEqual(withHistory.map((row) => ({ project_id: row.project_id, rows: 1 })));

    // Writes after a rebuild land on the rebuilt totals, and a second rebuild stores the same numbers.
    await addSearch("p-a1", { results: 1, durationMs: 3 });
    await sql`delete from search_sessions where id = 'drift-1'`;
    await expectCountersMatchHistory();
    const stored = await counters();
    await sql`select rebuild_project_activity_stats()`;
    expect(await counters()).toEqual(stored);
    expect(await drifted()).toEqual([]);
  });

  it("folds a project's counter rows into one without changing a total", async () => {
    const stored = await counters();
    // Rows as concurrent writers leave them: several per project, here splitting amounts that cancel out.
    await sql`insert into project_activity_stats (project_id, search_sessions, search_result_count, search_duration_ms, chat_turns) values
      ('p-a1', 5, 12, 7, 2), ('p-a1', -5, -12, -7, -2), ('p-a1', 0, 0, 0, 0), ('p-b1', 3, 1, 0, 0), ('p-b1', -3, -1, 0, 0)`;
    expect(await counters()).toEqual(stored);
    const [{ removed }] = await sql<{ removed: string }[]>`select compact_project_activity_stats(array['p-a1', 'p-a1', 'no-such-project']) as removed`;
    expect(Number(removed)).toBe(3);
    expect(await counters()).toEqual(stored);
    const rows = async (projectId: string) => (await sql`select 1 from project_activity_stats where project_id = ${projectId}`).length;
    expect(await rows("p-a1")).toBe(1);
    expect(await rows("p-b1")).toBe(3); // not named, not touched
    // The maintenance sweep folds the projects it samples; nothing is left to fold on a second call.
    await driftService.sweepProjectActivityStatsDrift({ sql, force: true, sample: 100 });
    expect(await rows("p-b1")).toBe(1);
    expect(Number((await sql<{ removed: string }[]>`select compact_project_activity_stats(array['p-a1', 'p-b1']) as removed`)[0]!.removed)).toBe(0);
    await expectCountersMatchHistory();
    expect(await drifted()).toEqual([]);
  });

  it("is a plain invoker function that names every object by schema", async () => {
    const functions = await sql<{ proname: string; prosecdef: boolean; proconfig: string[] | null; prosrc: string }[]>`
      select proname, prosecdef, proconfig, prosrc from pg_proc
      where proname in ('rebuild_project_activity_stats', 'project_activity_stats_drift', 'project_activity_stats_add',
        'delete_project_activity_stats', 'compact_project_activity_stats')
      order by proname`;
    expect(functions).toHaveLength(5);
    for (const fn of functions) {
      expect(fn.prosecdef).toBe(false);
      expect(fn.proconfig).toEqual(["search_path=pg_catalog, pg_temp"]);
      // Every table reference is schema-qualified (search_path has no public).
      expect(fn.prosrc.replace(/public\.(project_activity_stats|search_sessions|chat_sessions|chat_turns|projects)\b/g, ""))
        .not.toMatch(/\b(from|join|into|update|table)\s+(project_activity_stats|search_sessions|chat_sessions|chat_turns|projects)\b/i);
    }
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

  /** Every error counts here: these scenarios must not abort anyone, deadlock victim or not. */
  const settle = async (work: Promise<unknown>) => await work.then(() => "ok", (error) => `${(error as { code?: string }).code ?? "?"} ${(error as Error).message}`);
  const single = () => postgres(raceDatabaseUrl!, { max: 1, prepare: false, onnotice: () => {} });
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const raceRows = async () => (await counters(pool)).filter((row) => row.project_id.startsWith("race-"));
  const raceHistory = async () => (await oracle(pool)).filter((row) => row.project_id.startsWith("race-"));
  const orphanRows = async () => await pool`
    select a.project_id from project_activity_stats a
    where a.project_id like 'race-%' and not exists (select 1 from projects w where w.id = a.project_id)`;

  it("never aborts a project delete or a write on that project's search sessions (deadlock 1)", async () => {
    const remover = single();
    const writer = single();
    try {
      // The writer holds session rows of the project (a statement in flight), the delete then takes the project row
      // and waits for those sessions in its cascade, and only then does the writer's counter write run. With a
      // foreign key from the counters to projects that write waited for the delete: a cycle, and 40P01 for one.
      const writes: Array<[name: string, write: (tx: postgres.TransactionSql) => Promise<unknown>]> = [
        ["expiry batch across two tenants' projects", (tx) => tx`delete from search_sessions where id in (
          select id from search_sessions where id like 'race-x-%' and expires_at < now() order by expires_at limit 2000 for update skip locked)`],
        ["offboarding delete", (tx) => tx`delete from search_sessions where user_id = 'race-u' and id like 'race-x-%'`],
        ["re-persist upsert", (tx) => tx`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
          values ('race-x-doomed-1', 'race-u', 'race-doomed', 'q', 4, '{"durationMs":9,"queryHash":"h"}')
          on conflict (id) do update set result_count = excluded.result_count, metadata = excluded.metadata`],
        ["move to another project", (tx) => tx`update search_sessions set project_id = 'race-p1' where id = 'race-x-doomed-1'`],
      ];
      for (const [name, write] of writes) {
        for (const existingCounterRow of [false, true]) {
          await pool`insert into projects (id, org_id, user_id, name) values ('race-doomed', 'race-o', 'race-u', 'Doomed')`;
          await pool`insert into search_sessions (id, user_id, project_id, query, result_count, metadata, expires_at)
            select 'race-x-doomed-' || g, 'race-u', 'race-doomed', 'q', g % 3, '{"durationMs":5,"queryHash":"h"}', now() - interval '1 hour' from generate_series(1, 5) g`;
          await pool`insert into search_sessions (id, user_id, project_id, query, result_count, metadata, expires_at)
            select 'race-x-other-' || g, 'race-u', 'race-p2', 'q', 1, '{"durationMs":5}', now() - interval '1 hour' from generate_series(1, 5) g
            on conflict (id) do nothing`;
          // Without a counter row the write has to insert one: the case that waited for the project row.
          if (!existingCounterRow) await pool`delete from project_activity_stats where project_id = 'race-doomed'`;
          const written = settle(writer.begin(async (tx) => {
            await tx`select 1 from search_sessions where id like 'race-x-%' order by id for update`;
            await pause(250);
            await write(tx);
          }));
          await pause(80);
          const removed = settle(remover`delete from projects where id = 'race-doomed'`);
          expect({ name, existingCounterRow, results: await Promise.all([written, removed]) })
            .toEqual({ name, existingCounterRow, results: ["ok", "ok"] });
          expect(await pool`select 1 from projects where id = 'race-doomed'`).toHaveLength(0);
          expect(await orphanRows()).toHaveLength(0);
          // The other tenant's project in the same batch kept exact counters.
          expect(await raceRows()).toEqual(await raceHistory());
          await pool`delete from search_sessions where id like 'race-x-%'`;
        }
      }
    } finally {
      await remover.end();
      await writer.end();
    }
  }, 120_000);

  it("keeps a project delete and writers of its sessions apart under load, with exact counters whoever wins", async () => {
    const strict: string[] = [];
    // A write into a project deleted meanwhile is refused by its own foreign key (23503); nothing else may fail.
    const run = async (work: () => Promise<unknown>) => {
      const result = await settle(work());
      if (result !== "ok" && !result.startsWith("23503")) strict.push(result);
    };
    for (let round = 0; round < 12; round += 1) {
      const project = `race-churn-${round}`;
      await pool`insert into projects (id, org_id, user_id, name) values (${project}, 'race-o', 'race-u', 'Churn')`;
      await pool`insert into search_sessions (id, user_id, project_id, query, result_count, metadata, expires_at)
        select ${project} || '-s' || g, 'race-u', ${project}, 'q', g % 4, '{"durationMs":11}', now() - interval '1 hour' from generate_series(1, 40) g`;
      await pool`insert into chat_sessions (id, project_id, user_id) select ${project} || '-c' || g, ${project}, 'race-u' from generate_series(1, 6) g`;
      const writers = Array.from({ length: 10 }, async (_, worker) => {
        for (let i = 0; i < 12; i += 1) {
          const id = `${project}-s${1 + ((worker * 7 + i) % 40)}`;
          const step = (worker + i) % 5;
          if (step === 0) {
            await run(() => pool.begin(async (tx) => {
              await tx`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
                values (${id}, 'race-u', ${project}, 'q', ${i % 5}, '{"durationMs":21}')
                on conflict (id) do update set result_count = excluded.result_count, metadata = excluded.metadata`;
              await tx`select 1`;
            }));
          } else if (step === 1) {
            await run(() => pool`delete from search_sessions where id in (
              select id from search_sessions where id like 'race-churn-%' and expires_at < now() order by expires_at limit 7 for update skip locked)`);
          } else if (step === 2) {
            await run(() => pool`update search_sessions set project_id = case when project_id = 'race-p2' then ${project} else 'race-p2' end where id = ${id}`);
          } else if (step === 3) {
            await run(() => pool`insert into chat_turns (id, session_id, role, content) values (${`${project}-t-${worker}-${i}`}, ${`${project}-c${1 + (i % 6)}`}, 'user', 'x')`);
          } else {
            await run(() => pool.begin(async (tx) => {
              await tx`delete from chat_sessions where id = ${`${project}-c${1 + (i % 6)}`}`;
              await tx`delete from search_sessions where id = ${id}`;
            }));
          }
        }
      });
      const removal = (async () => {
        await pause(5 + (round % 4) * 6);
        await run(() => pool`delete from projects where id = ${project}`);
      })();
      await Promise.all([...writers, removal]);
      expect(await pool`select 1 from projects where id = ${project}`).toHaveLength(0);
    }
    expect(strict).toEqual([]);
    expect(await orphanRows()).toHaveLength(0);
    expect(await raceRows()).toEqual(await raceHistory());
    await pool`delete from search_sessions where id like 'race-churn-%'`;
  }, 180_000);

  it("never aborts concurrent chat session deletes across the same projects, in any order (deadlock 2)", async () => {
    const first = single();
    const second = single();
    try {
      await pool`insert into "user" (id, name, email) values ('race-u2', 'Race 2', 'race2@activity.test') on conflict (id) do nothing`;
      const seed = async (tag: string) => {
        await pool`insert into chat_sessions (id, project_id, user_id)
          select ${tag} || '-' || u || '-' || p, 'race-p' || p, case when u = 1 then 'race-u' else 'race-u2' end
          from generate_series(1, 2) u, generate_series(1, 3) p`;
        await pool`insert into chat_turns (id, session_id, role, content)
          select cs.id || '-t' || g, cs.id, 'user', 'x' from chat_sessions cs, generate_series(1, 3) g where cs.id like ${tag + "-%"}`;
      };
      // Two transactions, one statement per session, over the same projects in opposite order: each holds a counter
      // row of the project the other needs next. One row per (project, slot) made this a cycle.
      await seed("race-dl");
      const order = async (client: postgres.Sql, user: number, projectOrder: number[]) => await settle(client.begin(async (tx) => {
        for (const project of projectOrder) {
          await tx`delete from chat_sessions where id = ${`race-dl-${user}-${project}`}`;
          await pause(120);
        }
      }));
      expect(await Promise.all([order(first, 1, [1, 2, 3]), order(second, 2, [3, 2, 1])])).toEqual(["ok", "ok"]);
      expect(await raceRows()).toEqual(await raceHistory());

      // Two account deletions in one organization (tenant offboarding): each removes one user's chat sessions and
      // then search sessions across every project in one transaction, repeatedly and at the same time.
      const failures: string[] = [];
      for (let round = 0; round < 15; round += 1) {
        await seed(`race-off-${round}`);
        await pool`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
          select 'race-off-' || ${round}::int || '-' || u || '-' || p, case when u = 1 then 'race-u' else 'race-u2' end, 'race-p' || p, 'q', p, '{"durationMs":4}'
          from generate_series(1, 2) u, generate_series(1, 3) p`;
        const offboard = async (client: postgres.Sql, user: string, direction: "asc" | "desc") => await settle(client.begin(async (tx) => {
          // Scan order differs between the two, as heap order does between two users' rows.
          await tx`delete from chat_sessions where id in (
            select id from chat_sessions where user_id = ${user} and id like 'race-off-%' order by ${direction === "asc" ? tx`project_id asc` : tx`project_id desc`})`;
          await tx`delete from search_sessions where user_id = ${user} and id like 'race-off-%'`;
        }));
        const results = await Promise.all([offboard(first, "race-u", "asc"), offboard(second, "race-u2", "desc")]);
        failures.push(...results.filter((result) => result !== "ok"));
      }
      expect(failures).toEqual([]);
      expect(await raceRows()).toEqual(await raceHistory());
    } finally {
      await first.end();
      await second.end();
      await pool`delete from "user" where id = 'race-u2'`;
    }
  }, 120_000);

  it("does not make a search wait for another one's commit, and loses nothing when a writer rolls back", async () => {
    const holder = single();
    try {
      const before = (await raceRows()).find((row) => row.project_id === "race-p3")!;
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let held!: () => void;
      const holding = new Promise<void>((resolve) => { held = resolve; });
      // An open transaction that has written race-p3's counters and stays open, then rolls back.
      const open = settle(holder.begin(async (tx) => {
        await tx`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
          select 'race-hold-' || g, 'race-u', 'race-p3', 'q', 2, '{"durationMs":50}' from generate_series(1, 3) g`;
        held();
        await released;
        throw new Error("roll back");
      }));
      await holding;
      // Searches in the same project commit while it is open: they write another counter row instead of waiting.
      const started = Date.now();
      for (let i = 0; i < 5; i += 1) {
        await pool`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
          values (${`race-free-${i}`}, 'race-u', 'race-p3', 'q', 1, '{"durationMs":8}')`;
      }
      // An update that changes no counted value takes no counter row at all.
      await pool`update search_sessions set variant = 'b' where id = 'race-free-0'`;
      expect(Date.now() - started).toBeLessThan(5_000);
      const [{ locked }] = await pool<{ locked: number }[]>`
        select count(*)::int as locked from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where l.locktype = 'transactionid' and not l.granted`;
      expect(locked).toBe(0);
      release();
      expect(await open).toMatch(/roll back/);
      const after = (await raceRows()).find((row) => row.project_id === "race-p3")!;
      expect(after.search_sessions).toBe(before.search_sessions + 5);
      expect(after.search_result_count).toBe(before.search_result_count + 5);
      expect(await raceRows()).toEqual(await raceHistory());
    } finally {
      await holder.end();
    }
  }, 60_000);

  it("folds counter rows while writers and project deletes keep arriving, exactly and without making anyone wait", async () => {
    let stop = false;
    const errors: string[] = [];
    await pool`insert into projects (id, org_id, user_id, name) select 'race-fold-' || g, 'race-o', 'race-u', 'Fold' from generate_series(1, 6) g`;
    const targets = ["race-p1", "race-p2", "race-p3", ...Array.from({ length: 6 }, (_, i) => `race-fold-${i + 1}`)];
    const writers = Array.from({ length: 10 }, async (_, worker) => {
      for (let i = 0; !stop && i < 500; i += 1) {
        const project = targets[(worker + i) % targets.length]!;
        const id = `race-f-${worker}-${i % 60}`;
        const result = await settle(pool.begin(async (tx) => {
          if ((worker + i) % 3 === 2) await tx`delete from search_sessions where id = ${id}`;
          else {
            await tx`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
              values (${id}, 'race-u', ${project}, 'q', ${i % 4}, '{"durationMs":6}')
              on conflict (id) do update set result_count = excluded.result_count + 1`;
          }
          await tx`select 1`;
        }));
        if (result !== "ok" && !result.startsWith("23503")) errors.push(result);
      }
    });
    const folder = (async () => {
      let removed = 0;
      for (let i = 0; i < 60; i += 1) {
        const [row] = await pool<{ removed: string }[]>`select compact_project_activity_stats(${targets}::text[]) as removed`;
        removed += Number(row!.removed);
        if (i % 10 === 5) {
          const result = await settle(pool`delete from projects where id = ${`race-fold-${1 + Math.floor(i / 10)}`}`);
          if (result !== "ok") errors.push(result);
        }
        await pause(15);
      }
      stop = true;
      return removed;
    })();
    const [removed] = await Promise.all([folder, ...writers]);
    expect(errors).toEqual([]);
    expect(removed).toBeGreaterThan(0);
    expect(await orphanRows()).toHaveLength(0);
    expect(await raceRows()).toEqual(await raceHistory());
    // Quiet now: one more pass leaves every project at one row.
    await pool`select compact_project_activity_stats(${targets}::text[])`;
    const [{ most }] = await pool<{ most: number }[]>`
      select coalesce(max(n), 0)::int as most from (select count(*) as n from project_activity_stats where project_id like 'race-%' group by project_id) c`;
    expect(most).toBe(1);
    expect(await raceRows()).toEqual(await raceHistory());
  }, 120_000);

  it("rebuilds exactly while writers keep arriving, and the drift check stays quiet under load", async () => {
    let stop = false;
    const errors: string[] = [];
    const writers = Array.from({ length: 6 }, async (_, worker) => {
      for (let i = 0; !stop && i < 400; i += 1) {
        const result = await settle(worker % 2 === 0
          ? pool`insert into search_sessions (id, user_id, project_id, query, result_count, metadata)
              values (${`race-r-${worker}-${i}`}, 'race-u', ${`race-p${1 + (i % 3)}`}, 'q', ${i % 3}, '{"durationMs":6}')`
          : pool`delete from search_sessions where id = ${`race-r-${worker - 1}-${i}`}`);
        if (result !== "ok") errors.push(result);
      }
    });
    const checks = (async () => {
      for (let i = 0; i < 6; i += 1) {
        // One statement, one snapshot: exact while the writers run.
        const drift = await pool`select project_id from project_activity_stats_drift() where project_id like 'race-%'`;
        if (drift.length > 0) errors.push(`drift reported under load: ${JSON.stringify(drift)}`);
        const result = await settle(pool.begin(async (tx) => {
          await tx`set local lock_timeout = '10s'`;
          await tx`select rebuild_project_activity_stats()`;
        }));
        if (result !== "ok") errors.push(result);
        await pause(20);
      }
      stop = true;
    })();
    await Promise.all([...writers, checks]);
    expect(errors).toEqual([]);
    expect(await raceRows()).toEqual(await raceHistory());
    expect(await pool`select project_id from project_activity_stats_drift() where project_id like 'race-%'`).toHaveLength(0);
  }, 120_000);
});
