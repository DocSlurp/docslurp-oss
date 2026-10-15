import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_PDF_MARKDOWN_TARGET_ID,
  NATIVE_PDF_OCR_FILL_TARGET_ID,
  NATIVE_PDF_OCR_TARGET_ID,
  NATIVE_PDF_TEXT_TARGET_ID,
  type Assignment,
} from "@docslurp/shared";

import { NativePdfError } from "../../native-pdf/types.js";
import { testCatalog } from "../testing.js";
import { NATIVE_PDF_MARKDOWN_EXTRACTOR, NATIVE_PDF_TEXT_EXTRACTOR } from "./native-pdf.js";
import { executorFor } from "./registry.js";
import { executeAssignments } from "./run.js";
import type { ExecutorDeps } from "./types.js";

const catalog = testCatalog();
const byId = (id: string) => catalog.find((t) => t.id === id)!;
const estimate = { costUsd: 0, latencyMs: 10, pPass: 0.9 };
const asg = (pageNumber: number, targetId: string, role: Assignment["role"]): Assignment => ({
  pageNumber, scope: { kind: "page" }, targetId, role, reason: "test", estimate, cascade: [],
});

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    pageText: vi.fn(async (p) => `slice ${p}`),
    nativePageText: vi.fn(async (id, p) =>
      id === NATIVE_PDF_MARKDOWN_EXTRACTOR ? `# md ${p}` : id === NATIVE_PDF_TEXT_EXTRACTOR ? `txt ${p}` : null),
    withRaster: vi.fn(async (p, fn) => await fn({ path: `/tmp/p${p}.png`, mimeType: "image/png" })),
    withCrop: vi.fn(),
    ocr: vi.fn(async (r) => ({ text: `tess ${r.path}`, latencyMs: 30, model: "tesseract" })),
    label: vi.fn(),
    vlm: vi.fn(),
    ...over,
  } as ExecutorDeps;
}

const request = (page: number, id: string, role: Assignment["role"]) => ({ assignment: asg(page, id, role), index: page, target: byId(id) });

describe("native-pdf targets", () => {
  it("are in the catalog with measured local cost and the intended roles", () => {
    const md = byId(NATIVE_PDF_MARKDOWN_TARGET_ID);
    expect(md.roles).toEqual(["extract-text", "table"]);
    expect(md.pricing.source).toBe("local-compute");
    expect(md.pricing.pagesPerMinuteObserved).toBeGreaterThan(1000);
    expect(md.latency.n).toBeGreaterThan(0);
    expect(byId(NATIVE_PDF_TEXT_TARGET_ID).roles).toEqual(["extract-text"]);
    expect(byId(NATIVE_PDF_OCR_FILL_TARGET_ID).roles).toEqual(["ocr", "extract-text"]);
    expect(byId(NATIVE_PDF_OCR_TARGET_ID).roles).toEqual(["ocr", "extract-text"]);
    for (const id of [NATIVE_PDF_MARKDOWN_TARGET_ID, NATIVE_PDF_TEXT_TARGET_ID, NATIVE_PDF_OCR_FILL_TARGET_ID, NATIVE_PDF_OCR_TARGET_ID]) {
      expect(executorFor(byId(id)), id).not.toBeNull();
      expect(JSON.stringify(byId(id))).not.toMatch(/pdfust/i);
    }
  });

  it("markdown and text executors serve per-page engine output without a raster", async () => {
    const d = deps();
    const res = await executeAssignments(
      [request(1, NATIVE_PDF_MARKDOWN_TARGET_ID, "extract-text"), request(2, NATIVE_PDF_TEXT_TARGET_ID, "extract-text")],
      d,
    );
    expect(res.outputs.map((o) => [o.text, o.fallback])).toEqual([["# md 1", undefined], ["txt 2", undefined]]);
    expect(d.withRaster).not.toHaveBeenCalled();
  });

  it("falls back to the canonical page slice when the engine is absent", async () => {
    const d = deps({ nativePageText: vi.fn(async () => null) });
    const res = await executeAssignments([request(3, NATIVE_PDF_MARKDOWN_TARGET_ID, "extract-text")], d);
    expect(res.outputs[0]).toMatchObject({ text: "slice 3", fallback: "canonical-page-slice" });
  });

  it("ocr-fill falls back to tesseract when the engine reports NATIVE_PDF_UNSUPPORTED", async () => {
    const nativePdfOcr = vi.fn(async () => { throw new NativePdfError("NATIVE_PDF_UNSUPPORTED", "ocrFillAsync unsupported"); });
    const d = deps({ nativePdfOcr, nativeOcrPolicy: "prefer" });
    const res = await executeAssignments([request(1, NATIVE_PDF_OCR_FILL_TARGET_ID, "ocr"), request(2, NATIVE_PDF_OCR_TARGET_ID, "ocr")], d);
    expect(nativePdfOcr).toHaveBeenCalledTimes(2);
    expect(res.failures).toEqual([]);
    expect(res.outputs.map((o) => [o.text, o.model, o.fallback])).toEqual([
      ["tess /tmp/p1.png", "tesseract", "ocr:tesseract"],
      ["tess /tmp/p2.png", "tesseract", "ocr:tesseract"],
    ]);
  });

  it("ocr-fill falls back when the dependency is absent or returns null", async () => {
    for (const nativePdfOcr of [undefined, vi.fn(async () => null)]) {
      const res = await executeAssignments([request(1, NATIVE_PDF_OCR_FILL_TARGET_ID, "ocr")], deps({ nativePdfOcr, nativeOcrPolicy: "prefer" }));
      expect(res.outputs[0]).toMatchObject({ model: "tesseract", fallback: "ocr:tesseract" });
    }
  });

  it("ocr-fill serves the engine result when supported, using the mixed-page Markdown", async () => {
    const nativePdfOcr = vi.fn(async () => ({
      text: "native line\nscanned line", markdown: "native line\n\nscanned line", filledRegions: 1, engine: "native-pdf-ocr", latencyMs: 120,
    }));
    const d = deps({ nativePdfOcr, nativeOcrPolicy: "prefer" });
    const res = await executeAssignments([request(1, NATIVE_PDF_OCR_FILL_TARGET_ID, "ocr")], d);
    expect(nativePdfOcr).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 1, mode: "fill" }));
    expect(res.outputs[0]).toMatchObject({ text: "native line\n\nscanned line", model: "native-pdf-ocr" });
    expect(res.outputs[0]!.fallback).toBeUndefined();
    expect(d.ocr).not.toHaveBeenCalled();
  });

  it("other engine OCR failures fall back to tesseract with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const d = deps({ nativeOcrPolicy: "prefer", nativePdfOcr: vi.fn(async () => { throw Object.assign(new Error("ocr model crashed"), { code: "PDF_ERROR" }); }) });
    const res = await executeAssignments([request(1, NATIVE_PDF_OCR_TARGET_ID, "ocr")], d);
    expect(res.failures).toEqual([]);
    expect(res.outputs[0]).toMatchObject({ model: "tesseract", fallback: "ocr:tesseract" });
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/ocr page=1 fell back code=NATIVE_PDF_FAILED engineCode=PDF_ERROR .*next=tesseract/);
    warn.mockRestore();
  });

  it("native OCR needs no page raster; the tesseract fallback fetches one only when used", async () => {
    const served = deps({
      nativeOcrPolicy: "prefer",
      nativePdfOcr: vi.fn(async () => ({ text: "t", markdown: "scanned page", filledRegions: 3, engine: "ocr-model", latencyMs: 5 })),
    });
    await executeAssignments([request(1, NATIVE_PDF_OCR_FILL_TARGET_ID, "ocr")], served);
    expect(served.withRaster).not.toHaveBeenCalled();
    const fallback = deps({ nativeOcrPolicy: "prefer", nativePdfOcr: vi.fn(async () => null) });
    const res = await executeAssignments([request(4, NATIVE_PDF_OCR_FILL_TARGET_ID, "ocr")], fallback);
    expect(fallback.withRaster).toHaveBeenCalledTimes(1);
    expect(res.outputs[0]).toMatchObject({ text: "tess /tmp/p4.png", fallback: "ocr:tesseract" });
  });

  it("image-scoped OCR skips the page-wide engine and OCRs the image crop", async () => {
    const nativePdfOcr = vi.fn();
    const withCrop = vi.fn(async (raster: { path: string }, _bbox: unknown, fn: (crop: { path: string; mimeType: string }) => Promise<unknown>) =>
      await fn({ path: `${raster.path}.crop.png`, mimeType: "image/png" }));
    const d = deps({ nativePdfOcr, withCrop: withCrop as never });
    const bbox = { x: 10, y: 20, width: 100, height: 50 };
    const imageRequest = { ...request(2, NATIVE_PDF_OCR_TARGET_ID, "ocr"), assignment: { ...asg(2, NATIVE_PDF_OCR_TARGET_ID, "ocr"), scope: { kind: "image" as const, imageIndex: 0, bbox } } };
    const res = await executeAssignments([imageRequest], d);
    expect(nativePdfOcr).not.toHaveBeenCalled();
    expect(withCrop).toHaveBeenCalledWith(expect.objectContaining({ path: "/tmp/p2.png" }), bbox, expect.any(Function));
    expect(res.outputs[0]).toMatchObject({ text: "tess /tmp/p2.png.crop.png", fallback: "ocr:tesseract" });
  });

  describe("page OCR policy (tesseract primary, guarded engine OCR)", () => {
    const english = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? "The" : "quarterly report shows revenue")).join(" ");
    const latinNoise = Array.from({ length: 40 }, () => "RZBEFEEZNE HY ZHIMRAT XAAT").join(" ");
    const cjk = "契約書第一條委託範圍乙方應依本契約完成下列工作".repeat(30);
    const ocrResult = (markdown: string, over: Record<string, unknown> = {}) =>
      vi.fn(async () => ({ text: markdown, markdown, filledRegions: 1, engine: "ocr-model", latencyMs: 5, pageAreaIn2: 93.5, ...over }));

    it("scripts (default): tesseract serves pages it reads as words and the engine is not called", async () => {
      const nativePdfOcr = ocrResult(cjk);
      const d = deps({ nativePdfOcr, ocr: vi.fn(async () => ({ text: english, latencyMs: 30, model: "tesseract" })) });
      const res = await executeAssignments([request(1, NATIVE_PDF_OCR_TARGET_ID, "ocr")], d);
      expect(nativePdfOcr).not.toHaveBeenCalled();
      expect(res.outputs[0]).toMatchObject({ model: "tesseract", runtime: "tesseract" });
    });

    it("scripts: the engine serves a page in a script tesseract lacks", async () => {
      const d = deps({ nativePdfOcr: ocrResult(cjk), ocr: vi.fn(async () => ({ text: latinNoise, latencyMs: 30, model: "tesseract" })) });
      const res = await executeAssignments([request(1, NATIVE_PDF_OCR_TARGET_ID, "ocr")], d);
      expect(res.outputs[0]).toMatchObject({ text: cjk, model: "ocr-model", runtime: "native" });
    });

    it("scripts: Latin engine output never replaces tesseract", async () => {
      const d = deps({ nativePdfOcr: ocrResult(english), ocr: vi.fn(async () => ({ text: latinNoise, latencyMs: 30, model: "tesseract" })) });
      const res = await executeAssignments([request(1, NATIVE_PDF_OCR_TARGET_ID, "ocr")], d);
      expect(res.outputs[0]).toMatchObject({ text: latinNoise, model: "tesseract" });
    });

    it("off never calls the engine", async () => {
      const nativePdfOcr = ocrResult(cjk);
      const d = deps({ nativeOcrPolicy: "off", nativePdfOcr, ocr: vi.fn(async () => ({ text: latinNoise, latencyMs: 30, model: "tesseract" })) });
      await executeAssignments([request(1, NATIVE_PDF_OCR_TARGET_ID, "ocr")], d);
      expect(nativePdfOcr).not.toHaveBeenCalled();
    });

    it("prefer: output that lost most of the page's text layer is rejected for tesseract", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const d = deps({ nativeOcrPolicy: "prefer", nativePdfOcr: ocrResult("Abstract\n1. Introduction"), pageText: vi.fn(async () => english) });
      const res = await executeAssignments([request(1, NATIVE_PDF_OCR_TARGET_ID, "ocr")], d);
      expect(res.outputs[0]).toMatchObject({ model: "tesseract", fallback: "ocr:tesseract-dropout" });
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/rejected reason=below-text-layer/);
      warn.mockRestore();
    });

    it("prefer: sparse output on a page without a layer is cross-checked against tesseract", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const ocr = vi.fn(async () => ({ text: english, latencyMs: 30, model: "tesseract" }));
      const d = deps({ nativeOcrPolicy: "prefer", nativePdfOcr: ocrResult("Journal of Applied Biocatalysis 14 (2026)"), pageText: vi.fn(async () => null), ocr });
      const res = await executeAssignments([request(1, NATIVE_PDF_OCR_TARGET_ID, "ocr")], d);
      expect(ocr).toHaveBeenCalledTimes(1);
      expect(res.outputs[0]).toMatchObject({ text: english, fallback: "ocr:tesseract-dropout" });
      warn.mockRestore();
    });

    it("prefer: a dense engine result serves without a tesseract pass", async () => {
      const ocr = vi.fn();
      const dense = english.repeat(2);
      const d = deps({ nativeOcrPolicy: "prefer", nativePdfOcr: ocrResult(dense), pageText: vi.fn(async () => null), ocr: ocr as never });
      const res = await executeAssignments([request(1, NATIVE_PDF_OCR_TARGET_ID, "ocr")], d);
      expect(ocr).not.toHaveBeenCalled();
      expect(res.outputs[0]).toMatchObject({ model: "ocr-model", runtime: "native" });
    });
  });
});
