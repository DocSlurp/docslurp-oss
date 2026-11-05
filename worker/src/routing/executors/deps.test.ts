import { fakeOcrRunner } from "../../test/fake-ocr.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { createProductionExecutorDeps } from "./deps.js";
import { RASTER_PX_PER_POINT } from "./merge.js";


function make(overrides: Record<string, unknown> = {}) {
  const getJson = vi.fn(async () => { throw new Error("not canonical"); });
  const deps = createProductionExecutorDeps({
    runId: "run",
    document: { id: "d", mimeType: "image/png", userId: "u", sourceKey: "k", pageCount: 1 } as never,
    storage: { bucket: "b", getJson, downloadToTempFile: vi.fn() } as never,
    rasters: { renderSelectedPages: vi.fn(async () => []), sourcePath: vi.fn(async () => "/tmp/x.pdf") },
    runner: { plan: vi.fn(), florence2: vi.fn(), run: vi.fn() } as never,
    canonicalUri: () => null,
    selection: {} as never,
    allow: async () => true,
    callVision: vi.fn() as never,
    recordLocalUsage: vi.fn(),
    recordOcrRead: vi.fn(),
    ...overrides,
  });
  return { deps };
}

describe("production executor deps", () => {
  it("crops page-point bboxes to raster pixels, clamped to the image", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "router-deps-"));
    const file = path.join(dir, "page.png");
    await sharp({ create: { width: 1275, height: 1650, channels: 3, background: "#fff" } }).png().toFile(file);
    const { deps } = make();
    const size = await deps.withCrop({ path: file, mimeType: "image/png" }, { x: 72, y: 144, width: 144, height: 72 }, async (crop) => {
      const meta = await sharp(crop.path).metadata();
      return [meta.width, meta.height];
    });
    expect(size).toEqual([Math.ceil(144 * RASTER_PX_PER_POINT), Math.ceil(72 * RASTER_PX_PER_POINT)]);
    const clamped = await deps.withCrop({ path: file, mimeType: "image/png" }, { x: 600, y: 780, width: 500, height: 500 }, async (crop) => {
      const meta = await sharp(crop.path).metadata();
      return [meta.width, meta.height];
    });
    expect(clamped![0]).toBeLessThanOrEqual(1275);
    expect(clamped![1]).toBeLessThanOrEqual(1650);
  });

  it("renders crops from a native clip when the raster cache serves one, and keeps the sharp crop when it returns null", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "router-deps-"));
    const file = path.join(dir, "page.png");
    await sharp({ create: { width: 1275, height: 1650, channels: 3, background: "#fff" } }).png().toFile(file);
    const png = await sharp({ create: { width: 50, height: 40, channels: 3, background: "#f00" } }).png().toBuffer();
    const renderClip = vi.fn(async () => ({ bytes: png, widthPx: 50, heightPx: 40, mimeType: "image/png", engine: "native-pdf" as const, dpi: 150 }));
    const { deps } = make({ rasters: { renderSelectedPages: vi.fn(async () => []), sourcePath: vi.fn(async () => "/tmp/x.pdf"), renderClip } });
    const size = await deps.withCrop({ path: file, mimeType: "image/png", pageNumber: 3 }, { x: 72, y: 144, width: 144, height: 72 }, async (crop) => {
      const meta = await sharp(crop.path).metadata();
      return [meta.width, meta.height];
    });
    expect(size).toEqual([50, 40]);
    expect(renderClip).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 3, clip: [72, 144, 216, 216], dpi: 150 }));
    const none = make({ rasters: { renderSelectedPages: vi.fn(async () => []), sourcePath: vi.fn(async () => "/tmp/x.pdf"), renderClip: vi.fn(async () => null) } }).deps;
    const fallback = await none.withCrop({ path: file, mimeType: "image/png", pageNumber: 3 }, { x: 72, y: 144, width: 144, height: 72 }, async (crop) => (await sharp(crop.path).metadata()).width);
    expect(fallback).toBe(Math.ceil(144 * RASTER_PX_PER_POINT));
    expect(await none.withPageClip!(3, { x: 0, y: 0, width: 10, height: 10 }, async () => "x")).toBeNull();
  });

  it("returns null text for unavailable canonical pages and non-pdf native extraction, and runs OCR in its VM and the labeler through the runner", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const dir = await mkdtemp(path.join(tmpdir(), "router-deps-"));
    const image = path.join(dir, "p.png");
    await writeFile(image, "x");
    const ocr = fakeOcrRunner(() => [{ frame: 1, text: "scanned words" }]);
    const run = vi.fn(async (plan: { args: string[]; sandboxedOcr?: unknown }) => {
      if (plan.sandboxedOcr) return await ocr.runner.run(plan as never);
      await writeFile(plan.args[plan.args.indexOf("--output") + 1]!, JSON.stringify({ text: " a red bridge " }));
      return { stdout: "", stderr: "" };
    });
    const plan = vi.fn(async (binary: string, ...args: string[]) => ({ binary, args, available: true }));
    const recordLocalUsage = vi.fn();
    const recordOcrRead = vi.fn();
    const { deps } = make({
      recordLocalUsage,
      recordOcrRead,
      runner: {
        run,
        plan,
        sandboxedOcrRead: ocr.runner.sandboxedOcrRead,
        localOcrRead: ocr.runner.localOcrRead,
        florence2: vi.fn(async (src: string, out: string, prompt: string, model: string) => ({ binary: "python3", args: ["--input", src, "--output", out, "--prompt", prompt, "--model", model], available: true })),
      },
    });
    expect(await deps.pageText(1)).toBeNull();
    expect(await deps.nativePageText("kreuzberg", 1)).toBeNull();
    expect((await deps.ocr({ path: image, mimeType: "image/png" }, { pageNumber: 7 })).text).toBe("scanned words");
    // The page went to the VM provider as a job; no OCR command was planned on the host.
    expect(ocr.runner.sandboxedOcrRead).toHaveBeenCalledTimes(1);
    expect(ocr.runner.localOcrRead).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    // Billed like every OCR read (recordOcrReads), under the document page, not as a local vision-runtime model.
    expect(recordOcrRead).toHaveBeenCalledTimes(1);
    expect(recordOcrRead.mock.calls[0]![0].pages.map((page: { pageNumber: number; text: string }) => [page.pageNumber, page.text])).toEqual([[7, "scanned words"]]);
    expect(recordLocalUsage).not.toHaveBeenCalledWith(expect.objectContaining({ metric: "page-ocr" }));
    const label = await deps.label({ path: image, mimeType: "image/png" }, { pageNumber: 3 });
    expect(label.text).toBe("a red bridge");
    expect(recordLocalUsage).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 3, metric: "image-label", model: "microsoft/Florence-2-small-ft" }));
    vi.unstubAllEnvs();
  });

  it("keeps a low-confidence router OCR read when escalation is off, billed as the OCR read it was", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const dir = await mkdtemp(path.join(tmpdir(), "router-deps-"));
    const image = path.join(dir, "p.png");
    await writeFile(image, "x");
    const ocr = fakeOcrRunner(() => [{ frame: 1, text: "ZXQ Vvv", meanConfidence: 0.4, image: true }]);
    const recordOcrRead = vi.fn();
    const read = vi.fn();
    const { deps } = make({ recordOcrRead, hostedReader: { read }, runner: { ...ocr.runner, plan: vi.fn(), florence2: vi.fn() } as never });
    expect(await deps.ocr({ path: image, mimeType: "image/png" }, { pageNumber: 4 })).toMatchObject({ text: "ZXQ Vvv", model: "ppocr-v6-small" });
    expect(recordOcrRead).toHaveBeenCalledTimes(1);
    // DOCSLURP_OCR_ESCALATION is not on: no hosted read, and no handoff to another reader.
    expect(read).not.toHaveBeenCalled();
    expect(ocr.jobs[0]!.escalation).toBeNull();
    vi.unstubAllEnvs();
  });

  it("sends a low-confidence router OCR read to the hosted escalation reader when escalation is on", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.stubEnv("DOCSLURP_OCR_ESCALATION", "on");
    const dir = await mkdtemp(path.join(tmpdir(), "router-deps-"));
    const image = path.join(dir, "p.png");
    await writeFile(image, "x");
    const ocr = fakeOcrRunner(() => [{ frame: 1, text: "ZXQ Vvv", meanConfidence: 0.4, image: true }]);
    const read = vi.fn(async (page: { pageNumber: number }) => ({ text: `Clear text of page ${page.pageNumber}`, model: "hosted-ocr-model" }));
    const { deps } = make({ hostedReader: { read }, runner: { ...ocr.runner, plan: vi.fn(), florence2: vi.fn() } as never });
    expect(await deps.ocr({ path: image, mimeType: "image/png" }, { pageNumber: 4 })).toMatchObject({ text: "Clear text of page 4", model: "hosted-ocr-model" });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ documentId: "d", pageNumber: 4, mimeType: "image/png" }), "ocr-escalation", undefined);
    vi.unstubAllEnvs();
  });

  it("keeps the recogniser's read when the escalation reader skips the page (budget, refusal)", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.stubEnv("DOCSLURP_OCR_ESCALATION", "on");
    const { HostedOcrSkipped } = await import("../../ocr/hosted-reader.js");
    const dir = await mkdtemp(path.join(tmpdir(), "router-deps-"));
    const image = path.join(dir, "p.png");
    await writeFile(image, "x");
    const ocr = fakeOcrRunner(() => [{ frame: 1, text: "ZXQ Vvv", meanConfidence: 0.4, image: true }]);
    const read = vi.fn(async () => { throw new HostedOcrSkipped("budget", "over budget"); });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { deps } = make({ hostedReader: { read }, runner: { ...ocr.runner, plan: vi.fn(), florence2: vi.fn() } as never });
    expect((await deps.ocr({ path: image, mimeType: "image/png" }, { pageNumber: 4 })).text).toBe("ZXQ Vvv");
    expect(read).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  it("treats OCR off as an empty read, never a host command", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "off");
    const ocr = fakeOcrRunner(() => []);
    const { deps } = make({ runner: { ...ocr.runner, plan: vi.fn(), florence2: vi.fn() } as never });
    expect((await deps.ocr({ path: "/nonexistent.png", mimeType: "image/png" }, { pageNumber: 2 })).text).toBe("");
    expect(ocr.runner.run).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
