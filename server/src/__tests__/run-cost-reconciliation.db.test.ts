import { defaultPipelineFeatures } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Every surface reports one run cost, read from usage_attribution. The
 * time-to-searchable baseline caught the run record (workspace_runs cost
 * columns: AI only, 0.195 c) and Temporal's tally (stage compute only,
 * 0.74 c) disagreeing with each other and with the ledger (0.94 c). The
 * deprecated run-row accumulator (input_cost_cents) is seeded here with a
 * deliberately wrong figure: no surface may show it, and the run cost cap
 * reads spent_cents, which the usage_events trigger keeps equal to the
 * billed ledger total.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let runs: typeof import("../services/runs.js");
let workspaces: typeof import("../services/workspaces.js");
let documents: typeof import("../services/documents.js");
let forensics: typeof import("../services/run-forensics.js");

const RUN_CAP_ACCUMULATOR_CENTS = 0.195;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  // One connection (the PGlite socket serves one at a time), with the app client's numeric parsing (src/api/db.ts).
  sql = postgres(pg.url, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/temporal.js")>()),
    // A Temporal tally that disagrees with the ledger, as the baseline's did.
    getPipelineTemporalSnapshot: vi.fn(async (runId: string) => ({
      workflowId: `run-${runId}`, workflowRunId: "exec", workflowStatus: "COMPLETED", stage: null, stageIndex: null,
      totalStages: 13, historyLength: 236, historySizeBytes: 1, startTime: null, executionTime: null, closeTime: null,
      elapsedMs: null, activityUsageTally: { inputTokens: 0, outputTokens: 0, costCents: 0.7434 },
      queriedAt: "2026-10-14T00:00:00.000Z",
    })),
  }));
  vi.doMock("../services/workspace-naming.js", () => ({ refineWorkspaceNames: async () => {} }));
  // Viewer payloads mint request-bound file URLs; there is no request here.
  vi.doMock("../lib/file-urls.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/file-urls.js")>()),
    fileUrlForArtifact: (uri: string) => ({ url: `/files/${encodeURIComponent(uri)}`, expiresAt: "2099-01-01T00:00:00.000Z" }),
  }));
  runs = await import("../services/runs.js");
  workspaces = await import("../services/workspaces.js");
  documents = await import("../services/documents.js");
  forensics = await import("../services/run-forensics.js");

  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x'), ('u2', 'B', 'b@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1'), ('o2', 'Other', 'other', 'u2')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner'), ('o2', 'u2', 'owner')`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W'), ('w2', 'o2', 'u2', 'Other')`;
  await sql`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents,
      processed_documents, pages_total, pages_processed, input_cost_cents)
    values ('r1', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'completed',
      ${sql.json(defaultPipelineFeatures as unknown as postgres.JSONValue)}, 2, 2, 20, 20, ${RUN_CAP_ACCUMULATOR_CENTS})
  `;
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count) values
      ('d1', 'o1', 'u1', 'w', 'r1', 'a.pdf', 'application/pdf', 'raw/a', 'completed', 10),
      ('d2', 'o1', 'u1', 'w', 'r1', 'b.pdf', 'application/pdf', 'raw/b', 'completed', 10)
  `;
  // As the worker persists them: per-document AI events from two embed shards,
  // a vision page event, a page fee, billed and unbilled stage compute (the
  // latter at 0 c with its estimate in metadata), and a retried stage group
  // whose failed attempt already checkpointed its call.
  const event = (id: string, fields: Record<string, unknown>) => ({
    id, user_id: "u1", run_id: "r1", org_id: "o1", workspace_id: "w", document_id: null, provider: "openrouter",
    model: "m", metric: "llm", amount: 0, unit: "token", input_tokens: 0, output_tokens: 0, cost_cents: 0,
    metadata: { runId: "r1" }, ...fields,
  });
  const rows = [
    event("vision-1", { document_id: "d1", metric: "page-analysis", model: "google/gemini-3.1-flash-lite", input_tokens: 1150, output_tokens: 520, cost_cents: 0.128529 }),
    event("preamble-1", { document_id: "d1", metric: "contextual-chunk-preamble", input_tokens: 2100, output_tokens: 96, cost_cents: 0.019508, metadata: { runId: "r1", shard: 0 } }),
    event("preamble-2", { document_id: "d2", metric: "contextual-chunk-preamble", input_tokens: 2117, output_tokens: 96, cost_cents: 0.019509, metadata: { runId: "r1", shard: 1 } }),
    event("embed-1", { document_id: "d1", metric: "embedding-tokens", provider: "transformers.js", input_tokens: 6700, metadata: { runId: "r1", shard: 0 } }),
    event("embed-2", { document_id: "d2", metric: "embedding-tokens", provider: "openai", input_tokens: 6800, cost_cents: 0.0136, metadata: { runId: "r1", shard: 1 } }),
    event("fee", { metric: "page-base-fee", provider: "docslurp", model: "page-base-fee", unit: "page", amount: 20, cost_cents: 0.2 }),
    event("compute-billed", { metric: "worker-stage", provider: "local-compute", unit: "cent", amount: 0.74, cost_cents: 0.7434044,
      metadata: { runId: "r1", stage: "embed", billable: true, costRollup: "authoritative", effectiveCostCents: 0.31, workerClass: "standard" } }),
    event("compute-unbilled", { metric: "parser-process", provider: "local-compute", unit: "cent", amount: 0.05, cost_cents: 0,
      metadata: { runId: "r1", billable: false, costRollup: "authoritative", effectiveCostCents: 0.05 } }),
    event("summary-attempt-1", { metric: "document-summary", input_tokens: 4000, output_tokens: 300, cost_cents: 0.0412, metadata: { runId: "r1", stage: "document-summary", attempt: 1 } }),
    event("summary-attempt-2", { metric: "document-summary", input_tokens: 4000, output_tokens: 300, cost_cents: 0.0412, metadata: { runId: "r1", stage: "document-summary", attempt: 2 } }),
    // Another tenant's spend on a run id it does not own must never leak in.
    { ...event("other-org", { metric: "page-analysis", cost_cents: 50 }), run_id: null, org_id: "o2", workspace_id: "w2", user_id: "u2", metadata: {} },
  ];
  for (const row of rows) {
    await sql`insert into usage_events ${sql(row as never, Object.keys(row) as never)}`;
  }
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

// Ledger spend (sum of cost_cents) plus the unbilled compute estimate.
const RECORDED = 0.128529 + 0.019508 + 0.019509 + 0.0136 + 0.2 + 0.7434044 + 0.0412 * 2;
const EXPECTED = RECORDED + 0.05;

describe("run cost reconciliation", () => {
  it("reports the usage_attribution total on every surface", async () => {
    const snapshot = await runs.getRunProgress("r1", "u1", { recentEventLimit: 0 });
    const run = await runs.getRun("r1", "u1");
    const listed = (await runs.listRuns("u1")).find((entry) => entry.id === "r1");
    const board = (await workspaces.listWorkspaceBoardRecords("u1")).find((record) => record.workspace.id === "w");
    const viewer = await documents.getDocumentViewerPayload("d1", "u1");
    const runForensics = await forensics.getRunForensics("r1", "u1");

    const surfaces = {
      progressUsageTotals: snapshot?.progress?.usageTotals.costCents,
      progressStats: snapshot?.stats.costCents,
      snapshotRun: snapshot?.run.costCents,
      run: run?.costCents,
      listedRun: listed?.costCents,
      boardRun: board?.run?.costCents,
      documentViewerRun: viewer?.usage.run?.costCents,
      forensics: runForensics?.summary.totalCostCents,
    };
    for (const [surface, cents] of Object.entries(surfaces)) {
      expect(cents, surface).toBeCloseTo(EXPECTED, 9);
    }
    expect(Object.values(surfaces)).not.toContain(RUN_CAP_ACCUMULATOR_CENTS);
    expect(run?.computeEstimated).toBe(true);
    expect(snapshot?.progress?.usageTotals.computeEstimated).toBe(true);
    // Labelled, diagnostic, and never the cost.
    expect(snapshot?.temporal?.activityUsageTally.costCents).toBeCloseTo(0.7434, 9);

    // The billed figure (billing breakdown, credit debits) is the ledger sum without the estimate.
    const breakdown = await import("../services/usage-attribution.js").then((module) =>
      module.runCostBreakdown({ runId: "r1", orgId: "o1" }));
    expect(breakdown.totalCostCents).toBeCloseTo(RECORDED, 9);
  });

  it("enforces the run cost cap against the same billed figure the API shows", async () => {
    const snapshot = await runs.getRunProgress("r1", "u1", { recentEventLimit: 0 });
    const run = await runs.getRun("r1", "u1");
    // workspace_runs.spent_cents, kept by the usage_events trigger (0056), is
    // what the worker checks pipeline.maxCostCents against.
    const [row] = await sql<{ spent_cents: number; input_cost_cents: number }[]>`
      select spent_cents, input_cost_cents from workspace_runs where id = 'r1'`;
    expect(Number(row!.spent_cents)).toBeCloseTo(RECORDED, 9);
    expect(run?.billedCostCents).toBeCloseTo(RECORDED, 9);
    expect(snapshot?.run.billedCostCents).toBeCloseTo(RECORDED, 9);
    expect(snapshot?.progress?.usageTotals.billedCostCents).toBeCloseTo(RECORDED, 9);
    // The deprecated accumulator is neither read nor shown.
    expect(Number(row!.input_cost_cents)).toBe(RUN_CAP_ACCUMULATOR_CENTS);
    expect(run?.billedCostCents).not.toBe(RUN_CAP_ACCUMULATOR_CENTS);
    // The ingest report's run cost agrees with the run record.
    const { workspaceRunsUsageCost } = await import("../services/usage-attribution.js");
    const reportCost = await workspaceRunsUsageCost("w", ["r1"], sql);
    expect(reportCost.costCents).toBeCloseTo(EXPECTED, 9);
    expect(reportCost.billedCostCents).toBeCloseTo(RECORDED, 9);
    expect(reportCost.computeEstimated).toBe(true);
    // Another workspace sees none of it.
    expect((await workspaceRunsUsageCost("w2", ["r1"], sql)).costCents).toBe(0);
  });

  it("does not show a run to another org", async () => {
    expect(await runs.getRun("r1", "u2")).toBeNull();
    expect((await runs.listRuns("u2")).map((entry) => entry.id)).not.toContain("r1");
  });
});
