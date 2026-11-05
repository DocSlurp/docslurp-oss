import { describe, expect, it } from "vitest";

import { PipelineUsageEventLedger } from "../../pipeline/usage-ledger.js";
import type { OcrPageRead, OcrReadOutcome } from "../engine.js";
import { recordOcrReads } from "../ledger.js";

function outcome(pages: Array<Pick<OcrPageRead, "pageNumber" | "text">>, overrides: Partial<OcrReadOutcome> = {}): OcrReadOutcome {
  return {
    mode: "vm", engine: "test-vm-ocr", language: { recognisers: ["multi"], unsupportedScript: false, setting: "auto" },
    pages: pages.map((page) => ({ ...page, meanConfidence: 0.9, recogniser: "multi", chars: page.text.length, elapsedMs: 3, escalation: null })),
    truncatedFrames: false, wallMs: 2_500, cpuMs: 1_900, peakRssKb: 1_400_000, dispose: async () => undefined,
    ...overrides,
  };
}

function ledger(): PipelineUsageEventLedger {
  const usage = new PipelineUsageEventLedger();
  usage.runId = "run-1";
  return usage;
}

const rich = (usage: PipelineUsageEventLedger) => usage.snapshot().filter((event) => event.metric === "ingest-page-rich");

describe("recordOcrReads", () => {
  it("charges each page with words once as page-ocr, with deterministic ids", () => {
    const usage = ledger();
    const read = outcome([
      { pageNumber: 1, text: "Invoice 4200" },
      { pageNumber: 2, text: "   \n" },
      { pageNumber: 3, text: "— · —" },
      { pageNumber: 4, text: "東京" },
    ]);
    expect(recordOcrReads(usage, "doc-1", read, { stage: "extract-markdown", kind: "pdf" })).toEqual([1, 4]);
    expect(rich(usage).map((event) => event.id)).toEqual(["rich:run-1:doc-1:1", "rich:run-1:doc-1:4"]);
    expect(rich(usage).every((event) => event.metadata?.readBy === "page-ocr" && event.metadata?.model === "ppocr:multi")).toBe(true);
  });

  it("charges every frame of an uploaded image as a Rich read, with or without words", () => {
    const usage = ledger();
    const read = outcome([{ pageNumber: 1, text: "Receipt" }, { pageNumber: 2, text: "" }, { pageNumber: 3, text: " · " }]);
    expect(recordOcrReads(usage, "img-1", read, { stage: "extract-markdown", kind: "image" })).toEqual([1, 2, 3]);
    expect(rich(usage).map((event) => event.id)).toEqual(["rich:run-1:img-1:1", "rich:run-1:img-1:2", "rich:run-1:img-1:3"]);
    // 3 frames: 0.75 credits (was 0.25 when only the frame with words billed).
    expect(usage.pendingBillableCents).toBeCloseTo(0.75);
    expect(usage.snapshot().find((event) => event.metric === "ocr-compute")!.metadata).toMatchObject({ kind: "image", chargedPages: [1, 2, 3] });
  });

  it("never charges a page twice across repeated calls (a retried checkpoint, a second batch)", () => {
    const usage = ledger();
    const read = outcome([{ pageNumber: 1, text: "Words" }, { pageNumber: 2, text: "More words" }]);
    recordOcrReads(usage, "doc-1", read, { stage: "extract-markdown", kind: "pdf" });
    recordOcrReads(usage, "doc-1", read, { stage: "extract-markdown", kind: "pdf" });
    recordOcrReads(usage, "doc-1", outcome([{ pageNumber: 2, text: "Words again" }]), { stage: "extract-markdown", kind: "pdf" });
    expect(rich(usage).map((event) => event.id)).toEqual(["rich:run-1:doc-1:1", "rich:run-1:doc-1:2"]);
    // A second ledger for the same run (a retried activity) produces the same ids, so persistence dedupes them.
    const retry = ledger();
    recordOcrReads(retry, "doc-1", read, { stage: "extract-markdown", kind: "pdf" });
    expect(rich(retry).map((event) => event.id)).toEqual(rich(usage).map((event) => event.id));
  });

  it("enqueues one ocr-compute event per job with the boundary's measured cpu, memory and wall time", () => {
    const usage = ledger();
    recordOcrReads(usage, "doc-1", outcome([{ pageNumber: 1, text: "Words" }, { pageNumber: 2, text: "" }]), { stage: "extract-markdown", kind: "pdf" });
    const compute = usage.snapshot().filter((event) => event.metric === "ocr-compute");
    expect(compute).toHaveLength(1);
    expect(compute[0]).toMatchObject({ provider: "ocr-vm:test-vm-ocr", amount: 2, unit: "page", costCents: 0, inputTokens: 0, outputTokens: 0 });
    expect(compute[0]!.metadata).toMatchObject({
      documentId: "doc-1", stage: "extract-markdown", mode: "vm", engine: "test-vm-ocr", language: "auto",
      pages: [1, 2], chargedPages: [1], cpuMs: 1_900, peakRssKb: 1_400_000, wallMs: 2_500, truncatedFrames: false,
    });
  });

  it("labels a local-sandbox read and lists escalation candidates", () => {
    const usage = ledger();
    const read = outcome([{ pageNumber: 1, text: "Words" }], { mode: "local", engine: "local-sandbox" });
    read.pages[0]!.escalation = { reason: "low-confidence", imagePath: "/x/frame-0001.png", width: 10, height: 10 };
    recordOcrReads(usage, "doc-1", read, { stage: "s", kind: "pdf" });
    const compute = usage.snapshot().find((event) => event.metric === "ocr-compute")!;
    expect(compute.provider).toBe("ocr-local-sandbox");
    expect(compute.metadata?.escalationCandidates).toEqual([{ page: 1, reason: "low-confidence" }]);
  });

  it("charges nothing without a run id (an unknown fact never raises a charge)", () => {
    const usage = new PipelineUsageEventLedger();
    expect(recordOcrReads(usage, "doc-1", outcome([{ pageNumber: 1, text: "Words" }]), { stage: "s", kind: "pdf" })).toEqual([1]);
    expect(rich(usage)).toEqual([]);
  });
});
