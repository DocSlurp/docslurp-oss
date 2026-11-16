import { describe, expect, it, vi } from "vitest";

import { escalateOcrPages } from "../escalation.js";
import { OCR_ESCALATION_STATS_KEY, ocrEscalationStageStats, recordOcrEscalationPages } from "../escalation-stats.js";
import { HostedOcrSkipped, type HostedOcrReader } from "../hosted-reader.js";
import type { OcrReadOutcome } from "../engine.js";

function ledger() {
  const values = new Map<string, string>();
  return {
    values,
    readDocument: (documentId: string, key: string) => values.get(`${documentId}:${key}`),
    recordDocument: (documentId: string, key: string, value: string) => { values.set(`${documentId}:${key}`, value); },
  };
}

function outcome(pages: Array<{ pageNumber: number; escalate: boolean }>): OcrReadOutcome {
  return {
    mode: "vm", engine: "test", language: { recognisers: ["multi"], unsupportedScript: false, setting: "auto" },
    pages: pages.map((page) => ({ pageNumber: page.pageNumber, text: `ocr ${page.pageNumber}`, meanConfidence: 0.2, recogniser: "multi", chars: 5, elapsedMs: 1,
      escalation: page.escalate ? { reason: "low-confidence", imagePath: `/x/${page.pageNumber}.png`, width: 10, height: 10 } : null })),
    truncatedFrames: false, unreadPages: [], wallMs: 1, cpuMs: 1, peakRssKb: 1, dispose: async () => undefined,
  };
}

describe("OCR escalation record", () => {
  it("keeps page sets per document, so retries and repeated calls never count a page twice", () => {
    const l = ledger();
    expect(ocrEscalationStageStats(l, "doc")).toBeNull();
    recordOcrEscalationPages(l, "doc", { escalated: [1, 2], capped: [5, 6] });
    recordOcrEscalationPages(l, "doc", { escalated: [2], capped: [6, 7] });
    // A page that a later call escalated is no longer capped.
    recordOcrEscalationPages(l, "doc", { escalated: [5] });
    expect(ocrEscalationStageStats(l, "doc")).toEqual({ escalatedPages: 3, cappedPages: 2, capped: [6, 7], skippedPages: { unfunded: 0, "cost-cap": 0, "price-check": 0 } });
    // Another document's record is its own.
    expect(ocrEscalationStageStats(l, "other")).toBeNull();
    // Hostile or corrupt ledger values never throw and never count.
    l.values.set(`doc:${OCR_ESCALATION_STATS_KEY}`, JSON.stringify({ escalated: [-1, 1.5, "2"], capped: "x" }));
    expect(ocrEscalationStageStats(l, "doc")).toBeNull();
    l.values.set(`doc:${OCR_ESCALATION_STATS_KEY}`, "{not json");
    expect(ocrEscalationStageStats(l, "doc")).toBeNull();
    expect(ocrEscalationStageStats(undefined, "doc")).toBeNull();
  });

  it("lists at most 50 capped pages, with whole counts", () => {
    const l = ledger();
    recordOcrEscalationPages(l, "doc", { capped: Array.from({ length: 120 }, (_, index) => index + 1) });
    const stats = ocrEscalationStageStats(l, "doc")!;
    expect(stats.cappedPages).toBe(120);
    expect(stats.capped).toHaveLength(50);
  });

  it("counts the page that hit the per-document cap and every later candidate as capped, and records them on the reader", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const l = ledger();
    let reads = 0;
    const reader: HostedOcrReader = {
      async read() {
        reads += 1;
        if (reads > 1) throw new HostedOcrSkipped("budget", "budget spent");
        return { text: "second read", model: "m", inputTokens: 1, outputTokens: 1, costCents: 0 };
      },
      recordEscalation: (documentId, pages) => recordOcrEscalationPages(l, documentId, pages),
    };
    const read = outcome([{ pageNumber: 1, escalate: true }, { pageNumber: 2, escalate: false }, { pageNumber: 3, escalate: true }, { pageNumber: 4, escalate: true }]);
    const summary = await escalateOcrPages(read, reader, "doc");
    expect(summary).toMatchObject({ attempted: 2, replaced: 1, skipped: { budget: 1 }, capped: 2 });
    expect(ocrEscalationStageStats(l, "doc")).toMatchObject({ escalatedPages: 1, cappedPages: 2, capped: [3, 4] });
    // Pages skipped for another reason (cost cap, privacy) are not the per-document cap; cost cap, funds and price are
    // recorded under their own reason, privacy (a setting) is not recorded.
    const other = ledger();
    const refusing: HostedOcrReader = {
      async read() { throw new HostedOcrSkipped("cost-cap", "run cost cap"); },
      recordEscalation: (documentId, pages) => recordOcrEscalationPages(other, documentId, pages),
    };
    expect(await escalateOcrPages(outcome([{ pageNumber: 1, escalate: true }, { pageNumber: 2, escalate: true }]), refusing, "doc")).toMatchObject({ capped: 0 });
    expect(ocrEscalationStageStats(other, "doc")).toMatchObject({ cappedPages: 0, skippedPages: { "cost-cap": 2, unfunded: 0 } });
    for (const [reason, recorded] of [["margin", "price-check"], ["unfunded", "unfunded"], ["privacy", null]] as const) {
      const l2 = ledger();
      const r: HostedOcrReader = {
        async read() { throw new HostedOcrSkipped(reason, reason); },
        recordEscalation: (documentId, pages) => recordOcrEscalationPages(l2, documentId, pages),
      };
      await escalateOcrPages(outcome([{ pageNumber: 1, escalate: true }]), r, "doc");
      if (recorded) expect(ocrEscalationStageStats(l2, "doc")?.skippedPages[recorded]).toBe(1);
      else expect(ocrEscalationStageStats(l2, "doc")).toBeNull();
    }
  });
});
