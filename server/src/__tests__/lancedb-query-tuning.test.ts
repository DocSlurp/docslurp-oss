import { describe, expect, it } from "vitest";
import { lanceDbQueryTuning } from "../search/lancedb-query-tuning.js";

describe("Lance candidate refinement", () => {
  it("preserves default scoped budgets and leaves unscoped defaults alone", () => {
    expect(lanceDbQueryTuning(10, 0)).toEqual({ ef: undefined });
    expect(lanceDbQueryTuning(10, 2)).toEqual({ ef: 150 });
    expect(lanceDbQueryTuning(10, 200)).toEqual({ ef: 1500 });
  });
  it("covers refined candidates even beyond the previous ceiling", () => {
    for (const k of [1, 10, 50, 100, 1000]) {
      for (const documents of [0, 1, 200]) {
        for (const factor of [1, 4, 16]) {
          const tuning = lanceDbQueryTuning(k, documents, String(factor));
          expect(tuning.ef).toBeGreaterThanOrEqual(k * factor);
          expect(tuning.refineFactor).toBe(factor);
        }
      }
    }
  });
  it("rejects unsafe or malformed settings rather than hiding native query errors", () => {
    for (const raw of ["0", "-1", "17", "1.5", "NaN", "Infinity", "4junk"]) {
      expect(() => lanceDbQueryTuning(10, 1, raw)).toThrow("LANCEDB_REFINE_FACTOR");
    }
    expect(lanceDbQueryTuning(10, 0, " ")).toEqual({ ef: undefined });
  });
});
