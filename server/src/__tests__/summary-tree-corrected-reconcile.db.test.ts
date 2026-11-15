import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The reconcile for corrected documents that lack the `corrected` mark on their summary tree state
 * (services/summary-tree-withdrawal.ts `sweepCorrectedSummaryTrees`), against a migrated Postgres: a correction
 * reindex completed by a server instance that predates the withdrawal leaves a document whose tree would be kept, or
 * built, from the text the correction replaced.
 */

let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let withdrawal: typeof import("../services/summary-tree-withdrawal.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  withdrawal = await import("../services/summary-tree-withdrawal.js");
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'reconcile-a@example.com'), ('u2', 'B', 'reconcile-b@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'reconcile-org', 'u1'), ('o2', 'Other', 'reconcile-other', 'u2')`;
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

async function seedDocument(id: string, org: "o1" | "o2", options: { corrected?: "completed" | "requested"; tree?: "ready" | "corrected" | null } = {}) {
  const user = org === "o1" ? "u1" : "u2";
  const project = org === "o1" ? "w" : "x";
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status)
    values (${id}, ${org}, ${user}, ${project}, ${`run-${project}`}, ${`${id}.pdf`}, 'application/pdf', ${`k-${id}`}, 'completed')`;
  if (options.corrected) {
    await sql`insert into document_corrections (id, document_id, run_id, user_id, corrected_markdown, reindex_requested_at, reindex_completed_at)
      values (${`c-${id}`}, ${id}, ${`run-${project}`}, ${user}, 'Corrected text', now(), ${options.corrected === "completed" ? sql`now()` : null})`;
  }
  if (options.tree === "ready") {
    await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, embedding_model, dimension, node_count, built_at, build_generation)
      values (${id}, ${org}, ${project}, ${`run-${project}`}, 'ready', 'model/x', 4, 2, now(), 3)`;
    for (const n of [1, 2]) {
      await sql`insert into document_summary_tree_nodes (id, document_id, org_id, project_id, run_id, node_hash, level, status, chunk_start, chunk_end)
        values (${`${id}:n${n}`}, ${id}, ${org}, ${project}, ${`run-${project}`}, ${`h${n}`}, 1, 'ready', ${n * 4}, ${n * 4 + 3})`;
    }
  } else if (options.tree === "corrected") {
    await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, skip_reason)
      values (${id}, ${org}, ${project}, ${`run-${project}`}, 'skipped', 'corrected')`;
  }
}

const states = async () => Object.fromEntries((await sql<Array<{ document_id: string; status: string; skip_reason: string | null }>>`
  select document_id, status, skip_reason from document_summary_trees order by document_id`).map((row) => [row.document_id, `${row.status}/${row.skip_reason ?? "-"}`]));
const queued = async () => await sql<Array<{ target: string; org_id: string; reason: string; generation: number | null }>>`
  select target, org_id, reason, (payload ->> 'generation')::int as generation from storage_cleanup_queue where kind = 'summary_tree_document' order by target`;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  withdrawal.resetCorrectedSummaryTreeReconcileForTests();
  await sql`delete from storage_cleanup_queue`;
  await sql`delete from projects`;
  for (const [id, org, user] of [["w", "o1", "u1"], ["x", "o2", "u2"]] as const) {
    await sql`insert into projects(id, org_id, user_id, name, slug) values (${id}, ${org}, ${user}, ${id}, ${`reconcile-${id}`})`;
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
      values (${`run-${id}`}, ${org}, ${user}, ${id}, 'bulk-upload', 'completed', 'completed', '{}')`;
  }
});

describe("corrected documents without the mark", () => {
  it("marks them, removes their registry rows and queues strict removal, each under its own organization", async () => {
    // A correction completed by an instance that did not withdraw the tree: the tree is still served.
    await seedDocument("served", "o1", { corrected: "completed", tree: "ready" });
    // The same, for a document that had no tree yet: a build must not start from the earlier text.
    await seedDocument("no-tree", "o1", { corrected: "completed" });
    await seedDocument("other-org", "o2", { corrected: "completed", tree: "ready" });
    // Not this pass's business: already marked, a correction whose reindex has not completed, and an uncorrected document.
    await seedDocument("marked", "o1", { corrected: "completed", tree: "corrected" });
    await seedDocument("pending", "o1", { corrected: "requested", tree: "ready" });
    await seedDocument("plain", "o1", { tree: "ready" });

    expect(await withdrawal.sweepCorrectedSummaryTrees()).toBe(3);
    expect(await states()).toEqual({
      marked: "skipped/corrected", "no-tree": "skipped/corrected", "other-org": "skipped/corrected",
      pending: "ready/-", plain: "ready/-", served: "skipped/corrected",
    });
    expect((await sql`select document_id from document_summary_tree_nodes order by id`).map((row) => row.document_id))
      .toEqual(["pending", "pending", "plain", "plain"]);
    // The removal carries each document's own tenant and the build generation it was asked at.
    expect(await queued()).toEqual([
      { target: "o1|w|no-tree", org_id: "o1", reason: "document_corrected", generation: 0 },
      { target: "o1|w|served", org_id: "o1", reason: "document_corrected", generation: 3 },
      { target: "o2|x|other-org", org_id: "o2", reason: "document_corrected", generation: 3 },
    ]);
    expect((await sql`select built_at, root_node_id, node_count from document_summary_trees where document_id = 'served'`)[0])
      .toEqual({ built_at: null, root_node_id: null, node_count: 0 });
  });

  it("is idempotent, works in batches, and looks again only later once nothing is left", async () => {
    for (const id of ["a", "b", "c"]) await seedDocument(id, "o1", { corrected: "completed", tree: "ready" });
    expect(await withdrawal.sweepCorrectedSummaryTrees({ limit: 2 })).toBe(2);
    expect(await withdrawal.sweepCorrectedSummaryTrees({ limit: 2 })).toBe(1);
    expect(await queued()).toHaveLength(3);
    // A second pass over the same documents marks nothing and queues nothing new.
    await sql`delete from storage_cleanup_queue`;
    expect(await withdrawal.sweepCorrectedSummaryTrees({ limit: 2 })).toBe(0);
    expect(await queued()).toEqual([]);
    // After an empty pass the process does not ask every minute ...
    await seedDocument("late", "o1", { corrected: "completed", tree: "ready" });
    expect(await withdrawal.sweepCorrectedSummaryTrees()).toBe(0);
    expect((await states()).late).toBe("ready/-");
    // ... but does again after its idle interval: a correction completed late by an older instance is still caught.
    expect(await withdrawal.sweepCorrectedSummaryTrees({ now: Date.now() + 11 * 60_000 })).toBe(1);
    expect((await states()).late).toBe("skipped/corrected");
  });
});
