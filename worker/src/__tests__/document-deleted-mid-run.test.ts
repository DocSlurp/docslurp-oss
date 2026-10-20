import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Store } from "../db/store.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { createStageExecution, loadRunState } from "../pipeline/stage-execution.js";
import type { Config } from "../config.js";
import type { Stage } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Reproduces what the existing (full-mode) pipeline does when DELETE /v1/documents/:id removes a
 * document row while its run is still processing. The app hard-deletes the row (cascade), so the
 * worker's in-memory state still holds a document the database no longer has.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    delete from usage_events; delete from workspace_runs; delete from documents;
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x') on conflict do nothing;
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1') on conflict do nothing;
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W') on conflict do nothing;
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('r1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 2, 4);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('keep', 'o1', 'u1', 'w', 'r1', 'a.pdf', 'application/pdf', 'k1', 'processing', 2),
             ('gone', 'o1', 'u1', 'w', 'r1', 'b.pdf', 'application/pdf', 'k2', 'processing', 2);
  `);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const outcome = async (p: Promise<unknown>) => p.then(() => "ok", (error: Error) => `${(error as { code?: string }).code ?? ""} ${error.message}`.trim());

describe("document deleted while its run is processing (full pipeline)", () => {
  it("fails the attempt with a foreign-key error when the row vanishes before the document stage starts (retry heals)", async () => {
    const state = await loadRunState(store, "r1");
    await db.exec(`delete from documents where id = 'gone'`);
    const gone = state.documents.find((d) => d.id === "gone")!;
    const result = await outcome(runDocumentStage(state, gone, "extract", "gone:extract", "x", async () => ({ stats: {} })));
    // Known limit: the stage fails with an FK error and Temporal's retry reloads the run without the document.
    expect(result).toMatch(/^23503 .*document_run_stage_states/);
  });

  it("keeps the AI usage already incurred when the document is deleted during the stage", async () => {
    const state = await loadRunState(store, "r1");
    const gone = state.documents.find((d) => d.id === "gone")!;
    let runs = 0;
    const result = await outcome(runDocumentStage(state, gone, "extract", "gone:extract", "x", async () => {
      runs += 1;
      state.usageLedger.record({ provider: "openrouter", model: "m", metric: "vision", inputTokens: 100, outputTokens: 10, costCents: 5 } as never);
      state.pendingPerformance.push({ scope: "document", documentId: "gone", stageName: "extract", metric: "x", value: 1, unit: "ms", tags: [] } as never);
      await db.exec(`delete from documents where id = 'gone'`);
      return { stats: {} };
    }));
    expect(result).toBe("ok");
    expect(runs).toBe(1);
    const billed = await db.query<{ n: number }>(`select count(*)::int as n from usage_events where run_id = 'r1'`);
    expect(billed.rows[0]!.n).toBe(1);
    expect(state.usageLedger.pendingCount).toBe(0);
  });

  it("bills the deleted document's AI usage, completes the stage, and a retry runs without the document", async () => {
    let deletions = 0;
    const stage: Stage = {
      name: "extract",
      run: async (state) => {
        for (const document of [...state.documents]) {
          await runDocumentStage(state, document, "extract", `${document.id}:extract`, "x", async () => {
            state.usageLedger.record({ provider: "openrouter", model: "m", metric: "vision", inputTokens: 100, outputTokens: 10, costCents: 5 } as never);
            state.pendingPerformance.push({ scope: "document", documentId: document.id, stageName: "extract", metric: "x", value: 1, unit: "ms", tags: [] } as never);
            if (document.id === "gone" && deletions === 0) {
              deletions += 1;
              await db.exec(`delete from documents where id = 'gone'`);
            }
            return { stats: {} };
          });
        }
      },
    };
    const execution = createStageExecution({ store, stages: [stage], config: { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config });
    const runtime = (attempt: number) => ({ signal: new AbortController().signal, heartbeat: () => {}, attempt });
    const input = { stageName: "extract", runId: "r1", totalStages: 1, artifacts: {} };

    const first = await outcome(execution.runStage(input, runtime(1)));
    const afterFirst = (await db.query<{ status: string; failure_count: number }>(`select status, coalesce(failure_count, 0)::int as failure_count from workspace_runs where id = 'r1'`)).rows[0]!;
    const usageAfterFirst = (await db.query<{ n: number }>(`select count(*)::int as n from usage_events where run_id = 'r1'`)).rows[0]!.n;
    expect(first).toBe("ok");
    expect(afterFirst).toEqual({ status: "processing", failure_count: 0 });
    // Both documents' vision calls were billed, including the one for the document deleted mid-stage.
    expect((await db.query<{ n: number }>(`select count(*)::int as n from usage_events where run_id = 'r1' and metric = 'vision'`)).rows[0]!.n).toBe(2);
    expect(usageAfterFirst).toBeGreaterThanOrEqual(2);

    const second = await outcome(execution.runStage(input, runtime(2)));
    const usageAfterSecond = (await db.query<{ n: number }>(`select count(*)::int as n from usage_events where run_id = 'r1' and metric = 'vision'`)).rows[0]!.n;
    const stages = (await db.query<{ document_id: string; status: string }>(`select document_id, status from document_run_stage_states where run_id = 'r1'`)).rows;
    expect(second).toBe("ok");
    expect(usageAfterSecond).toBe(2);
    expect(stages).toEqual([{ document_id: "keep", status: "completed" }]);
  });
});

describe("missing-document classifier", () => {
  it("matches document foreign keys only, not run or other FKs", async () => {
    const { isMissingDocumentError } = await import("../db/missing-document.js");
    expect(isMissingDocumentError({ code: "23503", constraint_name: "performance_log_document_id_fkey" })).toBe(true);
    expect(isMissingDocumentError({ code: "23503", constraint_name: "document_run_stage_states_run_id_fkey" })).toBe(false);
    expect(isMissingDocumentError({ code: "23503", constraint_name: "documents_run_id_fkey" })).toBe(false);
    expect(isMissingDocumentError({ code: "23505", constraint_name: "x_document_id_fkey" })).toBe(false);
    // A real missing run (not document) violation from the database.
    const state = await loadRunState(store, "r1");
    const doc = state.documents[0]!;
    await db.exec(`delete from workspace_runs where id = 'r1'`).catch(() => {});
    const err = await db.query(`insert into document_run_stage_states (run_id, document_id, stage_name, status) values ('nope', '${doc.id}', 's', 'processing')`).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(isMissingDocumentError(err)).toBe(false);
  });
});
