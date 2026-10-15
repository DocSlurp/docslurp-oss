import { describe, expect, it } from "vitest";

import type { NativePdfSpan, NativePdfTable } from "../../native-pdf/types.js";
import type { NativePdfDocument } from "../../native-pdf/types.js";
import { readRoutingFlags } from "../flags.js";
import { makePage, testCatalog } from "../testing.js";
import { buildRegions } from "./candidates.js";
import { runTableGate } from "./gate.js";
import { TABLE_GATE_CROP_TARGET_ID, runTableGateShadow, tableGatePages } from "./shadow.js";
import { checkTotals, findOverlaps, validateCandidate, validateRegion } from "./validators.js";

const span = (text: string, x: number, y: number): NativePdfSpan => ({
  text, bbox: [x, y, x + text.length * 5, y + 10], font: "", size: 10, renderMode: 0, invisible: false, unmapped: 0,
});
// 3 rows x 2 cols of native words inside [0,0,200,60].
const SPANS = [span("Item", 5, 5), span("Cost", 105, 5), span("Tea", 5, 25), span("12", 105, 25), span("Milk", 5, 45), span("30", 105, 45)];
const GOOD: string[][] = [["Item", "Cost"], ["Tea", "12"], ["Milk", "30"]];
const table = (rows: string[][], bbox: [number, number, number, number] = [0, 0, 200, 60]): NativePdfTable => ({ bbox, rows });
const cand = (rows: string[][], id = "A") => ({ id, sources: ["native-lines" as const], bbox: [0, 0, 200, 60] as [number, number, number, number], rows });
const SOURCE = ["Item", "Cost", "Tea", "12", "Milk", "30"];

describe("validators", () => {
  it("passes a faithful rectangular candidate", () => {
    expect(validateCandidate(cand(GOOD), SOURCE).valid).toBe(true);
  });

  it("rejects a candidate that dropped a native word", () => {
    const r = validateCandidate(cand([["Item", "Cost"], ["Tea", "12"], ["Milk", ""]]), SOURCE);
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.kind)).toContain("dropped-words");
  });

  it("rejects a candidate that repeats a value beyond the native count", () => {
    const r = validateCandidate(cand([["Item", "Cost"], ["Tea", "12"], ["Milk", "30"], ["Tea", "12"]]), SOURCE);
    expect(r.issues.map((i) => i.kind)).toEqual(["duplicated-values", "numeric-mismatch"]);
    expect(r.issues[0]!.count).toBe(5);
  });

  it("flags a changed digit through the character and numeric-token checks", () => {
    const r = validateCandidate(cand([["Item", "Cost"], ["Tea", "13"], ["Milk", "30"]]), SOURCE);
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.kind)).toContain("numeric-mismatch");
  });

  it("flags characters that are not in the native text", () => {
    const r = validateCandidate(cand([["Item", "Cost"], ["Tea", "12"], ["Milk", "3Z"]]), SOURCE);
    expect(r.issues.map((i) => i.kind)).toContain("foreign-values");
  });

  it("is robust to how spans were split or joined into cells (bidi/punctuation segmentation)", () => {
    const split = ["(", "Kyoto", ")", "Tea", "12"];
    expect(validateCandidate(cand([["(Kyoto)", "x"], ["Tea", "12"]]), [...split, "x"]).valid).toBe(true);
  });

  it("rejects ragged rows and degenerate tables", () => {
    expect(validateCandidate(cand([["Item", "Cost"], ["Tea"], ["Milk", "30", "x"]]), []).issues.map((i) => i.kind)).toContain("ragged-rows");
    expect(validateCandidate(cand([["Item", "Cost"]]), []).issues.map((i) => i.kind)).toContain("degenerate");
  });

  it("skips conservation checks when there are no native words (scan)", () => {
    expect(validateCandidate(cand(GOOD), []).valid).toBe(true);
  });

  it("checks numeric totals and rejects a contradicting candidate only when a sibling verifies", () => {
    const withTotal = [["Item", "Cost"], ["Tea", "12"], ["Milk", "30"], ["Total", "42"]];
    expect(checkTotals(withTotal, 0.005)).toEqual({ checked: 1, mismatched: 0 });
    expect(checkTotals([["Item", "Cost"], ["Tea", "12"], ["Milk", "30"], ["Total", "52"]], 0.005)).toEqual({ checked: 1, mismatched: 1 });

    const wrong = [["Item", "Cost"], ["Tea", "12"], ["Milk", "30"], ["Total", "42"]];
    const wrongSum = [["Item", "Cost"], ["Tea", "12"], ["Milk", "30"], ["Total", "42"]];
    wrongSum[1]![1] = "21"; // moves a value; total no longer adds up (21 + 30 != 42)
    const region = { id: "R1", bbox: [0, 0, 1, 1] as [number, number, number, number], sourceTokens: [], candidates: [cand(wrong, "A"), cand(wrongSum, "B")] };
    const report = validateRegion(region);
    expect(report.survivors).toEqual(["A"]);
    // Alone, the contradicting candidate survives: totals are weak evidence by themselves.
    expect(validateRegion({ ...region, candidates: [cand(wrongSum, "B")] }).survivors).toEqual(["B"]);
  });

  it("finds overlapping regions", () => {
    const mk = (id: string, bbox: [number, number, number, number]) => ({ id, bbox, candidates: [], sourceTokens: [] });
    expect(findOverlaps([mk("R1", [0, 0, 100, 100]), mk("R2", [50, 50, 150, 150])])).toHaveLength(1);
    expect(findOverlaps([mk("R1", [0, 0, 100, 100]), mk("R2", [0, 120, 100, 200])])).toHaveLength(0);
  });
});

describe("regions", () => {
  it("merges same-box candidates, de-duplicates identical readings and counts native words", () => {
    const regions = buildRegions({ lines: [table(GOOD)], text: [table(GOOD, [2, 2, 198, 58])] }, SPANS);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.candidates).toHaveLength(1);
    expect(regions[0]!.candidates[0]!.sources).toEqual(["native-lines", "native-text"]);
    expect(regions[0]!.sourceTokens.sort()).toEqual([...SOURCE].sort());
  });

  it("keeps different readings as lettered candidates and separate regions apart", () => {
    const alt = [["Item Cost"], ["Tea 12"], ["Milk 30"]];
    const regions = buildRegions({ lines: [table(GOOD), table(GOOD, [0, 300, 200, 360])], text: [table(alt)] }, SPANS);
    expect(regions).toHaveLength(2);
    expect(regions[0]!.candidates.map((c) => c.id)).toEqual(["A", "B"]);
  });
});

describe("runTableGate (ruled-grid-or-crop)", () => {
  const alt = [["Item", "Tea", "Milk"], ["Cost", "12", "30"]]; // transposed reading: same words, different structure

  it("accepts a validated ruled grid even when a borderless reading also survives", () => {
    const r = runTableGate({ lines: [table(GOOD)], text: [table(alt)] }, { spans: SPANS });
    expect(r.regions[0]!.report.survivors).toEqual(["A", "B"]);
    expect(r.regions[0]).toMatchObject({ action: "accept", via: "ruled-grid", candidateId: "A", rows: GOOD });
    expect(r.escalations).toEqual([]);
  });

  it("crops a region whose only readings are borderless", () => {
    const r = runTableGate({ text: [table(alt)] }, { spans: SPANS });
    expect(r.regions[0]).toMatchObject({ action: "escalate", via: "unconfirmed" });
    expect(r.escalations).toEqual([{ regionId: "R1", bbox: [0, 0, 200, 60], role: "table-region", reason: "unconfirmed" }]);
  });

  it("crops when no candidate conserves the native words, and every region of a page with overlaps", () => {
    const lossy = runTableGate({ lines: [table([["Item", "Cost"], ["Tea", "12"]])] }, { spans: SPANS });
    expect(lossy.regions[0]).toMatchObject({ action: "escalate", via: "no-survivor" });
    const overlap = runTableGate({ lines: [table(GOOD), table(GOOD, [100, 30, 300, 90])] }, { spans: SPANS });
    expect(overlap.refusedOverlaps).toHaveLength(1);
    expect(overlap.regions.every((r) => r.via === "page-refused" && r.action === "escalate")).toBe(true);
    expect(overlap.escalations).toHaveLength(2);
  });
});

describe("table gate shadow", () => {
  const fakeDoc = (perPage: Record<number, { lines: NativePdfTable[]; text: NativePdfTable[] }>): NativePdfDocument & { opened: number[] } => {
    const opened: number[] = [];
    return {
      opened,
      pageCount: async () => 3,
      metadata: async () => ({}) as never,
      close: async () => undefined,
      page: (index: number) => {
        opened.push(index + 1);
        const tables = perPage[index + 1] ?? { lines: [], text: [] };
        return {
          tables: async (opts?: { strategy?: "lines" | "text" }) => (opts?.strategy === "text" ? tables.text : tables.lines),
          spans: async () => SPANS,
        } as never;
      },
    };
  };
  const plan = (roles: Array<{ page: number; role: string }>) => ({ assignments: roles.map((r) => ({ pageNumber: r.page, role: r.role })) }) as never;

  it("examines only pages with a table signal", () => {
    const pages = [makePage({ pageNumber: 1 }), makePage({ pageNumber: 2, tableRule: 3 }), makePage({ pageNumber: 3 })];
    expect(tableGatePages(pages, plan([{ page: 3, role: "table" }]))).toEqual([2, 3]);
  });

  it("logs the rule and a crop estimate without touching the plan", async () => {
    const pages = [makePage({ pageNumber: 1, tableRule: 2 }), makePage({ pageNumber: 2, tableRule: 2 })];
    const doc = fakeDoc({ 1: { lines: [table(GOOD)], text: [] }, 2: { lines: [], text: [table(GOOD)] } });
    const haiku = { ...testCatalog().find((t) => t.kind === "hosted-vlm")!, id: TABLE_GATE_CROP_TARGET_ID };
    const p = plan([{ page: 1, role: "accept-text" }, { page: 2, role: "table" }]);
    const before = JSON.stringify(p);
    const rows = await runTableGateShadow({ document: doc, pages, plan: p, catalog: [haiku] });
    expect(JSON.stringify(p)).toBe(before);
    expect(rows.map((r) => [r.pageNumber, r.accepted, r.escalated])).toEqual([[1, 1, 0], [2, 0, 1]]);
    expect(rows[0]!.cropEstimate).toBeNull();
    expect(rows[1]!.cropEstimate).toMatchObject({ targetId: TABLE_GATE_CROP_TARGET_ID });
    expect(rows[1]!.cropEstimate!.costUsd).toBeGreaterThan(0);
    expect(rows[1]!.plannedRoles).toEqual(["table"]);
    // Without the crop target in the catalog there is no estimate, but the decision is still logged.
    expect((await runTableGateShadow({ document: doc, pages, plan: p, catalog: [] }))[1]!.cropEstimate).toBeNull();
  });
});

describe("table gate flag", () => {
  it("defaults to off; only off and shadow are accepted, anything else is off", () => {
    expect(readRoutingFlags({}).tableGate).toBe("off");
    expect(readRoutingFlags({ PAGE_ROUTER_TABLE_GATE: " Shadow " }).tableGate).toBe("shadow");
    expect(readRoutingFlags({ PAGE_ROUTER_TABLE_GATE: "active" }).tableGate).toBe("off");
    expect(readRoutingFlags({ PAGE_ROUTER_TABLE_GATE: "on" }).tableGate).toBe("off");
  });
});
