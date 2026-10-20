import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ calls: [] as Array<{ text: string; values: unknown[] }> }));
vi.mock("../db.js", () => ({
  sql: Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      mocks.calls.push({ text: strings.join("?"), values });
      return [];
    },
    { array: (v: unknown[]) => v, json: (v: unknown) => v },
  ),
}));
vi.mock("../lib/temporal.js", () => ({ startMaterializeWorkflow: vi.fn() }));
vi.mock("../services/billing/spend-guard.js", () => ({ canSpend: vi.fn(async () => true) }));

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

  it("start `processing` with a confirmed workflow start so recovery and sweepers never pick them up", async () => {
    mocks.calls.length = 0;
    await defaultMaterializeDeps.createRun({ orgId: "o", userId: "u", workspaceId: "w", documentId: "d1", documents: 1, pages: 3 });
    const { text } = mocks.calls[0]!;
    expect(text).toContain("'processing'");
    expect(text).toContain("workflow_started_at");
    expect(text).not.toContain("'queued'");
  });

  it("start with a lease so stale-lease alerts only fire when the worker stops renewing it", async () => {
    mocks.calls.length = 0;
    await defaultMaterializeDeps.createRun({ orgId: "o", userId: "u", workspaceId: "w", documentId: "d1", documents: 1, pages: 3 });
    expect(mocks.calls[0]!.text).toMatch(/lease_expires_at[\s\S]*now\(\) \+ interval '15 minutes'/);
    expect(mocks.calls[0]!.text).not.toMatch(/interval '[1-5] minutes?'/);
  });

  it("can still be closed or failed after being created processing", async () => {
    mocks.calls.length = 0;
    await defaultMaterializeDeps.failRun("mat_1", "x");
    await defaultMaterializeDeps.closeDedupedRun("mat_1");
    for (const call of mocks.calls) expect(call.text).toContain("status in ('queued', 'processing')");
  });
});
