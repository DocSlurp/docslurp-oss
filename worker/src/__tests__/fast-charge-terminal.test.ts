import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { BILLABLE_UNIT_METRICS, UNIT_CHARGE_PROVIDER, unitChargeMetadata } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { fastPagesDue } from "../db/page-base-fee.js";
import { Store } from "../db/store.js";
import { persistRunUsageEvents } from "../db/usage-event-store.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * The Fast charge of a run's documents is written by the terminal transaction of each execution generation (completeRun and
 * failRun) as a delta over what the run's earlier Fast charges covered. A document that completed is billed exactly once
 * however its run ends (completed, completed with failures then retried, cancelled, failed then resumed); a document that never
 * completed bills nothing.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let url: string;
const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

type Doc = { id: string; pages: number; status: string; failedStage?: boolean; source?: string };

async function seedRun(runId: string, docs: Doc[], options: { org?: string; generation?: string; control?: string } = {}) {
  const org = options.org ?? "o1";
  const project = org === "o1" ? "w" : "w2";
  await db.query(
    `insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, execution_generation, control_state, monthly_reservation_cents)
     values ($1, $2, 'u1', $3, 'upload', 'processing', 'embed', '{}', $4, $5, $6, 1)`,
    [runId, org, project, docs.length, options.generation ?? "g1", options.control ?? null],
  );
  for (const doc of docs) {
    await db.query(
      `insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source)
       values ($1, $2, 'u1', $3, $4, $5, 'application/pdf', $6, $7, $8, $9)`,
      [doc.id, org, project, runId, `${doc.id}.pdf`, `raw/${doc.id}`, doc.status, doc.pages, doc.source ?? "counted"],
    );
    if (doc.failedStage) {
      await db.query(`insert into document_run_stage_states (run_id, document_id, stage_name, status, error) values ($1, $2, 'extract-markdown', 'failed', 'parser exited 1')`, [runId, doc.id]);
    }
  }
}

/** What the server's retry does (run-lifecycle resumeCompletedWithFailures / resumeFailed): a new generation, failed documents queued. */
async function resume(runId: string, generation: string) {
  await db.query(`delete from document_run_stage_states where run_id = $1 and status <> 'completed'`, [runId]);
  await db.query(`update documents set status = 'queued' where run_id = $1 and status not in ('completed', 'cancelled')`, [runId]);
  await db.query(`update project_runs set status = 'processing', control_state = null, execution_generation = $2 where id = $1`, [runId, generation]);
}

async function fastCharges(runId: string) {
  const { rows } = await db.query<{ id: string; amount: string; org_id: string }>(
    `select id, amount::text, org_id from usage_events where run_id = $1 and metric = $2 order by created_at, id`, [runId, BILLABLE_UNIT_METRICS.fastPage]);
  return rows.map((row) => ({ id: row.id, pages: Number(row.amount), org: row.org_id }));
}
const totalFast = async (runId: string) => (await fastCharges(runId)).reduce((sum, row) => sum + row.pages, 0);

async function debits(runId: string) {
  const { rows } = await db.query<{ org_id: string; credits: string }>(`select org_id, sum(credits)::text as credits from credit_debits_pending where run_id = $1 group by org_id`, [runId]);
  return rows.map((row) => ({ org: row.org_id, credits: Number(row.credits) }));
}

// The socket server serves one client at a time, so each phase opens and closes its own pool.
async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const store = new Store(url, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}
const owner = (runId: string, generation: string, org = "o1") => ({ runId, orgId: org, projectId: org === "o1" ? "w" : "w2", executionGeneration: generation });
const complete = (runId: string, generation: string, org?: string) =>
  withStore(async (store) => store.completeRun(await loadRunState(store, runId), owner(runId, generation, org)));
const fail = (runId: string, generation: string, org?: string) =>
  withStore(async (store) => store.failRun(runId, "embed", "workflow cancelled", owner(runId, generation, org), { state: await loadRunState(store, runId) }));

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 100000);
    insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o2', 'Broke', 'broke', 'u1', 0);
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into projects(id, org_id, user_id, name) values ('w2', 'o2', 'u1', 'W2');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  url = `postgres://postgres@127.0.0.1:${served.port}/postgres`;
}, 120_000);

afterAll(async () => {
  await server?.stop();
  await db?.close();
});

describe("fastPagesDue", () => {
  it("charges what is owed beyond earlier charges, never a refund", () => {
    expect(fastPagesDue(5, 3)).toBe(2);
    expect(fastPagesDue(3, 5)).toBe(0);
    expect(fastPagesDue(4, 0)).toBe(4);
    expect(fastPagesDue(4, -2)).toBe(4);
  });
});

describe("Fast pages are billed once per completed document, however the run ends", () => {
  it("a completed run retried for its failed documents bills the retried pages once (H1)", { timeout: 60_000 }, async () => {
    await seedRun("retry", [{ id: "retry-a", pages: 3, status: "processing" }, { id: "retry-b", pages: 2, status: "failed", failedStage: true }]);
    await complete("retry", "g1");
    expect(await fastCharges("retry")).toEqual([{ id: "fast:retry", pages: 3, org: "o1" }]);

    await resume("retry", "g2");
    await complete("retry", "g2");
    // The acknowledgement was lost: the same generation completes again and adds nothing.
    await complete("retry", "g2");
    expect(await fastCharges("retry")).toEqual([{ id: "fast:retry", pages: 3, org: "o1" }, { id: "fast:retry:g:g2", pages: 2, org: "o1" }]);
    // A stale worker of the first generation is refused and charges nothing.
    await expect(complete("retry", "g1")).rejects.toThrow("ownership");
    expect(await totalFast("retry")).toBe(5);
    const [reported] = (await db.query<{ p: Record<string, number> }>(`select stats -> 'pageCharges' as p from project_runs where id = 'retry'`)).rows;
    expect(reported!.p).toMatchObject({ fastPages: 2, fastPagesOwed: 5, fastPagesCharged: 3 });
    expect((await debits("retry")).map((row) => row.org)).toEqual(["o1"]);
  });

  it("a cancel after documents are indexed bills the completed ones; a resume bills the rest once (H2)", { timeout: 60_000 }, async () => {
    await seedRun("cancel", [
      { id: "cancel-a", pages: 3, status: "completed" },
      { id: "cancel-b", pages: 2, status: "processing" },
      { id: "cancel-c", pages: 1, status: "queued" },
    ], { control: "cancel_requested" });
    await fail("cancel", "g1");
    await fail("cancel", "g1");
    expect(await fastCharges("cancel")).toEqual([{ id: "fast:cancel", pages: 3, org: "o1" }]);
    expect((await db.query(`select status, control_state from project_runs where id = 'cancel'`)).rows).toEqual([{ status: "failed", control_state: "cancelled" }]);
    // The documents that never completed bill nothing and are left to a resume.
    expect((await db.query(`select id, status from documents where run_id = 'cancel' order by id`)).rows)
      .toEqual([{ id: "cancel-a", status: "completed" }, { id: "cancel-b", status: "queued" }, { id: "cancel-c", status: "queued" }]);

    await resume("cancel", "g2");
    await complete("cancel", "g2");
    expect(await fastCharges("cancel")).toEqual([{ id: "fast:cancel", pages: 3, org: "o1" }, { id: "fast:cancel:g:g2", pages: 3, org: "o1" }]);
    expect(await totalFast("cancel")).toBe(6);
  });

  it("a completion racing a cancel of the same generation charges once, whichever commits first", { timeout: 60_000 }, async () => {
    await seedRun("race", [{ id: "race-a", pages: 2, status: "completed" }, { id: "race-b", pages: 2, status: "processing" }]);
    await complete("race", "g1");
    await fail("race", "g1");
    expect(await fastCharges("race")).toEqual([{ id: "fast:race", pages: 4, org: "o1" }]);

    await seedRun("race2", [{ id: "race2-a", pages: 2, status: "completed" }, { id: "race2-b", pages: 2, status: "processing" }], { control: "cancel_requested" });
    await fail("race2", "g1");
    // The terminal receipt of the generation exists: the completion is a no-op, it neither completes the run nor charges.
    await complete("race2", "g1");
    expect((await db.query(`select status from project_runs where id = 'race2'`)).rows).toEqual([{ status: "failed" }]);
    expect(await fastCharges("race2")).toEqual([{ id: "fast:race2", pages: 2, org: "o1" }]);
  });

  it("a failed generation that completed nothing writes no charge, and the run's first charge is still fast:<run>", { timeout: 60_000 }, async () => {
    await seedRun("nothing", [{ id: "nothing-a", pages: 2, status: "processing" }]);
    await fail("nothing", "g1");
    expect(await fastCharges("nothing")).toEqual([]);
    await resume("nothing", "g2");
    await complete("nothing", "g2");
    expect(await fastCharges("nothing")).toEqual([{ id: "fast:nothing", pages: 2, org: "o1" }]);
  });

  it("a cancelled run whose organization cannot cover its indexed pages records the debt on its own organization", { timeout: 60_000 }, async () => {
    await seedRun("broke", [{ id: "broke-a", pages: 4, status: "completed" }, { id: "broke-b", pages: 1, status: "processing" }], { org: "o2", control: "cancel_requested" });
    await fail("broke", "g1", "o2");
    expect(await fastCharges("broke")).toEqual([{ id: "fast:broke", pages: 4, org: "o2" }]);
    const owed = await debits("broke");
    expect(owed).toHaveLength(1);
    expect(owed[0]!.org).toBe("o2");
    expect(owed[0]!.credits).toBeGreaterThan(0);
    // Nothing of it lands on another organization.
    expect((await db.query(`select 1 from usage_events where run_id = 'broke' and org_id <> 'o2'`)).rows).toHaveLength(0);
  });

  it("a document whose page count is still an intake estimate bills nothing, and is logged and counted", { timeout: 60_000 }, async () => {
    warn.mockClear();
    await seedRun("estimate", [{ id: "estimate-a", pages: 2, status: "processing" }, { id: "estimate-b", pages: 9, status: "processing", source: "assumed" }]);
    await complete("estimate", "g1");
    expect(await fastCharges("estimate")).toEqual([{ id: "fast:estimate", pages: 2, org: "o1" }]);
    const [reported] = (await db.query<{ p: Record<string, number> }>(`select stats -> 'pageCharges' as p from project_runs where id = 'estimate'`)).rows;
    expect(reported!.p).toMatchObject({ fastPages: 2, unmeasuredDocuments: 1 });
    expect(warn.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringMatching(/run=estimate unmeasured-documents=1 billed-pages=0 documents=estimate-b/));
  });
});

describe("runs billed under the single fast:<run> id", () => {
  /** The charges an earlier release wrote at its one completion of the run. */
  async function legacyCharges(runId: string, charges: Array<{ id: string; metric: string; pages: number }>) {
    await withStore(async (store) => {
      const state = await loadRunState(store, runId);
      await persistRunUsageEvents({ client: (store as unknown as { sql: Parameters<typeof persistRunUsageEvents>[0]["client"] }).sql, state, usageEvents: charges.map((charge) => ({
        id: charge.id, provider: UNIT_CHARGE_PROVIDER, model: "price-card", metric: charge.metric, amount: charge.pages, unit: "page", costCents: charge.pages,
        metadata: unitChargeMetadata({ pages: charge.pages, ...(charge.metric === BILLABLE_UNIT_METRICS.fastPage ? { pageRules: 2 } : { readBy: "scan-or-image" }) }),
      })) });
    });
  }

  it("a run an earlier release completed and billed is retried after the deploy: only the retried pages bill", { timeout: 60_000 }, async () => {
    // The earlier release billed the completed 4-page document 3 Fast and 1 Rich (its scan rule), and the failed one nothing.
    await seedRun("legacy", [{ id: "legacy-a", pages: 4, status: "completed" }, { id: "legacy-b", pages: 2, status: "failed", failedStage: true }]);
    await db.query(`update project_runs set status = 'completed' where id = 'legacy'`);
    await legacyCharges("legacy", [
      { id: "fast:legacy", metric: BILLABLE_UNIT_METRICS.fastPage, pages: 3 },
      { id: "rich-scan:legacy", metric: BILLABLE_UNIT_METRICS.richPage, pages: 1 },
    ]);
    await resume("legacy", "g2");
    await complete("legacy", "g2");
    expect(await fastCharges("legacy")).toEqual([{ id: "fast:legacy", pages: 3, org: "o1" }, { id: "fast:legacy:g:g2", pages: 2, org: "o1" }]);
  });

  it("a run in flight across the deploy completes on a new worker under the same fast:<run> id", { timeout: 60_000 }, async () => {
    await seedRun("inflight", [{ id: "inflight-a", pages: 3, status: "processing" }], { generation: "g1" });
    await complete("inflight", "g1");
    expect(await fastCharges("inflight")).toEqual([{ id: "fast:inflight", pages: 3, org: "o1" }]);
  });

  it("mixed fleet: an older worker completing a run a newer worker charged first adds nothing", { timeout: 60_000 }, async () => {
    await seedRun("mixed", [{ id: "mixed-a", pages: 3, status: "processing" }, { id: "mixed-b", pages: 2, status: "failed", failedStage: true }]);
    await complete("mixed", "g1");
    await resume("mixed", "g2");
    // The older worker completes the retried generation: it writes its one fixed id, covering every page, which conflicts.
    await legacyCharges("mixed", [{ id: "fast:mixed", metric: BILLABLE_UNIT_METRICS.fastPage, pages: 5 }]);
    expect(await fastCharges("mixed")).toEqual([{ id: "fast:mixed", pages: 3, org: "o1" }]);
    // A newer worker that then completes the generation bills only the pages no earlier charge covered.
    await complete("mixed", "g2");
    expect(await totalFast("mixed")).toBe(5);
  });
});
