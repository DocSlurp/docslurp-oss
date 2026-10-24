import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Document } from "../models.js";
import { PdfRasterCache, PdfSourceCache, readRasterEngine } from "../pipeline/pdf-asset-cache.js";
import { imageDimensions, renderClipNative, renderPagesNative } from "./render.js";
import type { NativePdfEngine, NativePdfRenderOptions } from "./types.js";

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function fakeEngine(opts: { fail?: boolean } = {}) {
  const stats = { opens: 0, active: 0, maxActive: 0, renders: [] as Array<{ page: number } & NativePdfRenderOptions>, closed: 0 };
  const engine: NativePdfEngine = {
    id: "fake",
    version: () => ({ engine: "native-pdf", version: "0", gitSha: "x", features: [] }),
    async openPath() {
      stats.opens += 1;
      return {
        pageCount: async () => 10,
        metadata: async () => ({ encrypted: false }),
        close: async () => { stats.closed += 1; },
        page: (index: number) => ({
          size: async () => ({ widthPt: 612, heightPt: 792, rotation: 0 }),
          render: async (o: NativePdfRenderOptions) => {
            stats.active += 1;
            stats.maxActive = Math.max(stats.maxActive, stats.active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            stats.active -= 1;
            if (opts.fail) throw new Error("boom");
            stats.renders.push({ page: index + 1, ...o });
            return o.clip ? png(40, 30) : png(1275, 1650);
          },
        }) as any,
      };
    },
  };
  return { engine, stats };
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

describe("renderPagesNative", () => {
  it("renders each page once with bounded lanes, one handle per lane, and closes them", async () => {
    const { engine, stats } = fakeEngine();
    const out = await renderPagesNative(engine, "/x.pdf", [5, 1, 2, 3, 3, 4], { dpi: 150, concurrency: 2 });
    expect([...out.keys()]).toEqual([1, 2, 3, 4, 5].sort((a, b) => a - b).filter((n) => out.has(n)));
    expect(out.size).toBe(5);
    expect(stats.opens).toBe(2);
    expect(stats.closed).toBe(2);
    expect(stats.maxActive).toBeLessThanOrEqual(2);
    expect(out.get(1)).toMatchObject({ widthPx: 1275, heightPx: 1650, mimeType: "image/png" });
    expect(stats.renders.every((r) => r.dpi === 150 && r.format === "png")).toBe(true);
  });

  it("closes handles and rejects when a render fails", async () => {
    const { engine, stats } = fakeEngine({ fail: true });
    await expect(renderPagesNative(engine, "/x.pdf", [1, 2], { dpi: 150, concurrency: 2 })).rejects.toThrow();
    expect(stats.closed).toBe(stats.opens);
  });

  it("renders a clipped region in points", async () => {
    const { engine, stats } = fakeEngine();
    const clip = await renderClipNative(engine, "/x.pdf", 3, [10, 20, 100, 120], { dpi: 200 });
    expect(clip).toMatchObject({ pageNumber: 3, widthPx: 40, heightPx: 30 });
    expect(stats.renders[0]).toMatchObject({ page: 3, clip: [10, 20, 100, 120], dpi: 200 });
  });
});

describe("imageDimensions", () => {
  it("reads PNG and JPEG headers", () => {
    expect(imageDimensions(png(7, 9))).toEqual({ widthPx: 7, heightPx: 9 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x09, 0x00, 0x07, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageDimensions(jpeg)).toEqual({ widthPx: 7, heightPx: 9 });
    expect(imageDimensions(Buffer.from("nope"))).toEqual({ widthPx: null, heightPx: null });
  });
});

describe("PdfRasterCache with PDF_RASTER_ENGINE=native-pdf", () => {
  const document = { id: "d", userId: "u", runId: "r", filename: "a.pdf", mimeType: "application/pdf", sourceKey: "s/a.pdf",
    status: "processing", extractionMode: "auto", pageCount: 6, createdAt: new Date(), updatedAt: new Date() } as Document;

  async function setup(engine: NativePdfEngine | null) {
    const sources = new PdfSourceCache({
      async downloadToTempFile(_k: string, pattern: string) {
        const root = await mkdtemp(path.join(tmpdir(), "native-raster-"));
        roots.push(root);
        const file = path.join(root, pattern.replace("*", "f"));
        await writeFile(file, "pdf");
        return file;
      },
    } as any);
    const store = new Map<string, Uint8Array>();
    const storage = {
      objectSize: async (k: string) => store.get(k)?.byteLength ?? null,
      putBytes: async (k: string, b: Uint8Array) => { store.set(k, b); },
      uri: (k: string) => `s3://t/${k}`,
    };
    let pdftoppmCalls = 0;
    const runner = {
      async pdfPageSizes() { return { binary: "pdfinfo", args: [], available: true }; },
      async renderPdfPageRange(_s: string, prefix: string, first: number, last: number) {
        pdftoppmCalls += 1;
        return { binary: "pdftoppm", args: [prefix, String(first), String(last)], available: true };
      },
      async run(plan: { binary?: string; args: string[] }) {
        if (plan.binary === "pdfinfo") return { stdout: "Page 1 size: 612 x 792 pts", stderr: "" };
        const [prefix, a, b] = plan.args;
        for (let p = Number(a); p <= Number(b); p += 1) await writeFile(`${prefix}-${p}.png`, png(1275, 1650));
        return { stdout: "", stderr: "" };
      },
    };
    const cache = new PdfRasterCache(runner as any, storage as any, sources, {
      engine: "native-pdf",
      loadEngine: async () => engine,
      concurrency: 2,
    });
    return { cache, store, calls: () => pdftoppmCalls, sources };
  }

  it("renders with the engine, tags engine+dpi, uses a separate key space and reuses it", async () => {
    const { engine } = fakeEngine();
    const { cache, store, calls, sources } = await setup(engine);
    const first = await cache.renderSelectedPages({ document, runId: "r", pageNumbers: [2, 3] });
    expect(calls()).toBe(0);
    expect(first.map((p) => [p.engine, p.dpi, p.widthPx, p.heightPx, p.cacheHit])).toEqual([
      ["native-pdf", 150, 1275, 1650, false], ["native-pdf", 150, 1275, 1650, false]]);
    expect(first[0]!.artifactKey).toContain("/v2-150dpi-native-pdf/");
    expect(store.size).toBe(2);
    const second = await cache.renderSelectedPages({ document, runId: "r", pageNumbers: [2, 3] });
    expect(second.every((p) => p.cacheHit && p.engine === "native-pdf")).toBe(true);
    await sources.clear();
  });

  it("falls back to pdftoppm when the engine is absent or a render fails", async () => {
    const absent = await setup(null);
    const a = await absent.cache.renderSelectedPages({ document, runId: "r", pageNumbers: [1] });
    expect(a[0]).toMatchObject({ engine: "pdftoppm" });
    expect(a[0]!.artifactKey).toContain("/v2-150dpi/");
    await absent.sources.clear();

    const failing = await setup(fakeEngine({ fail: true }).engine);
    const b = await failing.cache.renderSelectedPages({ document, runId: "r", pageNumbers: [1, 2] });
    expect(b.map((p) => p.engine)).toEqual(["pdftoppm", "pdftoppm"]);
    expect(failing.calls()).toBe(2);
    await failing.sources.clear();
  });

  it("renderClip uses the engine and returns null when pdftoppm is active", async () => {
    const { engine } = fakeEngine();
    const on = await setup(engine);
    const clip = await on.cache.renderClip({ document, pageNumber: 1, clip: [0, 0, 50, 50], dpi: 200 });
    expect(clip).toMatchObject({ engine: "native-pdf", dpi: 200, widthPx: 40 });
    await on.sources.clear();
    const off = await setup(null);
    expect(await off.cache.renderClip({ document, pageNumber: 1, clip: [0, 0, 5, 5] })).toBeNull();
    await off.sources.clear();
  });

  it("parses PDF_RASTER_ENGINE", () => {
    expect(readRasterEngine(undefined)).toBe("pdftoppm");
    expect(readRasterEngine("Native-PDF")).toBe("native-pdf");
    expect(readRasterEngine("bogus")).toBe("pdftoppm");
  });
});
