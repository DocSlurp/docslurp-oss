import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Document } from "../models.js";
import {
  PdfRasterCache,
  PdfSourceCache,
  contiguousPageRanges,
  normalizePageNumbers,
} from "../pipeline/pdf-asset-cache.js";
import { selectRasterPagesFromClassification } from "../stages/render-images.js";

const tempRoots: string[] = [];

function makeDocument(): Document {
  return {
    id: "doc-1",
    userId: "user-1",
    runId: "run-1",
    filename: "sample.pdf",
    mimeType: "application/pdf",
    sourceKey: "sources/sample.pdf",
    status: "processing",
    extractionMode: "auto",
    pageCount: 6,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PdfSourceCache", () => {
  it("downloads and hashes a source once for concurrent and subsequent consumers", async () => {
    let downloads = 0;
    const storage = {
      async downloadToTempFile(_key: string, pattern: string) {
        downloads += 1;
        const root = await mkdtemp(path.join(tmpdir(), "source-cache-test-"));
        tempRoots.push(root);
        const filePath = path.join(root, pattern.replace("*", "fixture"));
        await writeFile(filePath, "same pdf bytes");
        return filePath;
      },
    };
    const cache = new PdfSourceCache(storage as any, 2);

    const [first, concurrent] = await Promise.all([
      cache.get(makeDocument()),
      cache.get(makeDocument()),
    ]);
    const later = await cache.get(makeDocument());

    expect(downloads).toBe(1);
    expect(first.sha256).toBe(concurrent.sha256);
    expect(later.path).toBe(first.path);
    expect(first.cacheHit).toBe(false);
    expect(concurrent.cacheHit).toBe(true);
    expect(later.cacheHit).toBe(true);
    await cache.clear();
  });

  it("renders only ready triage pages that need visual evidence", () => {
    expect(selectRasterPagesFromClassification({
      status: "ready",
      documentId: "doc-1",
      label: "mixed",
      confidence: 0.8,
      signals: [],
      suggestedPlaybook: "balanced",
      documentComplexity: "mixed",
      dominantRoutes: ["straightforward-text", "chart-or-figure", "table-heavy"],
      visionPolicy: "selective",
      specializedContentSummary: [],
      evidence: {
        source: "canonical-document",
        artifactUri: "s3://test/canonical.json",
        characterCount: 1000,
        pageCount: 3,
      },
      pages: [
        { pageNumber: 1, route: "straightforward-text", confidence: 0.95, textDensityScore: 0.9, signals: [], extractorHint: "cheap-text", specializedContent: [] },
        { pageNumber: 2, route: "chart-or-figure", confidence: 0.8, textDensityScore: 0.5, signals: [], extractorHint: "vision-rescue", specializedContent: [] },
        { pageNumber: 3, route: "table-heavy", confidence: 0.6, textDensityScore: 0.5, signals: [], extractorHint: "layout-aware", specializedContent: [] },
      ],
    })).toEqual([2, 3]);
    expect(selectRasterPagesFromClassification({ status: "deferred", pages: [] })).toEqual([]);
  });
});

describe("PdfRasterCache", () => {
  it("stores native image documents without invoking the PDF renderer", async () => {
    const sourceStorage = {
      async downloadToTempFile(_key: string, pattern: string) {
        const root = await mkdtemp(path.join(tmpdir(), "image-source-test-"));
        tempRoots.push(root);
        const filePath = path.join(root, pattern.replace("*", "fixture"));
        await writeFile(filePath, "jpeg bytes");
        return filePath;
      },
    };
    const artifacts = new Map<string, { bytes: Uint8Array; mimeType: string }>();
    const storage = {
      async objectSize(key: string) { return artifacts.get(key)?.bytes.byteLength ?? null; },
      async putBytes(key: string, bytes: Uint8Array, mimeType: string) {
        artifacts.set(key, { bytes, mimeType });
      },
      uri(key: string) { return `s3://test/${key}`; },
    };
    const runner = {
      async pdfPageSizes() { return { binary: "pdfinfo", args: [], available: true }; },
      async renderPdfPageRange() { throw new Error("PDF renderer must not run"); },
      async run() { throw new Error("command runner must not run"); },
    };
    const sourceCache = new PdfSourceCache(sourceStorage as any);
    const cache = new PdfRasterCache(runner as any, storage as any, sourceCache);
    const document = {
      ...makeDocument(),
      filename: "sample.jpg",
      mimeType: "image/jpeg",
      sourceKey: "sources/sample.jpg",
      pageCount: 1,
    };

    const onRenderedPage = vi.fn(async (page) => {
      expect(artifacts.get(page.artifactKey)?.bytes).toBe(page.bytes);
      expect(page.bytes.toString()).toBe("jpeg bytes");
      expect(page.engine).toBeUndefined();
      expect(page.dpi).toBeUndefined();
    });
    const [page] = await cache.renderSelectedPages({
      document,
      runId: "run-1",
      pageNumbers: [1],
      onRenderedPage,
    });
    expect(onRenderedPage).toHaveBeenCalledOnce();
    await cache.renderSelectedPages({ document, runId: "run-1", pageNumbers: [1], onRenderedPage });
    expect(onRenderedPage).toHaveBeenCalledOnce();

    expect(page.mimeType).toBe("image/jpeg");
    expect(page.artifactKey).toMatch(/page-1\.jpg$/);
    expect(artifacts.get(page.artifactKey)?.mimeType).toBe("image/jpeg");
    expect(page.sizeBytes).toBe(10);
    await sourceCache.clear();
  });

  it.each([1, 2, 3])("reuses requested raster pages with %i-digit Poppler filenames", async (digits) => {
    const sourceStorage = {
      async downloadToTempFile(_key: string, pattern: string) {
        const root = await mkdtemp(path.join(tmpdir(), "raster-source-test-"));
        tempRoots.push(root);
        const filePath = path.join(root, pattern.replace("*", "fixture"));
        await writeFile(filePath, "pdf bytes");
        return filePath;
      },
    };
    const artifacts = new Map<string, Uint8Array>();
    const storage = {
      async objectSize(key: string) { return artifacts.get(key)?.byteLength ?? null; },
      async putBytes(key: string, bytes: Uint8Array) { artifacts.set(key, bytes); },
      uri(key: string) { return `s3://test/${key}`; },
    };
    const ranges: Array<[number, number]> = [];
    const runner = {
      async pdfPageSizes() { return { binary: "pdfinfo", args: [], available: true }; },
      async renderPdfPageRange(_source: string, prefix: string, first: number, last: number) {
        ranges.push([first, last]);
        return { binary: "pdftoppm", args: [prefix, String(first), String(last)], available: true };
      },
      async run(plan: { binary?: string; args: string[] }) {
        if (plan.binary === "pdfinfo") return { stdout: "Page 1 size: 612 x 792 pts", stderr: "" };
        const [prefix, firstText, lastText] = plan.args;
        for (let page = Number(firstText); page <= Number(lastText); page += 1) {
          await writeFile(`${prefix}-${String(page).padStart(digits, "0")}.png`, `page ${page}`);
        }
        return { stdout: "", stderr: "" };
      },
    };
    const sourceCache = new PdfSourceCache(sourceStorage as any);
    const cache = new PdfRasterCache(runner as any, storage as any, sourceCache);

    const onRenderedPage = vi.fn(async (page) => {
      expect(artifacts.get(page.artifactKey)).toBe(page.bytes);
      expect(page.bytes.toString()).toBe(`page ${page.pageNumber}`);
      expect(page).toMatchObject({ mimeType: "image/png", engine: "pdftoppm", dpi: 150 });
    });
    const first = await cache.renderSelectedPages({
      document: makeDocument(),
      runId: "run-1",
      pageNumbers: [5, 2, 3, 3, 99],
      onRenderedPage,
    });
    const second = await cache.renderSelectedPages({
      document: makeDocument(),
      runId: "run-1",
      pageNumbers: [2, 3, 5],
      onRenderedPage,
    });
    expect(onRenderedPage.mock.calls.map(([page]) => page.pageNumber)).toEqual([2, 3, 5]);

    expect(ranges).toEqual([[2, 2], [3, 3], [5, 5]]);
    expect(first.map((page) => page.pageNumber)).toEqual([2, 3, 5]);
    expect(first.every((page) => !page.cacheHit)).toBe(true);
    expect(second.every((page) => page.cacheHit)).toBe(true);
    expect(artifacts.size).toBe(3);
    expect(first.map((page) => page.sizeBytes)).toEqual([6, 6, 6]);
    expect(second.map((page) => page.sizeBytes)).toEqual([6, 6, 6]);
    await sourceCache.clear();
  });

  it("normalizes page requests and batches contiguous pages", () => {
    expect(normalizePageNumbers([4, 2, 2, 0, 8], 5)).toEqual([2, 4]);
    expect(contiguousPageRanges([7, 2, 3, 4, 9])).toEqual([
      { first: 2, last: 4 },
      { first: 7, last: 7 },
      { first: 9, last: 9 },
    ]);
  });
});
