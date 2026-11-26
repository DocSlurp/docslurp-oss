import { defaultPipelineFeatures, pageCredits, pageUpgradeCredits } from "@docslurp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpendCheckUnavailableError } from "../db/spend-check.js";
import { extraCreditsForMeasuredPages } from "../lib/office-page-count.js";
import { reconcileProcessedPdfPages } from "../lib/pdf-page-count.js";
import type { Document, ProjectRun } from "../models.js";
import { PageBasis, PageBasisInvariantError, PageBasisUnboundError, UnfundedPagesError, type PageBasisLedger, type PageCharge, type PageMeasurement } from "../pipeline/page-basis.js";
import { MemoryPageBasisLedger, bindMemoryPageBasis, memoryPageBasis } from "../pipeline/page-basis-memory.js";
import { WorkflowState, type CheckpointStore } from "../pipeline/pipeline.js";

/*
 * The page basis through its interface (pipeline/page-basis.ts), over the in-memory ledger: which column a measurement
 * writes, the floors, the in-memory document and run, and the spend check each change owes, summed over the run.
 */

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const pipeline = { ...defaultPipelineFeatures };

/** A document as run creation writes it: admission's priced count is durable (documents.intake_page_count, migration 0130). */
function doc(id: string, overrides: Partial<Document> = {}): Document {
  return {
    id, userId: "user-1", runId: "run-1", filename: `${id}.pdf`, mimeType: "application/pdf", sourceKey: `raw/${id}`,
    status: "processing", extractionMode: "hybrid", pageCount: 1, pageCountSource: "assumed", createdAt: new Date(), updatedAt: new Date(),
    intakePageCount: overrides.pageCount ?? 1,
    ...overrides,
  } as Document;
}

function basis(documents: Document[], options: { balance?: number; run?: Partial<ProjectRun>; pending?: number } = {}) {
  const run = { id: "run-1", orgId: "org-1", userId: "user-1", pagesTotal: documents.reduce((sum, d) => sum + d.pageCount, 0), pipeline, ...options.run } as ProjectRun;
  const ledger = new MemoryPageBasisLedger({ balance: options.balance ?? Number.POSITIVE_INFINITY }).seed(documents);
  const pageBasis = new PageBasis({ run, usageLedger: { pendingBillableCents: options.pending ?? 0 } }, ledger);
  return { pageBasis, ledger, run };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("record: which column, floors, memory and run total", () => {
  type Row = {
    name: string;
    document: Partial<Document>;
    measurement: PageMeasurement;
    row: Record<string, unknown>;
    memory: Partial<Document>;
    pagesTotalDelta: number;
    checked: boolean;
  };
  const rows: Row[] = [
    { name: "page-count raise: page_count, counted, authorized", document: { pageCount: 3 }, measurement: { kind: "page-count", pages: 12 },
      row: { pageCount: 12, pageCountSource: "counted", billingPages: null }, memory: { pageCount: 12, pageCountSource: "counted" }, pagesTotalDelta: 9, checked: true },
    { name: "page-count lower: page_count, never a spend check", document: { pageCount: 10, pageCountSource: "counted" }, measurement: { kind: "page-count", pages: 4 },
      row: { pageCount: 4, pageCountSource: "counted" }, memory: { pageCount: 4 }, pagesTotalDelta: -6, checked: false },
    { name: "billing-pages over an assumed intake: no floor, page_count untouched", document: { mimeType: DOCX, pageCount: 1 },
      measurement: { kind: "billing-pages", pages: 300, method: "text-rule", format: "office-word" },
      row: { pageCount: 1, billingPages: 300, billingPagesMethod: "text-rule" }, memory: { pageCount: 1, billingPages: 300, billingPagesMethod: "text-rule" }, pagesTotalDelta: 0, checked: true },
    { name: "billing-pages empty over an assumed intake: 0 pages", document: { mimeType: DOCX, pageCount: 1 },
      measurement: { kind: "billing-pages", pages: 0, method: "empty", format: "office-word" },
      row: { billingPages: 0, billingPagesMethod: "empty" }, memory: { billingPages: 0 }, pagesTotalDelta: 0, checked: false },
    { name: "billing-pages below a counted intake: floored at it", document: { mimeType: DOCX, pageCount: 12, pageCountSource: "counted" },
      measurement: { kind: "billing-pages", pages: 2, method: "slides", format: "office-pptx" },
      row: { billingPages: 12, billingPagesMethod: "slides" }, memory: { billingPages: 12 }, pagesTotalDelta: 0, checked: false },
    { name: "page-equivalents: billing_pages raised by the page's extra equivalents", document: { pageCount: 2, pageCountSource: "counted" },
      measurement: { kind: "page-equivalents", rows: [{ pageNumber: 1, area: 5 }], allowance: 1 },
      row: { pageCount: 2, billingPages: 6, billingPagesMethod: "page-equivalents" }, memory: { billingPages: 6, billingPagesMethod: "page-equivalents" }, pagesTotalDelta: 0, checked: true },
    { name: "whole-document: billing_pages raised to the text rule's total", document: { mimeType: "text/plain", pageCount: 2, pageCountSource: "counted" },
      measurement: { kind: "whole-document", pages: 9 },
      row: { billingPages: 9, billingPagesMethod: "page-equivalents" }, memory: { billingPages: 9 }, pagesTotalDelta: 0, checked: true },
  ];
  for (const entry of rows) {
    it(entry.name, async () => {
      const document = doc("d1", entry.document);
      const { pageBasis, ledger, run } = basis([document]);
      const before = run.pagesTotal;
      const change = await pageBasis.record(document, entry.measurement);
      expect(change.persisted).toBe(true);
      expect(ledger.documents.get("d1")).toMatchObject(entry.row);
      expect(document).toMatchObject(entry.memory);
      expect(run.pagesTotal - before).toBe(entry.pagesTotalDelta);
      expect(ledger.checks.length > 0).toBe(entry.checked);
    });
  }

  it("page equivalents never lower billing_pages; a smaller measurement still authorizes", async () => {
    const document = doc("d1", { pageCount: 2, pageCountSource: "counted" });
    const { pageBasis, ledger } = basis([document]);
    await pageBasis.record(document, { kind: "page-equivalents", rows: [{ pageNumber: 1, area: 9 }], allowance: 1 });
    const checks = ledger.checks.length;
    const change = await pageBasis.record(document, { kind: "page-equivalents", rows: [{ pageNumber: 1, area: 3 }], allowance: 1 });
    expect(change.billingPages).toBe(10);
    expect(document.billingPages).toBe(10);
    expect(ledger.checks.length).toBe(checks + 1);
  });

  it("a write the ledger refuses (not the run's own document) reports persisted: false", async () => {
    const document = doc("copy", { runId: "other-run" });
    const { pageBasis, ledger } = basis([document]);
    expect((await pageBasis.record(document, { kind: "page-count", pages: 1 })).persisted).toBe(false);
    expect(ledger.documents.get("copy")!.pageCountSource).toBe("assumed");
  });

  it("image frames: page_count to the frames read, the run total follows, and frames past intake are checked at the OCR rate", async () => {
    const tiff = doc("t1", { mimeType: "image/tiff" });
    const { pageBasis, ledger, run } = basis([tiff]);
    await pageBasis.record(tiff, { kind: "image-frames", frames: 30 });
    expect(ledger.documents.get("t1")).toMatchObject({ pageCount: 30 });
    expect(tiff.pageCount).toBe(30);
    expect(run.pagesTotal).toBe(30);
    expect(ledger.checks).toHaveLength(1);
    expect(ledger.checks[0]).toBeCloseTo(extraCreditsForMeasuredPages(pipeline, 1, 30, null, { mode: "ocr" }));
    // A retry with the frames already recorded writes nothing, but checks them again from the durable intake.
    await pageBasis.record(tiff, { kind: "image-frames", frames: 30 });
    expect(ledger.pageCountWrites).toHaveLength(1);
    expect(ledger.checks).toHaveLength(2);
  });
});

describe("spend: pause, refuse, and the run-wide sum", () => {
  it("an unfunded raise pauses the run and stops the document; a second one finds it paused (blocked, not paused)", async () => {
    const a = doc("a", { pageCount: 1 });
    const { pageBasis, ledger } = basis([a], { balance: 0.001 });
    await expect(pageBasis.record(a, { kind: "page-count", pages: 5_000 })).rejects.toMatchObject({ name: "RunPolicyError", paused: true });
    // The count is recorded before the check: a retry finds it and must authorize it again.
    expect(ledger.documents.get("a")!.pageCount).toBe(5_000);
    expect(ledger.paused).toEqual({ reason: "credit_exhausted" });
    const error = await pageBasis.authorize(a).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnfundedPagesError);
    expect(error).toMatchObject({ paused: false });
  });

  it("authorize checks every Fast page the run measured above intake, not only this document's", async () => {
    const a = doc("a", { pageCount: 1, intakePageCount: 1 });
    const b = doc("b", { pageCount: 1, intakePageCount: 1 });
    const { pageBasis, ledger } = basis([a, b]);
    await pageBasis.record(a, { kind: "page-count", pages: 40 });
    await pageBasis.record(b, { kind: "page-count", pages: 60 });
    expect(ledger.checks.at(-1)).toBeCloseTo(pageCredits("fast", 39 + 59));
  });

  it("ten Office files that each fit the balance alone cannot together overdraw it", async () => {
    const files = Array.from({ length: 10 }, (_, n) => doc(`big${n}`, { mimeType: DOCX }));
    const each = extraCreditsForMeasuredPages(pipeline, 1, 400, "text-rule");
    const { pageBasis, ledger } = basis(files, { balance: each * 5.5 });
    let pausedAt = 0;
    for (const [index, file] of files.entries()) {
      const stopped = await pageBasis.record(file, { kind: "billing-pages", pages: 400, method: "text-rule", format: "office-word" })
        .then(() => false, (error: unknown) => error instanceof UnfundedPagesError);
      if (stopped) { pausedAt = index + 1; break; }
    }
    expect(pausedAt).toBe(6);
    expect(ledger.paused).not.toBeNull();
  });

  it("concurrent documents of one run cannot overdraw: of two that fit alone, both recorded at once, at least one is refused", async () => {
    for (const kind of ["office", "tiff"] as const) {
      const files = ["x", "y"].map((id) => doc(id, kind === "office" ? { mimeType: DOCX } : { mimeType: "image/tiff" }));
      const one = kind === "office" ? extraCreditsForMeasuredPages(pipeline, 1, 400, "text-rule") : extraCreditsForMeasuredPages(pipeline, 1, 30, null, { mode: "ocr" });
      const { pageBasis } = basis(files, { balance: one * 1.5 });
      const measurement: PageMeasurement = kind === "office"
        ? { kind: "billing-pages", pages: 400, method: "text-rule", format: "office-word" }
        : { kind: "image-frames", frames: 30 };
      const outcomes = await Promise.allSettled(files.map((file) => pageBasis.record(file, measurement)));
      expect(outcomes.some((outcome) => outcome.status === "rejected"), kind).toBe(true);
      // Each alone fits: a run with only one of them is funded.
      const solo = doc("z", kind === "office" ? { mimeType: DOCX } : { mimeType: "image/tiff" });
      await expect(basis([solo], { balance: one * 1.5 }).pageBasis.record(solo, measurement)).resolves.toBeDefined();
    }
  });

  it("an image's uncharged frames count against every other image of the run", async () => {
    const a = doc("a", { mimeType: "image/tiff" });
    const b = doc("b", { mimeType: "image/tiff" });
    const one = extraCreditsForMeasuredPages(pipeline, 1, 30, null, { mode: "ocr" });
    const { pageBasis, ledger } = basis([a, b], { balance: one * 1.5 });
    await pageBasis.record(a, { kind: "image-frames", frames: 30 });
    await expect(pageBasis.record(b, { kind: "image-frames", frames: 30 })).rejects.toMatchObject({ paused: true });
    expect(ledger.paused).not.toBeNull();
    // Frames already charged as page reads no longer count as owed.
    const [a2, b2] = [doc("a", { mimeType: "image/tiff" }), doc("b", { mimeType: "image/tiff" })];
    const charged = basis([a2, b2], { balance: one * 1.5 });
    await charged.pageBasis.record(a2, { kind: "image-frames", frames: 30 });
    charged.ledger.documents.get("a")!.chargedPages = 30;
    await expect(charged.pageBasis.record(b2, { kind: "image-frames", frames: 30 })).resolves.toBeDefined();
    expect(charged.ledger.paused).toBeNull();
  });
});

describe("council #469: every check weighs one run-wide sum, on every attempt", () => {
  it("a text raise then an Office count, each funded alone, pause the run together (order does not matter)", async () => {
    for (const order of ["text-first", "docx-first"] as const) {
      const text = doc("t", { mimeType: "text/plain" });
      const docx = doc("w", { mimeType: DOCX });
      const N = 5_000;
      const textOwes = pageCredits("fast", N - 1);
      const docxOwes = extraCreditsForMeasuredPages(pipeline, 1, N, "text-rule");
      const { pageBasis, ledger } = basis([text, docx], { balance: Math.max(textOwes, docxOwes) * 1.5 });
      const steps = [
        () => pageBasis.record(text, { kind: "page-count", pages: N }),
        () => pageBasis.record(docx, { kind: "billing-pages", pages: N, method: "text-rule", format: "office-word" }),
      ];
      if (order === "docx-first") steps.reverse();
      await steps[0]!();
      await expect(steps[1]!(), order).rejects.toBeInstanceOf(UnfundedPagesError);
      expect(ledger.paused, order).not.toBeNull();
    }
  });

  it("uncharged TIFF frames and Fast pages are one sum: a frame count then a text raise pause the run", async () => {
    const tiff = doc("i", { mimeType: "image/tiff" });
    const text = doc("t", { mimeType: "text/plain" });
    const framesOwe = extraCreditsForMeasuredPages(pipeline, 1, 1_000, null, { mode: "ocr" });
    const textOwes = pageCredits("fast", 19_999);
    const { pageBasis, ledger } = basis([tiff, text], { balance: Math.max(framesOwe, textOwes) * 1.2 });
    await pageBasis.record(tiff, { kind: "image-frames", frames: 1_000 });
    await expect(pageBasis.record(text, { kind: "page-count", pages: 20_000 })).rejects.toBeInstanceOf(UnfundedPagesError);
    expect(ledger.paused).not.toBeNull();
  });

  it("a raised count found already persisted on a retry (the in-memory count matches) is checked again", async () => {
    const d = doc("p", { pageCount: 10, intakePageCount: 10, pageCountSource: "counted" });
    const { pageBasis, ledger } = basis([d], { balance: 0.0001 });
    ledger.failNext = "balance";
    await expect(pageBasis.record(d, { kind: "page-count", pages: 5_000 })).rejects.toBeInstanceOf(SpendCheckUnavailableError);
    // The retried activity loads the persisted count.
    const retried = doc("p", { pageCount: 5_000, intakePageCount: 10, pageCountSource: "counted" });
    await expect(pageBasis.record(retried, { kind: "page-count", pages: 5_000 })).rejects.toMatchObject({ name: "RunPolicyError", paused: true });
  });

  it("reconcile: an under-claimed PDF paused once is checked again after resume, though the reloaded count shows no mismatch", async () => {
    const mk = (pageCount: number) => doc("p", { pageCount, pageCountSource: "counted", intakePageCount: 1 });
    const run = { id: "run-1", orgId: "org-1", userId: "user-1", pagesTotal: 1, pipeline, stats: {}, artifacts: {} } as unknown as ProjectRun;
    const ledger = new MemoryPageBasisLedger({ balance: 1 }).seed([mk(1)]);
    const first = WorkflowState.create({ ...run }, [mk(1)]);
    first.pageBasis = new PageBasis(first, ledger);
    await expect(reconcileProcessedPdfPages(first, first.documents[0]!, 20_000)).rejects.toBeInstanceOf(UnfundedPagesError);
    // The sweep resumes the run; the retried activity reloads the document with the raised count.
    ledger.paused = null;
    const second = WorkflowState.create({ ...run }, [mk(ledger.documents.get("p")!.pageCount)]);
    second.pageBasis = new PageBasis(second, ledger);
    await expect(reconcileProcessedPdfPages(second, second.documents[0]!, 20_000)).rejects.toBeInstanceOf(UnfundedPagesError);
    expect(ledger.checks).toHaveLength(2);
    expect(ledger.paused).not.toBeNull();
  });

  it("refuses counts and charges that are not finite, before anything moves", async () => {
    for (const pages of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const d = doc("p");
      const { pageBasis, run } = basis([d], { balance: 0 });
      await expect(pageBasis.record(d, { kind: "page-count", pages })).rejects.toBeInstanceOf(PageBasisInvariantError);
      expect(run.pagesTotal).toBe(1);
    }
    for (const frames of [Number.NaN, 0, -5, 1e20]) {
      const d = doc("i", { mimeType: "image/tiff" });
      const { pageBasis, run, ledger } = basis([d], { balance: 0 });
      await expect(pageBasis.record(d, { kind: "image-frames", frames })).rejects.toBeInstanceOf(PageBasisInvariantError);
      expect(run.pagesTotal).toBe(1);
      expect(d.pageCount).toBe(1);
      expect(ledger.pageCountWrites).toEqual([]);
    }
    for (const pages of [Number.NaN, -3, Number.POSITIVE_INFINITY]) {
      const d = doc("w", { mimeType: DOCX });
      const { pageBasis } = basis([d], { balance: 0 });
      await expect(pageBasis.record(d, { kind: "billing-pages", pages, method: "text-rule", format: "office-word" })).rejects.toBeInstanceOf(PageBasisInvariantError);
      expect(d.billingPages ?? null).toBeNull();
    }
    const ledger = new MemoryPageBasisLedger({ balance: 100 });
    await expect(ledger.checkCharge({ id: "r", orgId: "o", userId: "u" }, Number.NaN)).rejects.toBeInstanceOf(SpendCheckUnavailableError);
    expect(await ledger.largestFundedCharge({ id: "r", orgId: "o", userId: "u" }, 3, () => Number.NaN)).toBe(0);
  });

  it("a run without a pipeline is refused with a typed invariant error, never priced as free", async () => {
    const d = doc("w", { mimeType: DOCX });
    const { pageBasis } = basis([d], { run: { pipeline: undefined as never } });
    await expect(pageBasis.record(d, { kind: "billing-pages", pages: 400, method: "text-rule", format: "office-word" })).rejects.toBeInstanceOf(PageBasisInvariantError);
  });
});

describe("council #469 round 2", () => {
  it("an OCR read never spends balance a measured document already owes: a DOCX raise, then reads are refused (R2-A)", async () => {
    const docx = doc("w", { mimeType: DOCX });
    const scan = doc("s", { pageCount: 1_000, intakePageCount: 1_000, pageCountSource: "counted" });
    const { pageBasis, ledger } = basis([docx, scan], { balance: 10 });
    let pages = 2;
    while (extraCreditsForMeasuredPages(pipeline, 1, pages + 1, "text-rule") <= 9) pages += 1;
    await pageBasis.record(docx, { kind: "billing-pages", pages, method: "text-rule", format: "office-word" });
    const owed = extraCreditsForMeasuredPages(pipeline, 1, pages, "text-rule", { features: false });
    let reads = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const decision = await pageBasis.fund({ kind: "page-read", mode: "ocr", pages: 8 });
      if (!decision.funded) break;
      ledger.balance -= pageCredits("ocr", 8);
      reads += pageCredits("ocr", 8);
    }
    // What the run owes for measured pages plus the reads it funded never exceeds the balance it started with.
    expect(owed + reads).toBeLessThanOrEqual(10);
    expect(ledger.paused).not.toBeNull();
  });

  it("an escalation is sized against what the run already owes", async () => {
    const text = doc("t", { mimeType: "text/plain", pageCount: 5_000, intakePageCount: 1, pageCountSource: "counted" });
    const owed = pageCredits("fast", 4_999);
    const upgrade = pageUpgradeCredits("ocr", "rich");
    const { pageBasis } = basis([text], { balance: owed + upgrade * 0.5 });
    expect(await pageBasis.affordable({ kind: "page-upgrade", from: "ocr", to: "rich" }, 1)).toBe(0);
    const funded = basis([doc("t", { mimeType: "text/plain", pageCount: 5_000, intakePageCount: 1, pageCountSource: "counted" })], { balance: owed + upgrade * 1.5 });
    expect(await funded.pageBasis.affordable({ kind: "page-upgrade", from: "ocr", to: "rich" }, 1)).toBe(1);
  });

  it("one rule for an image's own frames on both sides: past the larger of intake and charged pages (R2-B)", async () => {
    const tiff = doc("t", { mimeType: "image/tiff", pageCount: 500, intakePageCount: 500, pageCountSource: "counted" });
    const txt = doc("x", { mimeType: "text/plain" });
    const { pageBasis, ledger } = basis([tiff, txt], { balance: 15 });
    await pageBasis.record(tiff, { kind: "image-frames", frames: 500 });
    // Priced at intake: it owes nothing in its own check, and nothing in any other document's.
    expect(await ledger.runMeasurements("run-1", "x", [])).toMatchObject({ ocrFrames: 0 });
    await expect(pageBasis.record(txt, { kind: "page-count", pages: 2 })).resolves.toBeDefined();
    // Charged pages count up to the document's frames only.
    const raised = doc("r", { mimeType: "image/tiff", pageCount: 30, intakePageCount: 1, pageCountSource: "counted" });
    const charged = basis([raised], { balance: 100 });
    charged.ledger.documents.get("r")!.chargedPages = 10;
    expect((await charged.ledger.runMeasurements("run-1", null, [])).ocrFrames).toBe(20);
    charged.ledger.documents.get("r")!.chargedPages = 999;
    expect((await charged.ledger.runMeasurements("run-1", null, [])).ocrFrames).toBe(0);
  });

  it("the memory ledger counts deduplicated copies at their recorded classes, as the SQL does, and none with copy billing off", async () => {
    const copy = doc("c", { pageCount: 900, intakePageCount: 1, pageCountSource: "counted", dedupedFromDocumentId: "orig", copyOcrPages: 100, copyRichPages: 50 } as Partial<Document>);
    const { ledger } = basis([copy]);
    expect(await ledger.runMeasurements("run-1", null, [])).toEqual({ fastPages: 749, ocrFrames: 0, ocrPages: 100, richPages: 50, documentChargedPages: 0 });
    ledger.includeCopies = false;
    expect(await ledger.runMeasurements("run-1", null, [])).toEqual({ fastPages: 0, ocrFrames: 0, ocrPages: 0, richPages: 0, documentChargedPages: 0 });
  });

  it("an Office document's own pages count from its durable intake, never its raised count", async () => {
    const docx = doc("w", { mimeType: DOCX, pageCount: 3, intakePageCount: 1, pageCountSource: "assumed" });
    const { pageBasis, ledger } = basis([docx]);
    await pageBasis.record(docx, { kind: "billing-pages", pages: 400, method: "text-rule", format: "office-word" });
    // 399 Fast pages above an intake of 1 (not 397 above the page count of 3).
    expect(ledger.checks.at(-1)).toBeCloseTo(extraCreditsForMeasuredPages(pipeline, 3, 400, "text-rule") - extraCreditsForMeasuredPages(pipeline, 3, 400, "text-rule", { features: false }) + pageCredits("fast", 399));
  });
});

describe("affordability and reads", () => {
  it("sizes an image's frames with the other images' uncharged frames and this activity's buffered charges", async () => {
    const a = doc("a", { mimeType: "image/tiff" });
    const other = doc("other", { mimeType: "image/tiff", pageCount: 20, pageCountSource: "counted" });
    const perFrame = extraCreditsForMeasuredPages(pipeline, 1, 2, null, { mode: "ocr" });
    const othersOwe = extraCreditsForMeasuredPages(pipeline, 1, 20, null, { mode: "ocr", features: false });
    const pending = 0.5;
    const { pageBasis, ledger } = basis([a, other], { balance: othersOwe + pending + perFrame * 10.5, pending });
    const frames = await pageBasis.affordable({ kind: "image-frames", document: a }, 64);
    expect(frames).toBeGreaterThan(1);
    expect(frames).toBeLessThan(64);
    expect(ledger.paused).toBeNull();
    expect(ledger.checks).toEqual([]);
  });

  it("always grants an image its first frame and never more than max", async () => {
    const a = doc("a", { mimeType: "image/tiff" });
    expect(await basis([a], { balance: 0 }).pageBasis.affordable({ kind: "image-frames", document: a }, 64)).toBe(1);
    expect(await basis([a]).pageBasis.affordable({ kind: "image-frames", document: a }, 8)).toBe(8);
  });

  it("sizes an OCR-to-Rich upgrade per page with the buffered charges, read-only", async () => {
    const upgrade = pageUpgradeCredits("ocr", "rich");
    const { pageBasis, ledger } = basis([], { balance: upgrade * 2.5 + 1, pending: 1 });
    expect(await pageBasis.affordable({ kind: "page-upgrade", from: "ocr", to: "rich" }, 10)).toBe(2);
    expect(ledger.paused).toBeNull();
  });

  it("funds a read when the balance covers it and the buffered charges; otherwise pauses the run", async () => {
    const funded = basis([], { balance: pageCredits("ocr", 32) + 1, pending: 1 });
    expect(await funded.pageBasis.fund({ kind: "page-read", mode: "ocr", pages: 32 })).toMatchObject({ funded: true, paused: false });
    const unfunded = basis([], { balance: pageCredits("ocr", 32), pending: 1 });
    expect(await unfunded.pageBasis.fund({ kind: "page-read", mode: "ocr", pages: 32 })).toMatchObject({ funded: false, paused: true });
    expect(unfunded.ledger.paused).toEqual({ reason: "credit_exhausted" });
  });

  it("pauses for funds once; a second pause reports blocked", async () => {
    const { pageBasis } = basis([]);
    expect(await pageBasis.pauseForFunds("credit_exhausted")).toEqual({ paused: true, blocked: true });
    expect(await pageBasis.pauseForFunds("credit_exhausted")).toEqual({ paused: false, blocked: true });
  });
});

describe("fail closed: a check that cannot be made refuses, never skips", () => {
  type Operation = { name: string; mimeType: string; document?: Partial<Document>; run: (pageBasis: PageBasis, document: Document) => Promise<unknown> };
  const operations: Operation[] = [
    { name: "record page-count raise", mimeType: "application/pdf", run: (p, d) => p.record(d, { kind: "page-count", pages: 50 }) },
    { name: "record image frames", mimeType: "image/tiff", run: (p, d) => p.record(d, { kind: "image-frames", frames: 30 }) },
    { name: "record billing pages", mimeType: DOCX, run: (p, d) => p.record(d, { kind: "billing-pages", pages: 400, method: "text-rule", format: "office-word" }) },
    // A measurement already recorded (a retried attempt): 50 counted pages where admission priced 1.
    { name: "authorize", mimeType: "application/pdf", document: { pageCount: 50, pageCountSource: "counted", intakePageCount: 1 }, run: (p, d) => p.authorize(d) },
    { name: "fund a read", mimeType: "image/png", run: (p) => p.fund({ kind: "page-read", mode: "ocr", pages: 1 }) },
    { name: "size image frames", mimeType: "image/tiff", run: (p, d) => p.affordable({ kind: "image-frames", document: d } as PageCharge & { kind: "image-frames" }, 64) },
    { name: "size an upgrade", mimeType: "image/png", run: (p) => p.affordable({ kind: "page-upgrade", from: "ocr", to: "rich" }, 1) },
    { name: "pause for funds", mimeType: "image/png", run: (p) => p.pauseForFunds("credit_exhausted") },
  ];
  for (const operation of operations) {
    const a = () => doc("a", { mimeType: operation.mimeType, ...operation.document });
    it(`${operation.name}: no store bound refuses with PageBasisUnboundError (retryable)`, async () => {
      const state = WorkflowState.create({ id: "run-1", orgId: "org-1", userId: "user-1", pipeline, artifacts: {}, stats: {}, stage: "x" } as unknown as ProjectRun, [a()]);
      const error = await operation.run(state.pageBasis, state.documents[0]!).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PageBasisUnboundError);
      expect(error).toBeInstanceOf(SpendCheckUnavailableError);
    });

    it(`${operation.name}: a run with no user to charge refuses (retryable)`, async () => {
      const document = a();
      const { pageBasis, ledger } = basis([document], { run: { userId: "" } });
      await expect(operation.run(pageBasis, document)).rejects.toBeInstanceOf(SpendCheckUnavailableError);
      expect(ledger.paused).toBeNull();
    });

    it(`${operation.name}: a run with no organization refuses (retryable)`, async () => {
      if (operation.name === "pause for funds") return; // a pause writes the run row only; the organization is not read
      const document = a();
      const { pageBasis, ledger } = basis([document], { run: { orgId: null } });
      await expect(operation.run(pageBasis, document)).rejects.toBeInstanceOf(SpendCheckUnavailableError);
      expect(ledger.paused).toBeNull();
    });

    it(`${operation.name}: a balance read that fails refuses (retryable), nothing paused`, async () => {
      if (operation.name === "pause for funds") return;
      const document = a();
      const { pageBasis, ledger } = basis([document]);
      ledger.failNext = "balance";
      await expect(operation.run(pageBasis, document)).rejects.toBeInstanceOf(SpendCheckUnavailableError);
      expect(ledger.paused).toBeNull();
    });
  }

  it("a pause that cannot be written refuses (retryable), never reports a pause", async () => {
    const document = doc("a");
    const { pageBasis, ledger } = basis([document], { balance: 0 });
    ledger.failNext = "pause";
    await expect(pageBasis.record(document, { kind: "page-count", pages: 5_000 })).rejects.toBeInstanceOf(SpendCheckUnavailableError);
    expect(ledger.paused).toBeNull();
  });

  it("with the spend check switched off (WORKER_SPEND_CHECK=off), charges pass explicitly at the adapter", async () => {
    const document = doc("a");
    const run = { id: "run-1", orgId: "org-1", userId: "user-1", pagesTotal: 1, pipeline } as ProjectRun;
    const ledger = new MemoryPageBasisLedger({ balance: 0, spendCheckEnabled: false }).seed([document]);
    const pageBasis = new PageBasis({ run, usageLedger: { pendingBillableCents: 0 } }, ledger);
    await expect(pageBasis.record(document, { kind: "page-count", pages: 5_000 })).resolves.toMatchObject({ pageCount: 5_000 });
    expect(ledger.paused).toBeNull();
  });

  it("a ledger cast past the type (an untyped store without one) refuses every check instead of skipping it", async () => {
    const document = doc("a");
    const run = { id: "run-1", orgId: "org-1", userId: "user-1", pagesTotal: 1, pipeline } as ProjectRun;
    const pageBasis = new PageBasis({ run, usageLedger: { pendingBillableCents: 0 } }, undefined as unknown as PageBasisLedger);
    await expect(pageBasis.record(document, { kind: "page-count", pages: 5 })).rejects.toBeInstanceOf(PageBasisUnboundError);
    await expect(pageBasis.fund({ kind: "page-read", mode: "ocr", pages: 1 })).rejects.toBeInstanceOf(PageBasisUnboundError);
  });

  it("a state bound to a store gets a page basis over that store's ledger", async () => {
    const state = WorkflowState.create({ id: "run-1", orgId: "org-1", userId: "user-1", pipeline, artifacts: {}, stats: {}, stage: "x", pagesTotal: 1 } as unknown as ProjectRun, [doc("a")]);
    const ledger = new MemoryPageBasisLedger().seed(state.documents);
    state.bindStore({ pageBasisLedger: ledger } as unknown as CheckpointStore);
    await state.pageBasis.record(state.documents[0]!, { kind: "page-count", pages: 3 });
    expect(ledger.documents.get("a")!.pageCount).toBe(3);
    expect(state.run.pagesTotal).toBe(3);
  });

  it("the helpers bind the same way", async () => {
    const state = WorkflowState.create({ id: "run-1", orgId: "org-1", userId: "user-1", pipeline, artifacts: {}, stats: {}, stage: "x" } as unknown as ProjectRun, [doc("a")]);
    const ledger = bindMemoryPageBasis(state);
    await state.pageBasis.record(state.documents[0]!, { kind: "page-count", pages: 2 });
    expect(ledger.pageCountWrites).toEqual([{ documentId: "a", pages: 2 }]);
    const { pageBasis, ledger: own } = memoryPageBasis({ id: "run-2" }, [doc("b", { runId: "run-2" })]);
    await pageBasis.record(own.documents.get("b") as unknown as Document, { kind: "page-count", pages: 4 });
    expect(own.documents.get("b")!.pageCount).toBe(4);
  });
});

describe("compile-time: a missing adapter is a type error, not a runtime skip", () => {
  it("rejects a PageBasis without a ledger, a partial ledger and a store without one", () => {
    const state = { run: { id: "r" } as ProjectRun, usageLedger: { pendingBillableCents: 0 } };
    // @ts-expect-error a PageBasis needs a ledger
    const noLedger = () => new PageBasis(state);
    // @ts-expect-error every ledger method is required
    const partial: PageBasisLedger = { checkCharge: async () => ({ paused: false, blocked: false }) };
    // @ts-expect-error a CheckpointStore must carry its page basis ledger
    const store: CheckpointStore = { updateProgress: async () => undefined };
    // @ts-expect-error the old optional spend probes are gone from the store contract
    const probe = (s: CheckpointStore) => s.enforceSpendForCharge;
    // @ts-expect-error the workflow state's page basis is never optional
    const optional = (s: WorkflowState) => { s.pageBasis = undefined; };
    expect([noLedger, partial, store, probe, optional].length).toBe(5);
  });
});
