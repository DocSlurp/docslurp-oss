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
/** The embedding space a search of a project with the default pipeline uses. */
let space: { model: string; dimensions: number };
const target = (org: string, n: number) => ({ orgId: org, projectId: P(n), embeddingModel: space.model, dimension: space.dimensions });

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  const shared = await import("@docslurp/shared");
  space = shared.resolveEmbeddingRoute(shared.normalizeStoredPipelineFeatures(null, "test").embedding);
  await sql`insert into "user" (id, name, email) values ('user-a', 'A', 'a@bootwarm.test'), ('user-b', 'B', 'b@bootwarm.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, credit_balance_cents) values ('org-a', 'Org A', 'bw-a', 'user-a', 1000), ('org-b', 'Org B', 'bw-b', 'user-b', 1000)`;
  // [project, org, searches, age of the newest search, index rows: current space | old space only | none]
  const projects = [
    [1, "org-a", 2, "1 day", "current"], [2, "org-b", 1, "1 minute", "current"], [3, "org-a", 1, "2 minutes", "none"],
    [4, "org-a", 9, "30 days", "current"], [5, "org-b", 0, "", "current"], [6, "org-a", 3, "1 hour", "old"],
    [7, "org-a", 5, "2 hours", "current"], [8, "org-a", 1, "3 minutes", "current"], [9, "org-b", 4, "1 hour", "current"],
  ] as const;
  for (const [n, org, searches, age, index] of projects) {
    const user = org === "org-a" ? "user-a" : "user-b";
    await sql`insert into projects (id, org_id, user_id, name, is_default, archived_at) values (${P(n)}, ${org}, ${user}, ${`Project ${n}`}, ${n <= 2}, ${n === 9 ? new Date().toISOString() : null})`;
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values (${`run-${n}`}, ${org}, ${user}, ${P(n)}, 'bulk-upload', 'completed', 'completed', '{}')`;
    // The first document is superseded work in progress and must not count as an index.
    for (const [d, status] of [[1, "failed"], [2, "completed"]] as const) {
      await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status) values (${`doc-${n}-${d}`}, ${org}, ${user}, ${P(n)}, ${`run-${n}`}, 'a.txt', 'text/plain', ${`k-${n}-${d}`}, ${status})`;
      const row = (id: string, backend: string, model: string, dimension: number) =>
        sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension) values (${id}, ${`doc-${n}-${d}`}, ${backend}, 'b', 'p', ${model}, ${dimension})`;
      if (index === "current" || (index === "none" && d === 1)) await row(`vi-${n}-${d}`, "lancedb", space.model, space.dimensions);
      if (index === "old" || n === 1) await row(`vi-${n}-${d}-old`, "lancedb", "old/model", 384);
      if (index === "none") await row(`vi-${n}-${d}-pg`, "pgvector", space.model, space.dimensions);
    }
    for (let k = 0; k < searches; k++) {
      await sql`insert into search_sessions (id, user_id, project_id, query, created_at) values (${`s-${n}-${k}`}, ${user}, ${P(n)}, 'q', now() - ${age}::interval - make_interval(secs => ${k}))`;
    }
  }
  await sql`insert into search_sessions (id, user_id, project_id, query) values ('s-none', 'user-a', null, 'q')`;
  boot = await import("../search/boot-warm.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

it("picks the most searched indexed projects in the space search uses, capped per organization, busiest last", async () => {
  // By searches: 7 (5), 6 (3: only an old model's table), 1 (2), then 2, 3 (no completed index), 8 (org-a is full).
  // 4 was searched long ago, 5 never, 9 is archived.
  expect(await boot.recentSearchTargets(10)).toEqual([target("org-b", 2), target("org-a", 1), target("org-a", 7)]);
  expect(await boot.recentSearchTargets(1)).toEqual([target("org-a", 7)]);
  expect(await boot.recentSearchTargets(2)).toEqual([target("org-a", 1), target("org-a", 7)]);
  expect(await boot.recentSearchTargets(0)).toEqual([]);
});

it("warms them in order, survives a failing project, and does nothing when turned off", async () => {
  const lines: string[] = [];
  warm.mockImplementationOnce(async () => { throw new Error("storage down"); });
  expect((await boot.warmRecentSearchIndexes({ limit: 10, log: (line) => lines.push(line) })).projects).toBe(3);
  expect(warm.mock.calls.map(([warmed]) => warmed)).toEqual([target("org-b", 2), target("org-a", 1), target("org-a", 7)].map((entry) => ({ ...entry, hydrate: true })));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^\[search\] boot warm projects=3 limit=10 ms=\d+$/);
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
