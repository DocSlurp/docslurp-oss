import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ calls: [] as Array<{ text: string; values: unknown[] }>, sourcePipeline: null as Record<string, unknown> | null }));
vi.mock("../db.js", () => ({
  sql: Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      mocks.calls.push({ text: strings.join("?"), values });
      return /as pipeline/.test(strings.join("?")) ? [{ pipeline: mocks.sourcePipeline ?? {} }] : [];
    },
    { array: (v: unknown[]) => v, json: (v: unknown) => v },
  ),
}));
vi.mock("../lib/temporal.js", () => ({ startMaterializeWorkflow: vi.fn() }));
const spend = vi.hoisted(() => ({
  canSpend: vi.fn(async () => true),
  enforceLiveBudgetCaps: vi.fn(async () => undefined),
}));
class BlockedError extends Error {
  constructor(readonly code: string) { super(code); }
}
vi.mock("../services/billing/spend-guard.js", () => ({
  canSpend: spend.canSpend,
  isSpendBlockedError: (error: unknown) => error instanceof BlockedError,
}));
vi.mock("../services/run-creation.js", () => ({ enforceLiveBudgetCaps: spend.enforceLiveBudgetCaps }));

const { defaultMaterializeDeps } = await import("../search/deferred/materialize-client.js");

describe("materialize run rows", () => {
  it("inherit the source document's run pipeline (then the workspace's), never an empty default", async () => {
    mocks.calls.length = 0;
    await defaultMaterializeDeps.createRun({ orgId: "o", userId: "u", workspaceId: "w", documentId: "d1", documents: 1, pages: 3 });
    const { text, values } = mocks.calls[0]!;
    expect(text).toMatch(/join documents d on d\.id = \?/);
    expect(text).toMatch(/r\.pipeline.*w\.pipeline/s);
    expect(values).toContain("d1");
  });

  it("drop stored extractor settings the strict schemas reject before copying the source pipeline (round 6 L1)", async () => {
    mocks.calls.length = 0;
    mocks.sourcePipeline = { quality: "good", documentExtraction: { options: { dolphin: { mode: "page", repoPath: "/tmp/attacker" }, liteparse: {} } } };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await defaultMaterializeDeps.createRun({ orgId: "o", userId: "u", workspaceId: "w", documentId: "d1", documents: 1, pages: 3 });
    } finally {
      mocks.sourcePipeline = null;
      errors.mockRestore();
    }
    const insert = mocks.calls.find((call) => call.text.includes("insert into workspace_runs"))!;
    const stored = insert.values.find((value) => typeof value === "object" && value !== null && "quality" in (value as object));
    expect(stored).toEqual({ quality: "good", documentExtraction: { options: { dolphin: { mode: "page" } } } });
    expect(JSON.stringify(insert.values)).not.toContain("/tmp/attacker");
  });

  it("start `processing` with a confirmed workflow start so recovery and sweepers never pick them up", async () => {
    mocks.calls.length = 0;
    await defaultMaterializeDeps.createRun({ orgId: "o", userId: "u", workspaceId: "w", documentId: "d1", documents: 1, pages: 3 });
    const { text } = mocks.calls.find((call) => call.text.includes("insert into workspace_runs"))!;
    expect(text).toContain("'processing'");
    expect(text).toContain("workflow_started_at");
    expect(text).not.toContain("'queued'");
  });

  it("start with a lease so stale-lease alerts only fire when the worker stops renewing it", async () => {
    mocks.calls.length = 0;
    await defaultMaterializeDeps.createRun({ orgId: "o", userId: "u", workspaceId: "w", documentId: "d1", documents: 1, pages: 3 });
    const insert = mocks.calls.find((call) => call.text.includes("insert into workspace_runs"))!;
    expect(insert.text).toMatch(/lease_expires_at[\s\S]*now\(\) \+ interval '15 minutes'/);
    expect(insert.text).not.toMatch(/interval '[1-5] minutes?'/);
  });

  it("can still be closed or failed after being created processing", async () => {
    mocks.calls.length = 0;
    await defaultMaterializeDeps.failRun("mat_1", "x");
    await defaultMaterializeDeps.closeDedupedRun("mat_1");
    for (const call of mocks.calls) expect(call.text).toContain("status in ('queued', 'processing')");
  });
});

describe("materialize spend gate", () => {
  it("checks the live monthly caps before inserting runs, not only the cached budget_paused flag", async () => {
    spend.canSpend.mockClear();
    spend.enforceLiveBudgetCaps.mockRejectedValueOnce(new BlockedError("workspace_budget_paused"));
    await expect(defaultMaterializeDeps.canSpend("org-1", "ws-1")).resolves.toBe(false);
    expect(spend.enforceLiveBudgetCaps).toHaveBeenCalledWith("ws-1", "org-1");
    expect(spend.canSpend).not.toHaveBeenCalled();
  });

  it("then applies the credit gate", async () => {
    spend.canSpend.mockResolvedValueOnce(false);
    await expect(defaultMaterializeDeps.canSpend("org-1", "ws-1")).resolves.toBe(false);
    spend.canSpend.mockResolvedValueOnce(true);
    await expect(defaultMaterializeDeps.canSpend("org-1", "ws-1")).resolves.toBe(true);
  });

  it("fails closed on an unexpected error", async () => {
    spend.enforceLiveBudgetCaps.mockRejectedValueOnce(new Error("Workspace not found"));
    await expect(defaultMaterializeDeps.canSpend("org-1", "ws-1")).rejects.toThrow("Workspace not found");
  });
});
