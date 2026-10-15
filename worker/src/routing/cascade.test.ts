import { describe, expect, it, vi } from "vitest";

import {
  freeCascadeTrigger,
  hasInvalidLatex,
  hasRaggedTable,
  isContentRefusal,
  looksTruncated,
  type CascadeVerifier,
} from "./cascade.js";

describe("free cascade triggers", () => {
  it("fires on empty output, non-stop and truncating finish reasons", () => {
    expect(freeCascadeTrigger({ text: "  " })).toBe("empty-output");
    expect(freeCascadeTrigger({ text: "fine", finishReason: "length" })).toBe("truncated-output");
    expect(freeCascadeTrigger({ text: "fine", finishReason: "content_filter" })).toBe("non-stop-finish");
    expect(freeCascadeTrigger({ text: "fine", finishReason: "stop" })).toBeNull();
    expect(freeCascadeTrigger({ text: "fine" })).toBeNull();
  });

  it("detects unterminated fences and html tables", () => {
    expect(looksTruncated("```py\nprint(1)")).toBe(true);
    expect(looksTruncated("```py\nprint(1)\n```")).toBe(false);
    expect(looksTruncated("<table><tr><td>1</td>")).toBe(true);
    expect(freeCascadeTrigger({ text: "<table><tr>" })).toBe("truncated-output");
  });

  it("flags structurally invalid latex but not currency or valid math", () => {
    expect(hasInvalidLatex("$$\\frac{a}{b$$")).toBe(true);
    expect(hasInvalidLatex("$$\\frac{a}{b}$$")).toBe(false);
    expect(hasInvalidLatex("$$\\begin{aligned} x \\end{matrix}$$")).toBe(true);
    expect(hasInvalidLatex("$x = \\left( y $ more")).toBe(true);
    expect(hasInvalidLatex("It cost $5 and then $10 more.")).toBe(false);
    expect(hasInvalidLatex("Unterminated $$ block")).toBe(true);
    expect(hasInvalidLatex("```\n$$ {{ \n```")).toBe(false);
    expect(freeCascadeTrigger({ text: "see \\(\\frac{1}{2\\)" })).toBe("invalid-latex");
  });

  it("flags pipe tables with inconsistent column counts", () => {
    const ok = "| a | b |\n|---|---|\n| 1 | 2 |";
    const ragged = "| a | b |\n|---|---|\n| 1 | 2 | 3 |";
    expect(hasRaggedTable(ok)).toBe(false);
    expect(hasRaggedTable(ragged)).toBe(true);
    expect(hasRaggedTable("text\n\n" + ok + "\n\nmore\n\n" + ragged)).toBe(true);
    expect(freeCascadeTrigger({ text: ragged })).toBe("ragged-table");
  });
});

describe("verifier seam", () => {
  it("accepts a fake decision-model verifier", async () => {
    const verify = vi.fn(async () => ({ pFail: 0.9, escalate: true, costUsd: 0.0001 }));
    const verifier: CascadeVerifier = { verify };
    const verdict = await verifier.verify({ pageNumber: 2, targetId: "t", text: "x" });
    expect(verdict).toEqual({ pFail: 0.9, escalate: true, costUsd: 0.0001 });
  });
});

describe("content refusal detection", () => {
  it("recognises provider content-filter finish reasons only", () => {
    for (const reason of ["content_filter", "refusal", "SAFETY", " blocked "]) expect(isContentRefusal({ finishReason: reason })).toBe(true);
    for (const reason of ["stop", "length", "end_turn", null, undefined, ""]) expect(isContentRefusal({ finishReason: reason })).toBe(false);
  });
});
