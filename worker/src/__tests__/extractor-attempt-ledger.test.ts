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
    expect(ledger.canAttempt("pymupdf")).toBe(true);
  });

  it("admits each method once even when it is revisited by voting or retry", () => {
    const ledger = new ExtractorAttemptLedger();
    ledger.reserve("pymupdf");
    expect(() => ledger.reserve("pymupdf")).toThrow(/already attempted/);
    ledger.markUnavailable("pymupdf");
    expect(ledger.snapshot()).toEqual({ attempted: ["pymupdf"], unavailable: [] });
  });
});
