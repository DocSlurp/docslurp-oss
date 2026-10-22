import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = Object.assign(vi.fn(), {
  unsafe: vi.fn(),
  array: vi.fn((value: unknown) => value),
});

vi.mock("../db.js", () => ({
  sql: sqlMock,
}));

const { defaultAiUsagePricingCatalog } = await import("@docslurp/shared");
const { createUsageLedger, recordUnitCharge, recordUsageEvent } = await import(
  "../lib/ai-usage.js"
);

const originalInputCostRate = process.env.COST_PER_1K_INPUT_TOKENS;
const originalOutputCostRate = process.env.COST_PER_1K_OUTPUT_TOKENS;

function usageInserts() {
  return sqlMock.mock.calls.filter(([strings]) =>
    Array.isArray(strings) && strings.join(" ").includes("insert into usage_events"),
  );
}

function insertedMetadata(call: unknown[] | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.[12] ?? "{}")) as Record<string, unknown>;
}

describe("Usage Event ledger", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
    vi.restoreAllMocks();
    process.env.COST_PER_1K_INPUT_TOKENS = "0.01";
    process.env.COST_PER_1K_OUTPUT_TOKENS = "0.03";
  });

  afterEach(() => {
    if (originalInputCostRate === undefined) {
      delete process.env.COST_PER_1K_INPUT_TOKENS;
    } else {
      process.env.COST_PER_1K_INPUT_TOKENS = originalInputCostRate;
    }
    if (originalOutputCostRate === undefined) {
      delete process.env.COST_PER_1K_OUTPUT_TOKENS;
    } else {
      process.env.COST_PER_1K_OUTPUT_TOKENS = originalOutputCostRate;
    }
  });

  it("logs, prices and persists one event with its scope stamped", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const event = await recordUsageEvent({
      userId: "user-1",
      scope: { orgId: "org-1", workspaceId: "ws-1", runId: "run-1" },
      usage: {
        provider: "openai",
        model: "text-embedding-3-small",
        metric: "embed-query",
        inputTokens: 42,
        logOutputTokens: false,
      },
    });

    expect(event).toMatchObject({
      metric: "embed-query",
      amount: 42,
      costCents: 0,
      inputTokens: 42,
      outputTokens: 0,
    });
    expect(log).toHaveBeenCalledWith(
      "[ai-usage] embed-query model=text-embedding-3-small input_tokens=42",
    );
    const [insert] = usageInserts();
    expect(insert).toContain("user-1");
    expect(insert).toContain("run-1");
    expect(insertedMetadata(insert)).toMatchObject({
      orgId: "org-1",
      workspaceId: "ws-1",
      costSource: "estimate",
      providerCostCents: (42 / 1000) * 0.002,
      billable: false,
    });
    // The debit statement is guarded by billable: provider cost never debits credits.
    expect(insert?.[0].join(" ")).toContain("enqueue_org_credit_debit");
  });

  it("records a billable unit charge at the price card amount", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const event = await recordUnitCharge({
      userId: "user-1",
      scope: { orgId: "org-1", workspaceId: "ws-1" },
      charge: { id: "search:1", metric: "search-query", amount: 1, unit: "search", credits: 0.01 },
    });
    expect(event).toMatchObject({ provider: "docslurp", metric: "search-query", costCents: 0.01 });
    const [insert] = usageInserts();
    expect(insert).toContain(0.01);
    expect(insertedMetadata(insert)).toMatchObject({ billable: true, unitCharge: true, priceCard: "2026-10-21" });
  });

  it("attributes usage to the API key authenticating the request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { Hono } = await import("hono");
    const { requestContextMiddleware, setCurrentRequestApiKeyId } = await import("../lib/request-context.js");
    const usage = { provider: "openai", model: "gpt-x", metric: "chat", inputTokens: 5, outputTokens: 5 };
    const app = new Hono();
    app.use("*", requestContextMiddleware);
    app.get("/", async (c) => {
      setCurrentRequestApiKeyId("key-1");
      await recordUsageEvent({ userId: "user-1", scope: { orgId: "org-1" }, usage });
      // An explicit scope wins, including an explicit null.
      await recordUsageEvent({ userId: "user-1", scope: { orgId: "org-1", apiKeyId: null }, usage });
      return c.text("ok");
    });

    await app.request("/");

    const [withKey, withoutKey] = usageInserts();
    expect(insertedMetadata(withKey)).toMatchObject({ apiKeyId: "key-1" });
    expect(insertedMetadata(withoutKey)).not.toHaveProperty("apiKeyId");
  });

  it("records provider cost without a customer charge and stamps cross-workspace scope", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await recordUsageEvent({
      userId: "user-1",
      scope: { orgId: "org-1", workspaceIds: ["ws-1", "ws-2", "ws-1"] },
      usage: {
        provider: "openrouter",
        model: "model-1",
        metric: "aggregate-rag-answer",
        inputTokens: 2,
        outputTokens: 3,
        costCents: 7,
        metadata: { feature: "chat" },
      },
    });

    const [insert] = usageInserts();
    expect(insert).not.toContain(8.4);
    expect(insert).toContain(null); // run_id
    expect(insertedMetadata(insert)).toEqual({
      feature: "chat",
      orgId: "org-1",
      workspaceIds: ["ws-1", "ws-2"],
      providerCostCents: 7,
      billable: false,
      costRole: "provider",
    });
  });

  it("logs but never persists empty usage", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const event = await recordUsageEvent({
      userId: "user-1",
      scope: {},
      usage: { provider: "openrouter", model: "model-1", metric: "noop" },
    });

    expect(event).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("persists duration-priced transcription even when no tokens are reported", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const event = await recordUsageEvent({
      userId: "user-1",
      scope: { orgId: "org-1", workspaceId: "ws-1" },
      usage: {
        provider: "openrouter", model: "microsoft/mai-transcribe-2", metric: "chat.transcription",
        amount: 12.5, unit: "second", costCents: 0.03472222,
        metadata: { costSource: "provider", tokenUsageReported: false },
      },
    });
    expect(event).toMatchObject({ inputTokens: 0, outputTokens: 0, amount: 12.5, unit: "second", costCents: 0 });
    expect(usageInserts()).toHaveLength(1);
    expect(insertedMetadata(usageInserts()[0])).toMatchObject({ orgId: "org-1", workspaceId: "ws-1", tokenUsageReported: false, providerCostCents: 0.03472222, billable: false });
  });

  it("buffers on record, adopts child events without logging, persists on flush", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = createUsageLedger({
      userId: "user-1",
      scope: { orgId: "org-1" },
    });

    ledger.record({ provider: "openrouter", model: "model-1", metric: "noop" });
    ledger.record({
      provider: "openrouter",
      model: "model-1",
      metric: "hyde",
      inputTokens: 9,
      outputTokens: 3,
    });
    ledger.adopt([
      {
        provider: "openrouter",
        model: "model-1",
        metric: "stepback",
        amount: 2,
        unit: "token",
        costCents: 0,
        inputTokens: 1,
        outputTokens: 1,
        metadata: {},
      },
      undefined,
    ]);

    expect(log).toHaveBeenCalledTimes(2);
    expect(ledger.events().map((event) => event.metric)).toEqual(["hyde", "stepback"]);
    expect(sqlMock).not.toHaveBeenCalled();

    const flushed = await ledger.flush({ scope: { sessionId: "session-1" } });
    expect(flushed).toHaveLength(2);
    expect(usageInserts().map(insertedMetadata)).toEqual([
      expect.objectContaining({ orgId: "org-1", sessionId: "session-1" }),
      expect.objectContaining({ orgId: "org-1", sessionId: "session-1" }),
    ]);

    // A second flush only writes what was recorded since.
    expect(await ledger.flush()).toEqual([]);
    expect(usageInserts()).toHaveLength(2);
  });

  it("keeps a transactional batch retryable until commit()", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = createUsageLedger({});
    ledger.record({ provider: "local", model: "m", metric: "embed-query", inputTokens: 5 });

    const first = await ledger.flushWithin(sqlMock as never, { userId: "user-1" });
    expect(first.events).toHaveLength(1);
    // Transaction rolled back: no commit(), so the next attempt rewrites it.
    const second = await ledger.flushWithin(sqlMock as never, { userId: "user-1" });
    expect(second.events).toHaveLength(1);
    // A flush retry keeps the same usage id even after an ambiguous commit.
    expect(usageInserts()[0]?.[1]).toBe(usageInserts()[1]?.[1]);
    second.commit();
    const third = await ledger.flushWithin(sqlMock as never, { userId: "user-1" });
    expect(third.events).toEqual([]);
  });

  it("refuses to persist without a user", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = createUsageLedger({});
    ledger.record({ provider: "local", model: "m", metric: "embed-query", inputTokens: 5 });
    await expect(ledger.flush()).rejects.toThrow("userId");
    expect(ledger.events()).toHaveLength(1);
  });

  it("never records a priced model's tokens at zero provider cost", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { SEARCH_OPENROUTER_MODEL } = await import("../lib/ai.js");
    const priced = [
      ...defaultAiUsagePricingCatalog.filter((entry) => entry.costPer1kInputTokens > 0 && entry.costPer1kOutputTokens > 0),
      // Unlisted models fall back to the configured rates, which are positive.
      { provider: "openrouter", model: SEARCH_OPENROUTER_MODEL },
      { provider: "openrouter", model: "unlisted/model" },
    ];
    for (const entry of priced) {
      await recordUsageEvent({
        userId: "user-1",
        scope: { orgId: "org-1", workspaceId: "ws-1" },
        usage: { provider: entry.provider ?? "openrouter", model: entry.model, metric: "invariant", inputTokens: 1_000, outputTokens: 200 },
      });
    }
    const inserts = usageInserts();
    expect(inserts).toHaveLength(priced.length);
    for (const call of inserts) {
      expect(Number(call[10]) + Number(call[11]), String(call[5])).toBeGreaterThan(0);
      // Customers pay price-card units; the provider cost is kept for our own reports.
      expect(Number(call[9]), String(call[5])).toBe(0);
      expect(Number(insertedMetadata(call).providerCostCents), String(call[5])).toBeGreaterThan(0);
    }
  });
});
