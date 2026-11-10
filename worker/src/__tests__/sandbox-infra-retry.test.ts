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
    delete from usage_events; delete from document_run_stage_states; delete from documents; delete from project_runs;
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com') on conflict do nothing;
    insert into organizations(id, name, slug, created_by_user_id, worker_slots, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 8, 1000000) on conflict do nothing;
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W') on conflict do nothing;
    delete from run_terminal_receipts;
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total, execution_generation)
      values ('r1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 2, 4, 'g1');
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
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
  return (await db.query<{ status: string; failure_count: number }>(`select status, coalesce(failure_count, 0)::int as failure_count from project_runs where id = 'r1'`)).rows[0]!;
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
    await execution.failRun({ runId: "r1", executionGeneration: "g1", stage: "extract", message: "parser VM leftover processes could not be killed; VM terminated", failureType: "WorkerInterrupted" });
    expect((await run()).status).toBe("failed");
    const documents = (await db.query<{ id: string; status: string }>(`select id, status from documents where run_id = 'r1' order by id`)).rows;
    expect(documents.find((row) => row.id === "y")?.status).toBe("failed");
    expect(await visionEvents()).toBe(1); // only x ran; nothing billed twice
    // Real-Modal P3: the document carries a public reason; the raw error never reaches the public copy.
    const { classifyIngestFailure } = await import("@docslurp/shared");
    const { rows: [stage] } = await db.query<{ error: string }>(`select error from document_run_stage_states where document_id = 'y'`);
    expect(stage!.error).toMatch(/^Infrastructure retries exhausted: /);
    const reason = classifyIngestFailure(stage!.error, "failed");
    expect(reason.reason).toBe("infrastructure-retries-exhausted");
    expect(reason.message).not.toMatch(/leftover|VM terminated/);
    expect(reason.retryable).toBe(true);
  });

  it("a document that breaks a fresh VM on every attempt fails at the strike limit; the other document completes (recheck S #2)", async () => {
    const attempts = { n: 0 };
    const execution = createStageExecution({ store, stages: [extractStage(() => new SandboxInfrastructureError("modal sandbox command failed: control deadline exceeded", undefined, { afterCommand: true }), attempts)], config });
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

  it("a Modal outage across more attempts than the strike limit fails no document; the run resumes when Modal returns (council U #4)", async () => {
    const attempts = { n: 0 };
    // Session open, VM creation and API errors before the document's command ran: no strike, however many attempts.
    const outage = (n: number) => (n <= 4 ? new SandboxInfrastructureError("modal sandbox creation failed: service unavailable") : null);
    const execution = createStageExecution({ store, stages: [extractStage(outage, attempts)], config });
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect((await settle(execution.runStage(input, runtime(attempt))) as Error).name).toBe("SandboxInfrastructureError");
      expect((await documentStages()).y).not.toBe("failed");
    }
    const { rows: [row] } = await db.query<{ strikes: number | null }>(`select (stats->>'sandboxInfrastructureStrikes')::int as strikes from document_run_stage_states where document_id = 'y'`);
    expect(row?.strikes ?? 0).toBe(0);
    expect(await settle(execution.runStage(input, runtime(5)))).toBeNull();
    expect(await documentStages()).toEqual({ x: "completed", y: "completed" });
    await execution.completeRun({ runId: "r1", executionGeneration: "g1" });
    expect((await run()).status).toBe("completed");
    expect(await visionEvents()).toBe(2);
  });

  it("a document whose own input staging keeps failing for lack of space reaches the strike limit (council W #2)", async () => {
    const attempts = { n: 0 };
    // An earlier no-strike error in the same stage (a Modal API hiccup) must not hide the later strike.
    const execution = createStageExecution({ store, stages: [{
      name: "extract",
      run: async (state) => {
        attempts.n += 1;
        for (const document of [...state.documents]) {
          await runDocumentStage(state, document, "extract", `${document.id}:extract`, "x", async () => {
            if (document.id === "y") {
              noteSandboxInfrastructureError(new SandboxInfrastructureError("modal sandbox command failed: stream reset by peer"));
              const failure = new SandboxInfrastructureError("modal sandbox command failed: ENOSPC: no space left on device", undefined, { afterCommand: true });
              noteSandboxInfrastructureError(failure);
              throw failure;
            }
            return { stats: {} };
          });
        }
      },
    }], config });
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect((await settle(execution.runStage(input, runtime(attempt))) as Error).name).toBe("SandboxInfrastructureError");
    }
    expect(await settle(execution.runStage(input, runtime(3)))).toBeNull();
    expect(await documentStages()).toEqual({ x: "completed", y: "failed" });
  });

  it("a document that leaves the job tree unusable takes the strikes, not the next document; it fails at the limit (council W #2)", async () => {
    // x's stage started earlier in this run (its command broke the tree); y inherits the VM.
    await db.query(`insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, stats) values ('r1', 'x', 'extract', 'processing', 1, '{}')`);
    const attempts = { n: 0 };
    const execution = createStageExecution({ store, stages: [{
      name: "extract",
      run: async (state) => {
        attempts.n += 1;
        for (const document of [...state.documents].reverse()) {
          await runDocumentStage(state, document, "extract", `${document.id}:extract`, "x", async () => {
            if (document.id === "y" && attempts.n <= 3) {
              const failure = new SandboxInfrastructureError("modal sandbox job tree left unusable by an earlier command: mkdir exited 1; VM terminated", undefined, { blameDocumentId: "x" });
              noteSandboxInfrastructureError(failure);
              throw failure;
            }
            return { stats: {} };
          });
        }
      },
    }], config });
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await settle(execution.runStage(input, runtime(attempt))) as Error).name).toBe("SandboxInfrastructureError");
    }
    const strikes = async (id: string) => (await db.query<{ n: number | null }>(`select (stats->>'sandboxInfrastructureStrikes')::int as n from document_run_stage_states where document_id = $1`, [id])).rows[0]?.n ?? 0;
    expect(await strikes("x")).toBe(3);
    expect(await strikes("y")).toBe(0);
    // Next attempt: y runs on a fresh VM and completes; x, over the limit, fails without running.
    expect(await settle(execution.runStage(input, runtime(4)))).toBeNull();
    expect(await documentStages()).toEqual({ x: "failed", y: "completed" });
  });

  it("a blamed strike lands on the blamed document's own latest stage row; with no row it is logged, not struck (council X #1)", async () => {
    // x last ran 'ocr' in this run (after an earlier 'extract'); y's failure blames x, then a document with no row.
    await db.query(`insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, stats, started_at) values
      ('r1', 'x', 'extract', 'completed', 1, '{}', now() - interval '2 minutes'), ('r1', 'x', 'ocr', 'processing', 1, '{}', now() - interval '1 minute')`);
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    let blame = "x";
    const execution = createStageExecution({ store, stages: [{
      name: "extract",
      run: async (state) => {
        for (const document of [...state.documents].filter((d) => d.id === "y")) {
          await runDocumentStage(state, document, "extract", `${document.id}:extract`, "x", async () => {
            const failure = new SandboxInfrastructureError("modal sandbox job tree left unusable by an earlier command", undefined, { blameDocumentId: blame });
            noteSandboxInfrastructureError(failure);
            throw failure;
          });
        }
      },
    }], config });
    await settle(execution.runStage(input, runtime(1)));
    const strikes = async (stage: string) => (await db.query<{ n: number | null }>(`select (stats->>'sandboxInfrastructureStrikes')::int as n from document_run_stage_states where document_id = 'x' and stage_name = $1`, [stage])).rows[0]?.n ?? 0;
    expect(await strikes("ocr")).toBe(1);
    expect(await strikes("extract")).toBe(0);
    blame = "ghost";
    await settle(execution.runStage(input, runtime(2)));
    expect(warn.mock.calls.some((call) => /document=ghost .*blamed sandbox strike not recorded: no stage row/.test(String(call[0])))).toBe(true);
    const { rows: [y] } = await db.query<{ n: number | null }>(`select (stats->>'sandboxInfrastructureStrikes')::int as n from document_run_stage_states where document_id = 'y'`);
    expect(y?.n ?? 0).toBe(0);
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
