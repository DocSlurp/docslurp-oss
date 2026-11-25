import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { compilePipelinePlan, PARSE_SOURCE_SCAN_VERSION } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { applyRemainingMigrations, createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * The run's progress columns (migration run_progress_fields): pages_searchable counts pages of documents that finished
 * indexing, pages_counted_at says the page total is final. Both ride on checkpoints the run already writes.
 */
const MIGRATION = "run_progress_fields";
const COUNTING_STAGES = ["format-detect", "split-pages", "extract-markdown", "extract-html", "vision-extract"];

type Served = { db: PGlite; server: PGLiteSocketServer; url: string };

async function serve(db: PGlite): Promise<Served> {
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 100000);
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
  `);
  const served = await serveOnRandomPort(db);
  return { db, server: served.server, url: `postgres://postgres@127.0.0.1:${served.port}/postgres` };
}

/** A processing run whose documents are `[id suffix, pages, status]`; pages_total is their sum unless given. */
async function seedRun(db: PGlite, runId: string, documents: Array<[string, number, string?]>, pagesTotal?: number) {
  const total = pagesTotal ?? documents.reduce((sum, [, pages]) => sum + pages, 0);
  await db.exec(`
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total, execution_generation, monthly_reservation_cents)
      values ('${runId}', 'o1', 'u1', 'w', 'upload', 'processing', 'index', '{}', ${documents.length}, ${total}, null, 1);
  `);
  for (const [index, [suffix, pages, status]] of documents.entries()) {
    await db.exec(`
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source,
          parse_source_scan_version, parse_source_sha256, created_at)
        values ('${runId}-${suffix}', 'o1', 'u1', 'w', '${runId}', '${suffix}.pdf', 'application/pdf', '${runId}/${suffix}', '${status ?? "processing"}', ${pages}, 'counted',
          ${PARSE_SOURCE_SCAN_VERSION}, '${"a".repeat(64)}', timestamptz '2026-01-01' + interval '${index} minutes');
    `);
  }
}

// The socket server serves one client at a time, so each phase opens and closes its own pool.
async function withStore<T>(url: string, fn: (store: Store) => Promise<T>): Promise<T> {
  const store = new Store(url, 60_000, { poolMax: 1 });
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

async function progress(db: PGlite, runId: string) {
  const { rows } = await db.query<{ pages_searchable: string | number | null; pages_counted_at: Date | string | null; pages_processed: string | number }>(
    "select pages_searchable, pages_counted_at, pages_processed from project_runs where id = $1", [runId]);
  const row = rows[0]!;
  return {
    searchable: row.pages_searchable === null ? null : Number(row.pages_searchable),
    countedAt: row.pages_counted_at === null ? null : new Date(row.pages_counted_at).toISOString(),
    processed: Number(row.pages_processed),
  };
}

const indexDocument = (state: WorkflowState, suffix: string) => {
  const document = state.documents.find((entry) => entry.id === `${state.run.id}-${suffix}`)!;
  return runDocumentStage(state, document, "index", `${document.id}:index`, "indexed", async () => ({ artifactUri: `s3://bucket/${document.id}`, stats: {} }));
};

describe("run progress columns", () => {
  let served: Served;

  beforeAll(async () => {
    served = await serve(await createMigratedDatabase());
  }, 120_000);

  afterAll(async () => {
    await served?.server.stop();
    await served?.db.close();
  });

  it("reports nothing until a release that tracks the columns writes the run", async () => {
    await seedRun(served.db, "fresh", [["a", 3]]);
    expect(await progress(served.db, "fresh")).toMatchObject({ searchable: null, countedAt: null });
    await withStore(served.url, async (store) => {
      const state = await loadRunState(store, "fresh");
      expect(state.run.pagesSearchable).toBeNull();
      await store.updateProgress(state);
    });
    // The first checkpoint starts the count at what is indexed: nothing yet.
    expect(await progress(served.db, "fresh")).toMatchObject({ searchable: 0, countedAt: null });
  });

  it("adds a document's pages when its index checkpoint completes, once", async () => {
    await seedRun(served.db, "index", [["a", 10], ["b", 5], ["c", 15]]);
    await withStore(served.url, async (store) => {
      const state = await loadRunState(store, "index");
      await store.updateProgress(state);

      await indexDocument(state, "a");
      await store.updateProgress(state);
      expect(state.pendingSearchablePages).toBe(0);
      expect(await progress(served.db, "index")).toMatchObject({ searchable: 10 });

      await indexDocument(state, "b");
      await store.updateProgress(state);
      expect(await progress(served.db, "index")).toMatchObject({ searchable: 15 });

      // A completed checkpoint is skipped: its pages were counted when it completed.
      await indexDocument(state, "b");
      expect(state.pendingSearchablePages).toBe(0);
      await store.updateProgress(state);
      expect(await progress(served.db, "index")).toMatchObject({ searchable: 15 });
    });
    // Extraction progress is a separate counter and keeps its meaning.
    expect((await progress(served.db, "index")).processed).toBe(0);

    // A later activity loads the row's value and does not count the indexed documents again.
    await withStore(served.url, async (store) => {
      const state = await loadRunState(store, "index");
      expect(state.run.pagesSearchable).toBe(15);
      await indexDocument(state, "a");
      await store.updateProgress(state);
    });
    expect(await progress(served.db, "index")).toMatchObject({ searchable: 15 });
  });

  it("starts a run adopted mid-way from what is already indexed", async () => {
    await seedRun(served.db, "adopted", [["a", 4], ["b", 6], ["c", 2]]);
    // Indexed by a release that did not report: the row is still null.
    await served.db.exec(`insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts)
      values ('adopted', 'adopted-a', 'index', 'completed', 1), ('adopted', 'adopted-b', 'index', 'completed', 1),
             ('adopted', 'adopted-b', 'embed', 'completed', 1), ('adopted', 'adopted-c', 'index', 'processing', 1)`);
    await withStore(served.url, async (store) => store.updateProgress(await loadRunState(store, "adopted")));
    expect(await progress(served.db, "adopted")).toMatchObject({ searchable: 10 });
  });

  it("adds up shards that each started from the same snapshot, and never passes the page total", async () => {
    await seedRun(served.db, "shards", [["a", 7], ["b", 8], ["c", 5]]);
    await withStore(served.url, async (store) => {
      await store.updateProgress(await loadRunState(store, "shards"));
      const shard = async (suffix: string, pages: number) => {
        const state = WorkflowState.create(await store.loadRun("shards"), []);
        state.stage = "index";
        state.beginShard([`shards-${suffix}`]);
        state.pendingSearchablePages = pages;
        return state;
      };
      const [a, b] = [await shard("a", 7), await shard("b", 8)];
      await store.updateProgress(a);
      await store.finishShard(b);
      expect(await progress(served.db, "shards")).toMatchObject({ searchable: 15 });
      // A failed checkpoint keeps its pages pending; a committed one drains them.
      expect([a.pendingSearchablePages, b.pendingSearchablePages]).toEqual([0, 0]);

      const over = await shard("c", 500);
      await store.finishShard(over);
      expect(await progress(served.db, "shards")).toMatchObject({ searchable: 20 });
    });
  });

  it("stamps the page total as final at the boundary of the last page-counting stage", async () => {
    await seedRun(served.db, "counted", [["a", 3]]);
    await withStore(served.url, async (store) => {
      const state = await loadRunState(store, "counted");
      const order = compilePipelinePlan(state.run.pipeline).stageOrder as string[];
      const counting = order.filter((stage) => COUNTING_STAGES.includes(stage));
      expect(counting.length).toBeGreaterThan(1);
      const last = counting.at(-1)!;
      for (const stage of order.slice(0, order.indexOf(last))) {
        await store.startRunStage(state, stage);
        await store.completeRunStage(state, stage, "", {});
      }
      // Mid-stage checkpoints and earlier boundaries leave the total provisional.
      await store.updateProgress(state);
      expect((await progress(served.db, "counted")).countedAt).toBeNull();

      await store.startRunStage(state, last);
      await store.completeRunStage(state, last, "", {});
      const stamped = (await progress(served.db, "counted")).countedAt;
      expect(stamped).not.toBeNull();

      // Stamped once: later boundaries keep the first time.
      const next = order[order.indexOf(last) + 1]!;
      await store.startRunStage(state, next);
      await store.completeRunStage(state, next, "", {});
      expect((await progress(served.db, "counted")).countedAt).toBe(stamped);
    });
  });

  it("settles both columns exactly when the run completes", async () => {
    // One document failed: its pages are in the total and never searchable.
    await seedRun(served.db, "done", [["a", 4], ["b", 6], ["bad", 5, "failed"]]);
    await withStore(served.url, async (store) => {
      const state = await loadRunState(store, "done");
      // Lost before a checkpoint (a worker that stopped): the terminal write does not depend on the pending count.
      state.pendingSearchablePages = 0;
      await store.completeRun(state);
    });
    const settled = await progress(served.db, "done");
    expect(settled).toMatchObject({ searchable: 10, processed: 15 });
    expect(settled.countedAt).not.toBeNull();
  });
});

describe("run progress columns on a database that predates them", () => {
  let served: Served;

  beforeAll(async () => {
    served = await serve(await createMigratedDatabase({ stopBefore: MIGRATION }));
  }, 120_000);

  afterAll(async () => {
    await served?.server.stop();
    await served?.db.close();
  });

  it("checkpoints and completes runs without naming the columns, then adopts them once migrated", async () => {
    await seedRun(served.db, "old", [["a", 2]]);
    await seedRun(served.db, "old-done", [["a", 2]]);
    await withStore(served.url, async (store) => {
      const state = await loadRunState(store, "old");
      expect(state.run.pagesSearchable).toBeUndefined();
      await indexDocument(state, "a");
      await store.updateProgress(state);
      await store.completeRun(await loadRunState(store, "old-done"));
    });
    expect((await served.db.query("select status from project_runs where id = 'old-done'")).rows).toEqual([{ status: "completed" }]);

    // Applied while the run is live; statements of the previous release (no new column named) keep working.
    await applyRemainingMigrations(served.db, MIGRATION);
    await served.db.exec("update project_runs set pages_processed = 1, updated_at = now() where id = 'old'");
    await seedRun(served.db, "old-shape", [["a", 1]]);
    expect(await progress(served.db, "old-shape")).toMatchObject({ searchable: null, countedAt: null });
    // Runs finished before the migration stay unreported rather than reading as zero searchable pages.
    expect(await progress(served.db, "old-done")).toMatchObject({ searchable: null, countedAt: null });

    await withStore(served.url, async (store) => store.updateProgress(await loadRunState(store, "old")));
    expect(await progress(served.db, "old")).toMatchObject({ searchable: 2 });
  });
});
