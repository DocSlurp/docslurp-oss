import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { startMigratedPostgres } from "../test/migrated-postgres.js";

/**
 * Run milestone stamps (migration 0183, pipeline/run-milestones.ts): the conditional update is what makes a milestone
 * exactly-once across workers, retries and resumes, so only the first caller gets a duration to record.
 */
let stop: () => Promise<void>;
let db: PGlite;
let store: Store;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  db = pg.db;
  // PGlite serves one connection: the store holds it, and the test reads through the database handle.
  store = new Store(pg.url, 60_000, { poolMax: 1 });
  await db.exec(`
    insert into "user"(id, name, email) values ('u', 'U', 'u@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('org', 'O', 'o', 'u');
    insert into projects(id, org_id, user_id, name, is_default) values ('proj', 'org', 'u', 'P', true);
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, pages_total, created_at) values
      ('run', 'org', 'u', 'proj', 'upload', 'completed', 'completed', '{}', 40, now() - interval '90 seconds'),
      ('run-other', 'org', 'u', 'proj', 'upload', 'completed', 'completed', '{}', 0, now());
  `);
}, 180_000);

afterAll(async () => {
  await store?.close();
  await stop?.();
});

type Stamps = { first_page_extracted_at: Date | null; worker_started_at: Date | null; first_page_completed_at: Date | null };
async function stamps(runId: string): Promise<Stamps> {
  const result = await db.query<Stamps>(
    "select first_page_extracted_at, worker_started_at, first_page_completed_at from project_runs where id = $1", [runId]);
  return result.rows[0]!;
}

describe("markRunMilestone", () => {
  it("stamps once, measures from run acceptance and leaves other runs and milestones alone", async () => {
    const first = await store.markRunMilestone("run", "first_page_extracted");
    expect(first?.pages).toBe(40);
    expect(first!.seconds).toBeGreaterThanOrEqual(89);
    expect(first!.seconds).toBeLessThan(200);

    const stamped = await stamps("run");
    expect(await store.markRunMilestone("run", "first_page_extracted")).toBeNull();
    const again = await stamps("run");
    expect(again.first_page_extracted_at!.getTime()).toBe(stamped.first_page_extracted_at!.getTime());
    expect(again.worker_started_at).toBeNull();
    expect(again.first_page_completed_at).toBeNull();
    expect((await stamps("run-other")).first_page_extracted_at).toBeNull();
  });

  it("gives exactly one of several concurrent callers the stamp", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => store.markRunMilestone("run", "worker_started")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("returns null for a run that does not exist", async () => {
    expect(await store.markRunMilestone("missing", "first_page_completed")).toBeNull();
  });
});
