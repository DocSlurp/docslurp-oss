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
    runner: { tesseractOcr: vi.fn(), florence2: vi.fn(), run: vi.fn() } as never,
    canonicalUri: () => null,
    selection: {} as never,
    allow: async () => true,
    callVision: vi.fn() as never,
    recordLocalUsage: vi.fn(),
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

  it("returns null text for unavailable canonical pages and non-pdf native extraction, and runs tesseract and the labeler through the runner", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "router-deps-"));
    const image = path.join(dir, "p.png");
    await writeFile(image, "x");
    const run = vi.fn(async (plan: { args: string[] }) => {
      if (plan.args.includes("--prompt")) await writeFile(plan.args[plan.args.indexOf("--output") + 1]!, JSON.stringify({ text: " a red bridge " }));
      else await writeFile(`${plan.args[1]}.txt`, " scanned words \n");
      return { stdout: "", stderr: "" };
    });
    const recordLocalUsage = vi.fn();
    const { deps } = make({
      recordLocalUsage,
      runner: {
        run,
        tesseractOcr: vi.fn(async (src: string, base: string) => ({ binary: "tesseract", args: [src, base], available: true })),
        florence2: vi.fn(async (src: string, out: string, prompt: string, model: string) => ({ binary: "python3", args: ["--input", src, "--output", out, "--prompt", prompt, "--model", model], available: true })),
       
      },
    });
    expect(await deps.pageText(1)).toBeNull();
    expect(await deps.nativePageText("kreuzberg", 1)).toBeNull();
    expect((await deps.ocr({ path: image, mimeType: "image/png" }, { pageNumber: 1 })).text).toBe("scanned words");
    const label = await deps.label({ path: image, mimeType: "image/png" }, { pageNumber: 3 });
    expect(label.text).toBe("a red bridge");
    expect(recordLocalUsage).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 3, metric: "image-label", model: "microsoft/Florence-2-small-ft" }));
  });

  it("tells Tesseract the render DPI of a WebP page, which carries none, and keeps it on crops", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-router-deps-"));
    const webp = path.join(dir, "page.webp");
    await sharp({ create: { width: 300, height: 200, channels: 3, background: "#ffffff" } }).webp({ lossless: true }).toFile(webp);
    const tesseractOcr = vi.fn(async (src: string, base: string) => ({ binary: "tesseract", args: [src, base], available: true }));
    const run = vi.fn(async (plan: { args: string[] }) => { await writeFile(`${plan.args[1]}.txt`, "words"); return { stdout: "", stderr: "" }; });
    const { deps } = make({
      document: { id: "d", mimeType: "application/pdf", userId: "u", sourceKey: "k", pageCount: 1 } as never,
      storage: { bucket: "b", getJson: vi.fn(), downloadToTempFile: vi.fn(async () => webp) } as never,
      rasters: {
        renderSelectedPages: vi.fn(async () => [{ pageNumber: 1, artifactKey: "k/page-1.webp", artifactUri: "s3://b/k", widthPx: 300, heightPx: 200, sizeBytes: 1, cacheHit: true, mimeType: "image/webp", dpi: 150 }]),
        sourcePath: vi.fn(async () => "/tmp/x.pdf"),
      },
      runner: { run, tesseractOcr, florence2: vi.fn() },
    });
    // PNG rasters keep their own pHYs density; nothing is passed.
    await deps.ocr({ path: webp, mimeType: "image/png" }, { pageNumber: 1 });
    expect((tesseractOcr.mock.calls[0] as unknown[])[3]).toBeUndefined();
    tesseractOcr.mockClear();
    await deps.withRaster(1, async (raster) => {
      expect(raster).toMatchObject({ mimeType: "image/webp", dpi: 150 });
      await deps.ocr(raster, { pageNumber: 1 });
      await deps.withCrop({ ...raster, pageNumber: undefined }, { x: 0, y: 0, width: 50, height: 50 }, async (crop) => {
        expect(crop).toMatchObject({ mimeType: "image/png", dpi: 150 });
        await deps.ocr(crop, { pageNumber: 1 });
      });
    });
    expect(tesseractOcr.mock.calls.map((call) => (call as unknown[])[3])).toEqual([150, 150]);
  });
});
