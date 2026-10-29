import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();
const sqlBeginMock = vi.fn();
const getWorkspaceAccessMock = vi.fn();
const listAccessibleWorkspaceIdsMock = vi.fn(async () => [] as string[]);
const currentRequestIdMock = vi.fn(() => "req-123");
const s3SendMock = vi.fn();
const getAvailableCreditsMock = vi.fn(async () => ({ includedRemaining: 0, prepaid: 1_000, available: 1_000 }));

vi.mock("../db.js", () => ({
  sql: Object.assign(sqlMock, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    listen: vi.fn(),
    begin: sqlBeginMock
  })
}));

vi.mock("../services/organizations.js", () => ({
  canContributeToWorkspace: vi.fn(() => true),
  getWorkspaceAccess: getWorkspaceAccessMock,
  listAccessibleWorkspaceIds: listAccessibleWorkspaceIdsMock
}));

vi.mock("../lib/request-context.js", () => ({
  currentRequestId: currentRequestIdMock
}));

vi.mock("../lib/file-urls.js", () => ({
  fileUrlForArtifact: (uri: string) => ({
    url: `/v1/files/sealed-${Buffer.from(uri).length}/${uri.split("/").pop()}`,
    expiresAt: "2026-01-01T00:00:00.000Z"
  })
}));

vi.mock("../services/billing/credits.js", () => ({
  getAvailableCredits: getAvailableCreditsMock
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    middlewareStack = { add: vi.fn(), addRelativeTo: vi.fn() };
    send = s3SendMock;
  },
  GetObjectCommand: class {
    constructor(readonly input: unknown) {}
  }
}));

const {
  buildRunProcessingPreview,
  shouldFailStaleProcessingRun,
  listRuns,
  listRunEventsForRunId,
  summarizeRunUsageCost,
  summarizeStageResources,
} = await import("../services/runs.js");
const { defaultPipelineFeatures, pageCredits } = await import("@docslurp/shared");
const { createRunCreation } = await import("../services/run-creation.js");

// Spend admission is exercised through Run creation with no files: it fails or
// stops at the insert, before any Document is written.
const runCreationStart = vi.fn();
function createRun(input: { userId: string; workspaceId: string; kind: string; totalDocuments?: number; pipeline: typeof defaultPipelineFeatures }) {
  const { totalDocuments: _total, ...rest } = input;
  return createRunCreation({ sql: sqlMock as never, start: runCreationStart }).create({ ...rest, sources: { kind: "files", files: [] } });
}

describe("run events", () => {
  const row = (id: string, eventType: string) => ({
    id, user_id: "u", run_id: "run-1", document_id: "doc-1", stage_name: "extract-markdown", event_type: eventType,
    status: "completed", message: null, progress: {}, stats: {}, payload: {}, created_at: "2026-10-25T04:48:00.000Z",
  });

  it("skips an event type the schema does not know instead of failing the whole history", async () => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([row("e1", "document.completed"), row("e2", "document.some_future_event"), row("e3", "document.plausibility_warning")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = await listRunEventsForRunId({ runId: "run-1" });
    expect(events.map(event => event.id)).toEqual(["e1", "e3"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("document.some_future_event"), expect.anything());
    warn.mockRestore();
  });
});

describe("createRun", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    sqlBeginMock.mockReset();
    getWorkspaceAccessMock.mockReset();
    currentRequestIdMock.mockClear();
    s3SendMock.mockReset();
    getAvailableCreditsMock.mockClear();
    sqlBeginMock.mockImplementation(async (callback: (tx: typeof sqlMock) => unknown) => {
      return await callback(Object.assign(sqlMock, {
        json: (value: unknown) => value,
        array: (value: unknown) => value,
        listen: vi.fn(),
        begin: sqlBeginMock
      }));
    });
  });

  const spendStatus = (overrides: Record<string, unknown> = {}) => ({
    org_id: "org-1", plan_id: "free", available: 1_000, reserved: 0,
    workspace_budget_paused: false, org_budget_paused: false, workspace_in_org: true, ...overrides,
  });

  function respondToAdmission(status: Record<string, unknown>, texts: string[] = []) {
    sqlMock.mockImplementation((strings: TemplateStringsArray | string) => {
      const text = Array.isArray(strings) ? strings.join("?") : String(strings);
      texts.push(text);
      if (text.includes("as workspace_budget_cents")) return Promise.resolve([{ workspace_budget_cents: null, org_budget_cents: null }]);
      if (text.includes("org_spend_status")) return Promise.resolve([status]);
      if (text.includes("insert into workspace_runs")) return Promise.reject(new Error("inserted"));
      return Promise.resolve([]);
    });
    return texts;
  }

  it("blocks new runs with credit_exhausted when included + prepaid credits are spent", async () => {
    getWorkspaceAccessMock.mockResolvedValue({ orgId: "org-1" });
    const texts = respondToAdmission(spendStatus({ available: -3.5 }));

    const error = await createRun({
      userId: "user-1",
      workspaceId: "ws-1",
      kind: "bulk-upload",
      totalDocuments: 1,
      pipeline: defaultPipelineFeatures,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ statusCode: 402, code: "credit_exhausted" });
    expect(String((error as Error).message)).toContain("/app/billing");
    expect(texts.some((text) => text.includes("insert into workspace_runs"))).toBe(false);
  });

  it("admits under the org's advisory lock and counts in-flight run reservations", async () => {
    getWorkspaceAccessMock.mockResolvedValue({ orgId: "org-1" });
    // 0.5 credits above the Free chat reserve (100), one in-flight run still holds 1 reserved credit.
    const texts = respondToAdmission(spendStatus({ available: 100.5, reserved: 1 }));
    const input = { userId: "user-1", workspaceId: "ws-1", kind: "bulk-upload" as const, totalDocuments: 1, pipeline: defaultPipelineFeatures };

    const error = await createRun(input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ statusCode: 402, code: "credit_exhausted" });
    expect(String((error as Error).message)).toContain("held by in-flight runs");
    const lock = texts.findIndex((text) => text.includes("pg_advisory_xact_lock(spend_admission_lock_key("));
    const status = texts.findIndex((text) => text.includes("org_spend_status"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(status).toBeGreaterThan(lock);
    expect(sqlBeginMock).toHaveBeenCalledTimes(1);

    // The same balance with no reservations admits the run: the insert runs in that transaction.
    texts.length = 0;
    respondToAdmission(spendStatus({ available: 100.5, reserved: 0 }), texts);
    await expect(createRun(input)).rejects.toThrow("inserted");
  });

  it("blocks runs for a workspace paused by its budget or outside the org", async () => {
    getWorkspaceAccessMock.mockResolvedValue({ orgId: "org-1" });
    const input = { userId: "user-1", workspaceId: "ws-1", kind: "bulk-upload" as const, totalDocuments: 1, pipeline: defaultPipelineFeatures };
    respondToAdmission(spendStatus({ org_budget_paused: true }));
    await expect(createRun(input)).rejects.toMatchObject({ statusCode: 402, code: "org_budget_paused" });
    respondToAdmission(spendStatus({ workspace_in_org: false }));
    await expect(createRun(input)).rejects.toMatchObject({ statusCode: 402, code: "plan_not_entitled" });
  });

  it("sums monthly spend only for budget caps that exist", async () => {
    getWorkspaceAccessMock.mockResolvedValue({ orgId: "org-1" });
    const texts: string[] = [];
    const respond = (limits: { workspace_budget_cents: number | null; org_budget_cents: number | null }) =>
      sqlMock.mockImplementation((strings: TemplateStringsArray | string) => {
        const text = Array.isArray(strings) ? strings.join("?") : String(strings);
        texts.push(text);
        if (text.includes("as workspace_budget_cents")) return Promise.resolve([limits]);
        if (text.includes("as spend_cents")) return Promise.resolve([{ spend_cents: 150 }]);
        if (text.includes("budget_paused")) return Promise.resolve([]);
        if (text.includes("insert into workspace_runs")) return Promise.reject(new Error("stop-after-budget"));
        return Promise.resolve([]);
      });
    const input = { userId: "user-1", workspaceId: "ws-1", kind: "bulk-upload" as const, totalDocuments: 1, pipeline: defaultPipelineFeatures };

    // No caps: the month-of-usage sum (the costliest ingest statement) is skipped.
    respond({ workspace_budget_cents: null, org_budget_cents: null });
    await createRun(input).catch(() => undefined);
    expect(texts.some((text) => text.includes("as workspace_budget_cents"))).toBe(true);
    expect(texts.filter((text) => text.includes("as spend_cents"))).toHaveLength(0);

    // A workspace cap sums workspace spend only, and pauses once spend reaches it.
    texts.length = 0;
    respond({ workspace_budget_cents: 100, org_budget_cents: null });
    const error = await createRun(input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ statusCode: 402, code: "workspace_budget_paused" });
    expect(texts.filter((text) => text.includes("as spend_cents"))).toHaveLength(1);
  });

});

describe("run preview", () => {
  it("builds a recommended preview profile from file metadata and workspace history", () => {
    const preview = buildRunProcessingPreview({
      request: {
        workspace: "ws-1",
        pipeline: defaultPipelineFeatures,
        files: [
          {
            filename: "ap-invoice.pdf",
            mimeType: "application/pdf",
            sizeBytes: 2_400_000
          },
          {
            filename: "ap-ledger.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            sizeBytes: 900_000
          }
        ],
        urls: []
      },
      historyRows: [
        {
          quality: "auto",
          completed_runs: 4,
          sampled_documents: 12,
          avg_plausibility_score: 0.68,
          avg_seconds_per_page: 2.8
        },
        {
          quality: "good",
          completed_runs: 3,
          sampled_documents: 9,
          avg_plausibility_score: 0.85,
          avg_seconds_per_page: 3.6
        }
      ]
    });

    expect(preview.documentCount).toBe(2);
    expect(preview.estimatedPages).toBeGreaterThan(1);
    expect(preview.recommended.quality).toBe("auto");
    expect(preview.options.map((option) => option.quality)).toEqual(["fast", "auto", "good"]);
    expect(preview.options.some((option) => option.recommended)).toBe(true);
    expect(preview.topSignals).toContain("table-heavy inputs favor layout-aware extraction");
  });

  it("prices PRICE_CARD units per quality, whichever vision model runs", () => {
    const request = {
      workspaceId: "ws-1",
      pipeline: defaultPipelineFeatures,
      files: [{ filename: "scan.pdf", mimeType: "application/pdf", sizeBytes: 3_000_000 }],
      urls: [],
    };
    const preview = () => buildRunProcessingPreview({ request, historyRows: [] });
    const byQuality = Object.fromEntries(preview().options.map((option) => [option.quality, option.estimatedCost]));
    const pages = preview().estimatedPages;
    // fast is flat Fast, good flat Rich, auto spans the two (credits are cents).
    expect(byQuality.fast).toEqual({ minCents: pageCredits("fast", pages), maxCents: pageCredits("fast", pages) });
    expect(byQuality.good).toEqual({ minCents: pageCredits("rich", pages), maxCents: pageCredits("rich", pages) });
    expect(byQuality.auto!.minCents).toBe(pageCredits("fast", pages));
    expect(byQuality.auto!.maxCents).toBeLessThanOrEqual(pageCredits("rich", pages));
    vi.stubEnv("DOCSLURP_VISION_MODEL_URI", "llm://openrouter/z-ai/glm-5.3-flash");
    try {
      expect(preview().options.map((option) => option.estimatedCost)).toEqual(Object.values(byQuality));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("stale processing run reconciliation", () => {
  it("flags processing runs whose worker lease has gone cold while Temporal is still running", () => {
    expect(
      shouldFailStaleProcessingRun({
        runStatus: "processing",
        temporalStatus: "RUNNING",
        lastHeartbeatAt: "2026-05-20T12:00:00.000Z",
        leaseExpiresAt: "2026-05-20T12:01:00.000Z",
        updatedAt: "2026-05-20T12:00:00.000Z",
        nowMs: new Date("2026-05-20T12:07:00.000Z").getTime(),
        graceMs: 5 * 60_000,
      }),
    ).toBe(true);
  });

  it("keeps fresh processing runs live", () => {
    expect(
      shouldFailStaleProcessingRun({
        runStatus: "processing",
        temporalStatus: "RUNNING",
        lastHeartbeatAt: "2026-05-20T12:04:30.000Z",
        leaseExpiresAt: "2026-05-20T12:05:30.000Z",
        updatedAt: "2026-05-20T12:04:30.000Z",
        nowMs: new Date("2026-05-20T12:07:00.000Z").getTime(),
        graceMs: 5 * 60_000,
      }),
    ).toBe(false);
  });

  it("does not reinterpret terminal or non-processing runs as stale", () => {
    expect(
      shouldFailStaleProcessingRun({
        runStatus: "completed",
        temporalStatus: "RUNNING",
        lastHeartbeatAt: "2026-05-20T12:00:00.000Z",
        leaseExpiresAt: "2026-05-20T12:01:00.000Z",
        updatedAt: "2026-05-20T12:00:00.000Z",
        nowMs: new Date("2026-05-20T12:07:00.000Z").getTime(),
        graceMs: 5 * 60_000,
      }),
    ).toBe(false);

    expect(
      shouldFailStaleProcessingRun({
        runStatus: "processing",
        temporalStatus: "FAILED",
        lastHeartbeatAt: "2026-05-20T12:00:00.000Z",
        leaseExpiresAt: "2026-05-20T12:01:00.000Z",
        updatedAt: "2026-05-20T12:00:00.000Z",
        nowMs: new Date("2026-05-20T12:07:00.000Z").getTime(),
        graceMs: 5 * 60_000,
      }),
    ).toBe(false);
  });
});


describe("global activity inventory", () => {
  it("includes old live work instead of truncating at the latest 50 records", async () => {
    listAccessibleWorkspaceIdsMock.mockResolvedValueOnce(["ws-1"]);
    sqlMock.mockResolvedValueOnce([]);
    await listRuns("user-1", true);
    const query = sqlMock.mock.calls.at(-1)![0].join(" ");
    expect(query).toContain("status in ('queued', 'processing')");
    expect(query).not.toContain("limit 50");
    expect(query).toContain("workspace_id = any");
  });
});

describe("run resource and cost rollups", () => {
  it("sums CPU per stage and takes the RSS high-water mark instead of summing it", () => {
    const { totals, byStage } = summarizeStageResources([
      { stage_name: "parse", metric: "stage-cpu-user", total: "120", peak: "80" },
      { stage_name: "parse", metric: "stage-cpu-system", total: 30, peak: 30 },
      { stage_name: "parse", metric: "stage-rss-peak", total: 900, peak: 500 },
      { stage_name: "embed", metric: "stage-cpu-user", total: 50, peak: 50 },
      { stage_name: "embed", metric: "stage-rss-peak", total: 700, peak: 700 },
    ]);
    expect(totals).toEqual({ cpuUserMs: 170, cpuSystemMs: 30, rssDeltaBytes: 0, peakRssBytes: 700 });
    expect(byStage).toEqual({ parse: { cpuMs: 150, peakRssBytes: 500 }, embed: { cpuMs: 50, peakRssBytes: 700 } });
  });

  it("adds the unbilled worker-compute estimate to run cost and flags it", () => {
    expect(summarizeRunUsageCost({
      input_tokens: 10, output_tokens: 2,
      recorded_cost_cents: "4.5", ai_cost_cents: "3", self_hosted_cost_cents: "1", self_hosted_list_cents: "2",
      fee_cost_cents: "1.5", billed_compute_cents: "0", estimated_compute_cents: "0.25",
      worker_classes: ["shared-cpu-2x"], regions: ["iad"],
    })).toEqual({
      inputTokens: 10, outputTokens: 2,
      costCents: 4.75, billedCostCents: 4.5, estimatedComputeCents: 0.25,
      aiCostCents: 3, selfHostedCostCents: 1, selfHostedListCents: 2, feeCostCents: 1.5, computeCostCents: 0.25,
      computeEstimated: true, workerClasses: ["shared-cpu-2x"], regions: ["iad"],
    });
    expect(summarizeRunUsageCost(null).costCents).toBe(0);
  });
});
