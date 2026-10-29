import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Store } from "../db/store.js";
import { persistRunUsageEvents } from "../db/usage-event-store.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import type { UsageEvent, WorkspaceRun } from "../models.js";

/** Store.visionRunSpend: committed vision spend per run for the vision guard (lib/vision-spend-guard.ts). */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

function runState(id: string, orgId: string, workspaceId: string): WorkflowState {
  return WorkflowState.create({ id, orgId, workspaceId, userId: "u1", artifacts: {}, stats: {}, pipeline: {} } as unknown as WorkspaceRun, []);
}

function visionEvent(metric: string, outcome: string, pageNumber: number, providerCostCents: number, documentId = "d1"): UsageEvent {
  return {
    provider: "openrouter", model: "google/gemini-3.1-flash-lite", metric, amount: 1, unit: metric === "page-analysis" ? "page" : "attempt",
    costCents: providerCostCents, inputTokens: 100, outputTokens: 10,
    metadata: { outcome, documentId, pageNumber, ...(outcome === "rejected" ? { billable: false } : {}) },
  };
}

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'One', 'one', 'u1'), ('o2', 'Two', 'two', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'W2');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, artifacts) values
      ('r1', 'o1', 'u1', 'w1', 'upload', 'processing', 'vision-extract', '{}', '{}'),
      ('r2', 'o2', 'u1', 'w2', 'upload', 'processing', 'vision-extract', '{}', '{}');
    insert into documents(id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count) values
      ('d1', 'o1', 'u1', 'w1', 'r1', 'a.pdf', 'application/pdf', 'k1', 'processing', 20),
      ('d9', 'o2', 'u1', 'w2', 'r2', 'b.pdf', 'application/pdf', 'k9', 'processing', 2);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  const url = `postgres://postgres@127.0.0.1:${served.port}/postgres`;
  store = new Store(url, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

describe("Store.visionRunSpend", () => {
  it("counts provider cost of every vision attempt, billable or not, scoped to the run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const r1 = runState("r1", "o1", "w1");
    const r2 = runState("r2", "o2", "w2");
    await persistRunUsageEvents({ client: (store as unknown as { sql: never }).sql, state: r1, usageEvents: [
      visionEvent("page-analysis", "completed", 1, 0.4),
      visionEvent("page-analysis-attempt", "rejected", 2, 1.5),
      visionEvent("page-analysis-attempt", "rejected", 3, 1.25),
      // Two calls on one page count one page.
      visionEvent("page-analysis-attempt", "rejected", 3, 1.25),
      // Not vision usage.
      { ...visionEvent("embedding", "completed", 1, 9), metric: "embedding" },
    ] });
    // Another tenant's run: never counted for r1.
    await persistRunUsageEvents({ client: (store as unknown as { sql: never }).sql, state: r2, usageEvents: [
      visionEvent("page-analysis-attempt", "rejected", 1, 50),
    ] });
    log.mockRestore();
    // Rejected attempts persist at 0 credits; their provider cost lives in metadata.
    expect((await db.query(`select count(*)::int as n from usage_events where run_id = 'r1' and metric = 'page-analysis-attempt' and cost_cents = 0`)).rows)
      .toEqual([{ n: 3 }]);

    const spend = await store.visionRunSpend("r1");
    expect(spend.providerCostCents).toBeCloseTo(0.4 + 1.5 + 1.25 + 1.25, 6);
    expect(spend).toMatchObject({ attemptedPages: 3, rejectedPages: 2, inFlightPages: 0 });
    expect(await store.visionRunSpend("r2")).toMatchObject({ providerCostCents: 50, attemptedPages: 1, rejectedPages: 1 });
    expect(await store.visionRunSpend("missing")).toEqual({ providerCostCents: 0, attemptedPages: 0, rejectedPages: 0, inFlightPages: 0 });
  }, 60_000);

  it("counts other live page tasks as in flight, not the caller's own or expired leases", async () => {
    await db.exec(`
      insert into page_work_tasks (run_id, document_id, page_number, status, lease_expires_at) values
        ('r1', 'd1', 10, 'processing', now() + interval '3 minutes'),
        ('r1', 'd1', 11, 'processing', now() + interval '3 minutes'),
        ('r1', 'd1', 12, 'processing', now() - interval '1 minute'),
        ('r1', 'd1', 13, 'completed', null),
        ('r2', 'd9', 1, 'processing', now() + interval '3 minutes');
    `);
    expect((await store.visionRunSpend("r1")).inFlightPages).toBe(2);
    expect((await store.visionRunSpend("r1", { documentId: "d1", pageNumber: 10 })).inFlightPages).toBe(1);
  }, 60_000);
});
