import { describe, expect, it } from "vitest";
import { ExtractorAttemptLedger } from "../extractors/attempt-ledger.js";

describe("ExtractorAttemptLedger", () => {
  it("keeps unavailable probes distinct from executions", () => {
    const ledger = new ExtractorAttemptLedger();
    ledger.markUnavailable("docling");
    ledger.reserve("kreuzberg");
    expect(ledger.snapshot()).toEqual({ attempted: ["kreuzberg"], unavailable: ["docling"] });
    expect(ledger.canAttempt("docling")).toBe(false);
    expect(ledger.canAttempt("kreuzberg")).toBe(false);
    expect(ledger.canAttempt("poppler-text")).toBe(true);
  });

  it("admits each method once even when it is revisited by voting or retry", () => {
    const ledger = new ExtractorAttemptLedger();
    ledger.reserve("poppler-text");
    expect(() => ledger.reserve("poppler-text")).toThrow(/already attempted/);
    ledger.markUnavailable("poppler-text");
    expect(ledger.snapshot()).toEqual({ attempted: ["poppler-text"], unavailable: [] });
  });
});
