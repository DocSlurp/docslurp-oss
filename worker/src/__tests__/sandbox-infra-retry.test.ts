import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { Store } from "../db/store.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import type { Stage } from "../pipeline/pipeline.js";
import { createStageExecution } from "../pipeline/stage-execution.js";
import { SandboxInfrastructureError, SandboxOutputError } from "../sandbox/types.js";
import { noteSandboxInfrastructureError } from "../sandbox/session-context.js";
import { classifyActivityError } from "../temporal/failure-classification.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

// Real-Modal F5: the stage activity classified a sandbox infrastructure failure as ordinary, so the real failRunStage
// failed the document before Temporal retried, and the retry found nothing to do. Here the real store and the real
// activity classifier: an infrastructure failure leaves the document for the retry, which bills it once; exhausted
// retries fail it through failRun; a document's own staging violation fails only that document, once (recheck Q #1).
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
    delete from usage_events; delete from document_run_stage_states; delete from documents; delete from workspace_runs;
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com') on conflict do nothing;
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 1000000) on conflict do nothing;
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W') on conflict do nothing;
    delete from run_terminal_receipts;
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total, execution_generation)
      values ('r1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 2, 4, 'g1');
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('x', 'o1', 'u1', 'w', 'r1', 'x.pdf', 'application/pdf', 'k1', 'processing', 2),
             ('y', 'o1', 'u1', 'w', 'r1', 'y.pdf', 'application/pdf', 'k2', 'processing', 2);
  `);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** An extract stage: each document bills one vision call, then `failY(attempt)` decides what document y does. */
function extractStage(failY: (attempt: number) => Error | null, attempts: { n: number }): Stage {
  return {
    name: "extract",
    run: async (state) => {
      attempts.n += 1;
      for (const document of [...state.documents]) {
        await runDocumentStage(state, document, "extract", `${document.id}:extract`, "x", async () => {
          const failure = document.id === "y" ? failY(attempts.n) : null;
          if (failure) {
            // What the runner does with a command's sandbox failure (tools/runner.ts settleRemote).
            noteSandboxInfrastructureError(failure);
            throw failure;
          }
          state.usageLedger.record({ provider: "openrouter", model: "m", metric: "vision", inputTokens: 100, outputTokens: 10, costCents: 5, documentId: document.id } as never);
          return { stats: {} };
        });
      }
    },
  };
}

const runtime = (attempt: number) => ({
  signal: new AbortController().signal,
  heartbeat: () => {},
  attempt,
  classifyError: (error: unknown) => classifyActivityError(error, { shuttingDown: () => false }),
});
const input = { stageName: "extract", runId: "r1", totalStages: 1, artifacts: {}, executionGeneration: "g1" };
const config = { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config;
const settle = (p: Promise<unknown>) => p.then(() => null, (error: unknown) => error);

async function documentStages(): Promise<Record<string, string>> {
  const { rows } = await db.query<{ document_id: string; status: string }>(`select document_id, status from document_run_stage_states where run_id = 'r1' order by 1`);
  return Object.fromEntries(rows.map((row) => [row.document_id, row.status]));
}
async function visionEvents(): Promise<number> {
  return (await db.query<{ n: number }>(`select count(*)::int as n from usage_events where run_id = 'r1' and metric = 'vision'`)).rows[0]!.n;
}
async function run(): Promise<{ status: string; failure_count: number }> {
  return (await db.query<{ status: string; failure_count: number }>(`select status, coalesce(failure_count, 0)::int as failure_count from workspace_runs where id = 'r1'`)).rows[0]!;
}

describe("sandbox infrastructure failures retry the stage without failing the document (real-Modal F5)", () => {
  it("attempt 1's VM refusal leaves the document pending; attempt 2 completes it and bills once", async () => {
    const attempts = { n: 0 };
    const execution = createStageExecution({ store, stages: [extractStage((n) => (n === 1 ? new SandboxInfrastructureError("modal sandbox creation failed: parser VM kernel link protections could not be turned on") : null), attempts)], config });

    const first = await settle(execution.runStage(input, runtime(1)));
    expect((first as Error).name).toBe("SandboxInfrastructureError");
    expect(classifyActivityError(first, { shuttingDown: () => false })).toBe("interruption");
    expect((await documentStages()).y).not.toBe("failed");
    expect(await run()).toEqual({ status: "processing", failure_count: 0 });

    expect(await settle(execution.runStage(input, runtime(2)))).toBeNull();
    expect(await documentStages()).toEqual({ x: "completed", y: "completed" });
    expect(await visionEvents()).toBe(2); // x on attempt 1, y on attempt 2: each billed once
  });

  it("exhausted retries fail the document cleanly (the workflow's failPipelineRun)", async () => {
    const attempts = { n: 0 };
    const execution = createStageExecution({ store, stages: [extractStage(() => new SandboxInfrastructureError("parser VM leftover processes could not be killed; VM terminated"), attempts)], config });
    // Within the strike limit (SANDBOX_INFRASTRUCTURE_RETRIES): each attempt is an infrastructure retry.
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect((await settle(execution.runStage(input, runtime(attempt))) as Error).name).toBe("SandboxInfrastructureError");
      expect((await documentStages()).y).not.toBe("failed");
    }
    // Temporal gives up (STAGE_THROTTLED_ATTEMPTS); the workflow records the failure.
    await execution.failRun({ runId: "r1", executionGeneration: "g1", stage: "extract", message: "parser VM leftover processes could not be killed; VM terminated" });
    expect((await run()).status).toBe("failed");
    const documents = (await db.query<{ id: string; status: string }>(`select id, status from documents where run_id = 'r1' order by id`)).rows;
    expect(documents.find((row) => row.id === "y")?.status).toBe("failed");
    expect(await visionEvents()).toBe(1); // only x ran; nothing billed twice
  });

  it("a document that breaks a fresh VM on every attempt fails at the strike limit; the other document completes (recheck S #2)", async () => {
    const attempts = { n: 0 };
    const execution = createStageExecution({ store, stages: [extractStage(() => new SandboxInfrastructureError("modal sandbox command failed: control deadline exceeded"), attempts)], config });
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect((await settle(execution.runStage(input, runtime(attempt))) as Error).name).toBe("SandboxInfrastructureError");
    }
    // The third strike on a fresh VM is the document's: it fails, the stage completes, the run goes on.
    expect(await settle(execution.runStage(input, runtime(3)))).toBeNull();
    expect(await documentStages()).toEqual({ x: "completed", y: "failed" });
    const { rows: [row] } = await db.query<{ strikes: number; error: string }>(`select (stats->>'sandboxInfrastructureStrikes')::int as strikes, error from document_run_stage_states where document_id = 'y'`);
    expect(row!.error).toMatch(/failed under this document on 3 fresh VMs/);
    await execution.completeRun({ runId: "r1", executionGeneration: "g1" });
    expect((await run()).status).toBe("completed");
    expect(await visionEvents()).toBe(1); // x once; y never billed
  });

  it("a document's own staging violation fails only that document, once; the other completes (recheck Q #1)", async () => {
    const attempts = { n: 0 };
    const execution = createStageExecution({ store, stages: [extractStage(() => new SandboxOutputError("parser VM output entry/depth limit exceeded"), attempts)], config });
    expect(await settle(execution.runStage(input, runtime(1)))).toBeNull();
    expect(attempts.n).toBe(1);
    expect(await documentStages()).toEqual({ x: "completed", y: "failed" });
    expect(await run()).toEqual({ status: "processing", failure_count: 0 });
    await execution.completeRun({ runId: "r1", executionGeneration: "g1" });
    expect((await run()).status).toBe("completed");
  });
});
