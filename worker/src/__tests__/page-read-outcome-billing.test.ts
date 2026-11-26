import { describe, expect, it, vi } from "vitest";

import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";

/**
 * A page read charges the customer (an `ocr:` or `rich:` page charge) only when it completed. A read that timed out after it was
 * sent, failed or was rejected keeps its provider-cost usage row for accounting and charges no page: the page keeps its text.
 */
function ledger(): PipelineUsageEventLedger {
  const usage = new PipelineUsageEventLedger();
  usage.runId = "run-1";
  return usage;
}

const pageCharges = (usage: PipelineUsageEventLedger) =>
  usage.snapshot().filter((event) => typeof event.id === "string" && /^(ocr|rich):/.test(event.id));

describe("page reads charge only when they completed", () => {
  for (const metric of ["ocr-escalation", "hosted-ocr", "page-analysis"]) {
    for (const outcome of ["timeout", "failed", "error", "rejected", "failure"]) {
      it(`${metric} with outcome ${outcome} charges no page, and keeps its usage row`, () => {
        const usage = ledger();
        const row = usage.enqueue({
          provider: "openrouter", model: "reader", metric, amount: 1, unit: "attempt", costCents: 0, inputTokens: 0, outputTokens: 0,
          metadata: { documentId: "doc-1", pageNumber: 3, outcome, costSource: "unknown", possiblyBilled: true },
        });
        expect(row).not.toBeNull();
        expect(pageCharges(usage)).toEqual([]);
        expect(usage.pageChargeClass("doc-1", 3)).toBeNull();
      });
    }
  }

  it("a completed read of the same page still charges it once", () => {
    const usage = ledger();
    usage.enqueue({ provider: "openrouter", model: "reader", metric: "ocr-escalation", amount: 1, unit: "attempt", costCents: 0,
      metadata: { documentId: "doc-1", pageNumber: 3, outcome: "timeout" } });
    usage.enqueue({ provider: "openrouter", model: "reader", metric: "ocr-escalation", amount: 1, unit: "page", costCents: 1, outputTokens: 10,
      metadata: { documentId: "doc-1", pageNumber: 3, outcome: "completed" } });
    usage.enqueue({ provider: "openrouter", model: "reader", metric: "hosted-ocr", amount: 1, unit: "page", costCents: 1, outputTokens: 10,
      metadata: { documentId: "doc-1", pageNumber: 4 } });
    expect(pageCharges(usage).map((event) => event.id)).toEqual(["rich:run-1:doc-1:3", "ocr:run-1:doc-1:4"]);
  });

  it("an outcome this build does not know charges as a completed read, and is logged (never silently free)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const usage = ledger();
    usage.enqueue({ provider: "openrouter", model: "reader", metric: "page-analysis", amount: 1, unit: "page", costCents: 1, outputTokens: 10,
      metadata: { documentId: "doc-1", pageNumber: 5, outcome: "partial-new-kind" } });
    expect(pageCharges(usage).map((event) => event.id)).toEqual(["rich:run-1:doc-1:5"]);
    expect(warn.mock.calls.map((call) => String(call[0]))).toContainEqual(expect.stringContaining("unknown outcome=partial-new-kind"));
    warn.mockRestore();
  });
});
