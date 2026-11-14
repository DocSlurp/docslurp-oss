import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/** The boot warm-up's project list against a migrated Postgres, and its limits. LanceDB is not reached. */
const warm = vi.fn(async (_target: unknown) => {});
vi.mock("../search/lancedb.js", () => ({ warmLanceDbSearch: warm }));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let boot: typeof import("../search/boot-warm.js");
const P = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('user-a', 'A', 'a@bootwarm.test'), ('user-b', 'B', 'b@bootwarm.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents) values ('org-a', 'Org A', 'bw-a', 'user-a', 1000), ('org-b', 'Org B', 'bw-b', 'user-b', 1000)`;
  await sql`insert into projects (id, org_id, user_id, name, is_default) values
    (${P(1)}, 'org-a', 'user-a', 'Searched yesterday', true), (${P(2)}, 'org-b', 'user-b', 'Searched just now', true),
    (${P(3)}, 'org-a', 'user-a', 'Searched, no index', false), (${P(4)}, 'org-a', 'user-a', 'Searched long ago', false), (${P(5)}, 'org-b', 'user-b', 'Never searched', false)`;
  for (const [n, org, user] of [[1, "org-a", "user-a"], [2, "org-b", "user-b"], [3, "org-a", "user-a"], [4, "org-a", "user-a"], [5, "org-b", "user-b"]] as const) {
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values (${`run-${n}`}, ${org}, ${user}, ${P(n)}, 'bulk-upload', 'completed', 'completed', '{}')`;
    for (const d of [1, 2]) {
      await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status) values (${`doc-${n}-${d}`}, ${org}, ${user}, ${P(n)}, ${`run-${n}`}, 'a.txt', 'text/plain', ${`k-${n}-${d}`}, 'completed')`;
      if (n !== 3) await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension) values (${`vi-${n}-${d}`}, ${`doc-${n}-${d}`}, 'lancedb', 'b', 'p', 'BAAI/bge-m3', 1024)`;
    }
  }
  // A non-LanceDB row must not make project 3 look indexed.
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension) values ('vi-3-other', 'doc-3-1', 'pgvector', 'b', 'p', 'other', 8)`;
  const search = (id: string, user: string, project: string | null, age: string) =>
    sql`insert into search_sessions (id, user_id, project_id, query, created_at) values (${id}, ${user}, ${project}, 'q', now() - ${age}::interval)`;
  await search("s1", "user-a", P(1), "1 day");
  await search("s1b", "user-a", P(1), "3 days");
  await search("s2", "user-b", P(2), "1 minute");
  await search("s3", "user-a", P(3), "2 minutes");
  await search("s4", "user-a", P(4), "30 days");
  await search("s0", "user-a", null, "1 second");
  boot = await import("../search/boot-warm.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

it("lists recently searched projects that have a LanceDB index, newest first, each with its own org", async () => {
  expect(await boot.recentSearchTargets(10)).toEqual([
    { orgId: "org-b", projectId: P(2), embeddingModel: "BAAI/bge-m3", dimension: 1024 },
    { orgId: "org-a", projectId: P(1), embeddingModel: "BAAI/bge-m3", dimension: 1024 },
  ]);
  // The limit applies to searched projects, so an unindexed one may use a place.
  expect((await boot.recentSearchTargets(2)).map((target) => target.projectId)).toEqual([P(2)]);
  expect(await boot.recentSearchTargets(0)).toEqual([]);
});

it("warms them in order, survives a failing project, and does nothing when turned off", async () => {
  const lines: string[] = [];
  warm.mockImplementationOnce(async () => { throw new Error("storage down"); });
  expect((await boot.warmRecentSearchIndexes({ limit: 10, log: (line) => lines.push(line) })).projects).toBe(2);
  expect(warm.mock.calls.map(([target]) => target)).toEqual([
    { orgId: "org-b", projectId: P(2), embeddingModel: "BAAI/bge-m3", dimension: 1024, hydrate: true },
    { orgId: "org-a", projectId: P(1), embeddingModel: "BAAI/bge-m3", dimension: 1024, hydrate: true },
  ]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^\[search\] boot warm projects=2 limit=10 ms=\d+$/);
  warm.mockClear();
  expect(await boot.warmRecentSearchIndexes({ limit: 0, log: (line) => lines.push(line) })).toMatchObject({ projects: 0 });
  expect(warm).not.toHaveBeenCalled();
  expect(lines).toHaveLength(1);
  // A database that is down at boot is logged, not thrown.
  expect(await boot.warmRecentSearchIndexes({ limit: 3, targets: async () => { throw new Error("connection refused\nstack"); }, log: (line) => lines.push(line) })).toMatchObject({ projects: 0 });
  expect(lines[1]).toBe("[search] boot warm skipped: connection refused");
});

it("reads its limit from SEARCH_BOOT_WARM_PROJECTS", () => {
  expect(boot.bootWarmProjectLimit({})).toBe(5);
  expect(boot.bootWarmProjectLimit({ SEARCH_BOOT_WARM_PROJECTS: "0" })).toBe(0);
  expect(boot.bootWarmProjectLimit({ SEARCH_BOOT_WARM_PROJECTS: "12" })).toBe(12);
  expect(boot.bootWarmProjectLimit({ SEARCH_BOOT_WARM_PROJECTS: "500" })).toBe(50);
  expect(boot.bootWarmProjectLimit({ SEARCH_BOOT_WARM_PROJECTS: "-1" })).toBe(5);
  expect(boot.bootWarmProjectLimit({ SEARCH_BOOT_WARM_PROJECTS: "many" })).toBe(5);
  expect(boot.bootWarmProjectLimit({ SEARCH_BOOT_WARM_PROJECTS: "9", SEARCH_LANCE_WARM: "0" })).toBe(0);
});
