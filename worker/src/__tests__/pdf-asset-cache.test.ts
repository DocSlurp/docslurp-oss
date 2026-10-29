import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Document } from "../models.js";
import {
  PdfRasterCache,
  PdfSourceCache,
  contiguousPageRanges,
  PDFTOPPM_CONCURRENCY_MAX,
  Semaphore,
  defaultPdftoppmConcurrency,
  defaultPdftoppmProcessConcurrency,
  normalizePageNumbers,
  parsePdfPageSizes,
  runLanes,
} from "../pipeline/pdf-asset-cache.js";
import { spawnContained } from "../sandbox/teardown.js";
import { CommandRunner } from "../tools/runner.js";
import { selectRasterPagesFromClassification } from "../stages/render-images.js";

/** pdfinfo -f/-l output: the "Pages:" line, then one numbered size line per page. */
function pdfinfoSizes(first: number, last: number): string {
  return [`Pages:           ${last}`, "Encrypted:       no", ...Array.from({ length: last - first + 1 }, (_, i) => `Page ${String(first + i).padStart(4)} size: 612 x 792 pts (letter)`)].join("\n");
}

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
      async pdfPageSizes(_source: string, first: number, last: number) { return { binary: "pdfinfo", args: [String(first), String(last)], available: true }; },
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

    const [page] = await cache.renderSelectedPages({
      document,
      runId: "run-1",
      pageNumbers: [1],
    });

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
      async pdfPageSizes(_source: string, first: number, last: number) { return { binary: "pdfinfo", args: [String(first), String(last)], available: true }; },
      async renderPdfPageRange(_source: string, prefix: string, first: number, last: number) {
        ranges.push([first, last]);
        return { binary: "pdftoppm", args: [prefix, String(first), String(last)], available: true };
      },
      async run(plan: { binary?: string; args: string[] }) {
        if (plan.binary === "pdfinfo") return { stdout: pdfinfoSizes(Number(plan.args[0]), Number(plan.args[1])), stderr: "" };
        const [prefix, firstText, lastText] = plan.args;
        for (let page = Number(firstText); page <= Number(lastText); page += 1) {
          await writeFile(`${prefix}-${String(page).padStart(digits, "0")}.png`, `page ${page}`);
        }
        return { stdout: "", stderr: "" };
      },
    };
    const sourceCache = new PdfSourceCache(sourceStorage as any);
    const cache = new PdfRasterCache(runner as any, storage as any, sourceCache);

    const first = await cache.renderSelectedPages({
      document: makeDocument(),
      runId: "run-1",
      pageNumbers: [5, 2, 3, 3, 99],
    });
    const second = await cache.renderSelectedPages({
      document: makeDocument(),
      runId: "run-1",
      pageNumbers: [2, 3, 5],
    });

    // Lanes create their own directories first, so they reach the planner in any order.
    expect(ranges.sort((a, b) => a[0] - b[0])).toEqual([[2, 2], [3, 3], [5, 5]]);
    expect(first.map((page) => page.pageNumber)).toEqual([2, 3, 5]);
    expect(first.every((page) => !page.cacheHit)).toBe(true);
    expect(second.every((page) => page.cacheHit)).toBe(true);
    expect(artifacts.size).toBe(3);
    expect(first.map((page) => page.sizeBytes)).toEqual([6, 6, 6]);
    expect(second.map((page) => page.sizeBytes)).toEqual([6, 6, 6]);
    await sourceCache.clear();
  });

  it("sizes each contiguous run with one pdfinfo call and renders pages in bounded parallel lanes", async () => {
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
    const calls: string[] = [];
    let active = 0;
    let peak = 0;
    const runner = {
      async pdfPageSizes(_source: string, first: number, last: number) { return { binary: "pdfinfo", args: [String(first), String(last)], available: true }; },
      async renderPdfPageRange(_source: string, prefix: string, first: number, last: number, dpi: number, edge: number) {
        return { binary: "pdftoppm", args: [prefix, String(first), String(last), String(dpi), String(edge)], available: true };
      },
      async run(plan: { binary?: string; args: string[] }) {
        calls.push(`${plan.binary}:${plan.args.slice(1).join(",")}`);
        if (plan.binary === "pdfinfo") return { stdout: pdfinfoSizes(Number(plan.args[0]), Number(plan.args[1])), stderr: "" };
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        const [prefix, firstText] = plan.args;
        await writeFile(`${prefix}-${firstText}.png`, `page ${firstText}`);
        return { stdout: "", stderr: "" };
      },
    };
    const sourceCache = new PdfSourceCache(sourceStorage as any);
    const cache = new PdfRasterCache(runner as any, storage as any, sourceCache, { pdftoppmConcurrency: 3 });
    const pages = await cache.renderSelectedPages({ document: { ...makeDocument(), pageCount: 20 }, runId: "run-1", pageNumbers: [9, 2, 4, 7, 5, 11] });

    expect(calls.filter((call) => call.startsWith("pdfinfo")).sort()).toEqual(["pdfinfo:11", "pdfinfo:2", "pdfinfo:5", "pdfinfo:7", "pdfinfo:9"]);
    // Same per-page command (page, DPI, bounded edge) as the sequential path.
    expect(calls.filter((call) => call.startsWith("pdftoppm")).sort()).toEqual(
      [2, 4, 5, 7, 9, 11].map((page) => `pdftoppm:${page},${page},150,1650`).sort(),
    );
    expect(peak).toBe(3);
    expect(pages.map((page) => page.pageNumber)).toEqual([2, 4, 5, 7, 9, 11]);
    expect(pages.map((page) => page.sizeBytes)).toEqual([6, 6, 6, 6, 6, 7]);
    await sourceCache.clear();
  });

  it("stops every lane on the first failed page and drains them before failing", async () => {
    const sourceStorage = {
      async downloadToTempFile(_key: string, pattern: string) {
        const root = await mkdtemp(path.join(tmpdir(), "raster-source-test-"));
        tempRoots.push(root);
        const filePath = path.join(root, pattern.replace("*", "fixture"));
        await writeFile(filePath, "pdf bytes");
        return filePath;
      },
    };
    const storage = { async objectSize() { return null; }, async putBytes() {}, uri(key: string) { return `s3://test/${key}`; } };
    const started: number[] = [];
    let running = 0;
    const runner = {
      async pdfPageSizes(_source: string, first: number, last: number) { return { binary: "pdfinfo", args: [String(first), String(last)], available: true }; },
      async renderPdfPageRange(_source: string, prefix: string, first: number) { return { binary: "pdftoppm", args: [prefix, String(first)], available: true }; },
      async run(plan: { binary?: string; args: string[] }) {
        if (plan.binary === "pdfinfo") return { stdout: pdfinfoSizes(Number(plan.args[0]), Number(plan.args[1])), stderr: "" };
        const page = Number(plan.args[1]);
        started.push(page);
        running += 1;
        try {
          await new Promise((resolve) => setTimeout(resolve, page === 1 ? 1 : 20));
          if (page === 1) throw new Error("pdftoppm crashed");
          await writeFile(`${plan.args[0]}-${page}.png`, "x");
          return { stdout: "", stderr: "" };
        } finally {
          running -= 1;
        }
      },
    };
    const sourceCache = new PdfSourceCache(sourceStorage as any);
    const cache = new PdfRasterCache(runner as any, storage as any, sourceCache, { pdftoppmConcurrency: 2 });
    await expect(cache.renderSelectedPages({ document: { ...makeDocument(), pageCount: 10 }, runId: "run-1", pageNumbers: [1, 2, 3, 4, 5, 6] }))
      .rejects.toThrow("pdftoppm crashed");
    expect(running).toBe(0);
    expect(started).toEqual([1, 2]);
    await sourceCache.clear();
  });

  it("refuses to render a page pdfinfo did not size", async () => {
    const head = "Title:          t\nPages:          9\nEncrypted:      no\n";
    expect(parsePdfPageSizes(`${head}Page    3 size: 595.28 x 841.89 pts (A4)\nPage    5 size: 612 x 792 pts`, 3, 5))
      .toEqual(new Map([[3, { widthPt: 595.28, heightPt: 841.89 }], [5, { widthPt: 612, heightPt: 792 }]]));
    expect(parsePdfPageSizes(`${head}Page size: 612 x 792 pts`, 4, 4)).toEqual(new Map([[4, { widthPt: 612, heightPt: 792 }]]));
    // The unnumbered form is ambiguous across a range; out-of-range numbered lines are ignored.
    expect(parsePdfPageSizes(`${head}Page size: 612 x 792 pts\nPage    9 size: 1 x 1 pts`, 4, 6).size).toBe(0);
    // Without the "Pages:" line nothing counts.
    expect(parsePdfPageSizes("Page    3 size: 612 x 792 pts", 3, 3).size).toBe(0);
  });

  it("ignores size lines a document title injects before the Pages line", () => {
    // A title can hold newlines and size-looking text; pdfinfo prints it before "Pages:".
    const injected = [
      "Title:          Page    3 size: 99999 x 99999 pts",
      "Page    3 size: 99999 x 99999 pts",
      "Page size: 99999 x 99999 pts",
      "Pages:          1",
      "Subject:        x Page    3 size: 88888 x 88888 pts",
      "Pages:          12",
      "Encrypted:      no",
      "Page    3 size: 612 x 792 pts (letter)",
      "File size:      1234 bytes",
    ].join("\n");
    expect(parsePdfPageSizes(injected, 3, 3)).toEqual(new Map([[3, { widthPt: 612, heightPt: 792 }]]));
    // Only the last "Pages:" line starts the size block: a title that injects its own "Pages:" line and a fake
    // size after it must lose to the real size pdfinfo prints after its own, later "Pages:" line.
    const injectedPagesLine = [
      "Title:          x",
      "Pages:          1",
      "Page    3 size: 99999 x 99999 pts",
      "Producer:       y",
      "Pages:          12",
      "Page    3 size: 595.28 x 841.89 pts (A4)",
    ].join("\n");
    expect(parsePdfPageSizes(injectedPagesLine, 3, 3)).toEqual(new Map([[3, { widthPt: 595.28, heightPt: 841.89 }]]));
    // A title-only size line with no real one after "Pages:" sizes nothing (the render then refuses).
    expect(parsePdfPageSizes("Title: a\nPage    3 size: 99999 x 99999 pts\nPages:  3\nEncrypted: no", 3, 3).size).toBe(0);
  });

  it("caps pdftoppm lanes with PDF_PDFTOPPM_CONCURRENCY (default 2, at most 4), independent of native lanes", () => {
    expect(defaultPdftoppmConcurrency({})).toBe(2);
    expect(defaultPdftoppmConcurrency({ PDF_RASTER_CONCURRENCY: "32" })).toBe(2);
    expect(defaultPdftoppmConcurrency({ PDF_PDFTOPPM_CONCURRENCY: "3" })).toBe(3);
    expect(defaultPdftoppmConcurrency({ PDF_PDFTOPPM_CONCURRENCY: "32" })).toBe(PDFTOPPM_CONCURRENCY_MAX);
    expect(PDFTOPPM_CONCURRENCY_MAX).toBe(4);
    for (const value of ["0", "-1", "x"]) expect(defaultPdftoppmConcurrency({ PDF_PDFTOPPM_CONCURRENCY: value })).toBe(2);
    expect(defaultPdftoppmProcessConcurrency({})).toBe(8);
    expect(defaultPdftoppmProcessConcurrency({ PDF_PDFTOPPM_PROCESS_CONCURRENCY: "3" })).toBe(3);
    expect(defaultPdftoppmProcessConcurrency({ PDF_PDFTOPPM_PROCESS_CONCURRENCY: "1000" })).toBe(32);
  });

  it("holds the slot and scratch until an aborted sibling's real process tree exits, escalating to SIGKILL", async () => {
    const sourceStorage = {
      async downloadToTempFile(_key: string, pattern: string) {
        const root = await mkdtemp(path.join(tmpdir(), "raster-source-test-"));
        tempRoots.push(root);
        const filePath = path.join(root, pattern.replace("*", "fixture"));
        await writeFile(filePath, "pdf bytes");
        return filePath;
      },
    };
    const uploads: string[] = [];
    const storage = { async objectSize() { return null; }, async putBytes(key: string) { uploads.push(key); }, uri(key: string) { return `s3://test/${key}`; } };
    const pidRoot = await mkdtemp(path.join(tmpdir(), "raster-abort-test-"));
    tempRoots.push(pidRoot);
    const pidFile = path.join(pidRoot, "pids");
    // A parser wrapper and its child that both ignore SIGTERM, like a launcher whose parser keeps running.
    const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const parser = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}, process.argv[1]], { stdio: "ignore" });
      child.on("spawn", () => writeFileSync(process.argv[1], process.pid + " " + child.pid));
      setInterval(() => {}, 1000);
    `;
    const slots = new Semaphore(4);
    let scratch = "";
    let failedAt = 0;
    let treePids: number[] = [];
    let exit: { at: number; signal: NodeJS.Signals | null; slotsInUse: number; scratchPresent: boolean } | null = null;
    const commands = new CommandRunner({
      openSession: async () => ({
        providerId: "test-local",
        isolation: { filesystem: false, network: "none", processes: true, location: "local" },
        spawn: (command) => {
          const child = spawnContained(command.binary, command.args, { env: command.env, containment: "pid-namespace" });
          child.once("exit", (_code, exitSignal) => {
            exit = { at: Date.now(), signal: exitSignal, slotsInUse: slots.inUse, scratchPresent: existsSync(scratch) };
          });
          return child;
        },
        close: async () => {},
      }),
    });
    const runner = {
      async pdfPageSizes(_source: string, first: number, last: number) { return { binary: "pdfinfo", args: [String(first), String(last)], available: true }; },
      async renderPdfPageRange(_source: string, prefix: string, first: number) { return { binary: "pdftoppm", args: [prefix, String(first)], available: true }; },
      async run(plan: { binary?: string; args: string[] }, signal?: AbortSignal) {
        if (plan.binary === "pdfinfo") return { stdout: pdfinfoSizes(Number(plan.args[0]), Number(plan.args[1])), stderr: "" };
        if (Number(plan.args[1]) === 2) {
          scratch = path.dirname(plan.args[0]!);
          return await commands.run({ binary: process.execPath, args: ["-e", parser, pidFile], available: true }, signal);
        }
        // Fail only once the sibling's whole tree is running.
        while (!existsSync(pidFile) || (await readFile(pidFile, "utf8")).split(" ").length < 2) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        // The parser runs in its own PID namespace, so the pids it wrote are namespace pids: find the
        // tree's host pids by the pid-file path both processes carry in argv.
        treePids = hostPidsWithArg(pidFile);
        failedAt = Date.now();
        throw new Error("pdftoppm crashed");
      },
    };
    const graceMs = 300;
    const previousGrace = process.env.WORKER_COMMAND_ABORT_GRACE_MS;
    process.env.WORKER_COMMAND_ABORT_GRACE_MS = String(graceMs);
    const sourceCache = new PdfSourceCache(sourceStorage as any);
    try {
      const cache = new PdfRasterCache(runner as any, storage as any, sourceCache, { pdftoppmConcurrency: 2, rasterSlots: slots });
      await expect(cache.renderSelectedPages({ document: { ...makeDocument(), pageCount: 10 }, runId: "run-1", pageNumbers: [1, 2] }))
        .rejects.toThrow("pdftoppm crashed");
    } finally {
      if (previousGrace === undefined) delete process.env.WORKER_COMMAND_ABORT_GRACE_MS;
      else process.env.WORKER_COMMAND_ABORT_GRACE_MS = previousGrace;
      await sourceCache.clear();
    }
    expect(treePids).toHaveLength(2);
    const [parserPid, grandchildPid] = treePids;
    // The parser ignored SIGTERM, so it only exited when the grace period ran out and SIGKILL followed.
    expect(exit).not.toBeNull();
    expect(exit!.signal).toBe("SIGKILL");
    expect(exit!.at - failedAt).toBeGreaterThanOrEqual(graceMs - 50);
    expect(exit!.at - failedAt).toBeLessThan(graceMs + 2_000);
    // Until then the aborted lane still held its slot and its scratch was still on disk.
    expect(exit!.slotsInUse).toBeGreaterThanOrEqual(1);
    expect(exit!.scratchPresent).toBe(true);
    // Nothing of the tree survives the render: both processes are gone, the slot is free and scratch removed.
    for (const pid of [parserPid!, grandchildPid!]) expect(() => process.kill(pid, 0)).toThrow();
    expect(slots.inUse).toBe(0);
    expect(existsSync(scratch)).toBe(false);
    expect(uploads).toEqual([]);
  }, 15_000);

  it("uploads nothing from a lane whose command finished after a sibling failed", async () => {
    const sourceStorage = {
      async downloadToTempFile(_key: string, pattern: string) {
        const root = await mkdtemp(path.join(tmpdir(), "raster-source-test-"));
        tempRoots.push(root);
        const filePath = path.join(root, pattern.replace("*", "fixture"));
        await writeFile(filePath, "pdf bytes");
        return filePath;
      },
    };
    const uploads: string[] = [];
    const storage = { async objectSize() { return null; }, async putBytes(key: string) { uploads.push(key); }, uri(key: string) { return `s3://test/${key}`; } };
    let releaseSibling!: () => void;
    const siblingMayFail = new Promise<void>((resolve) => { releaseSibling = resolve; });
    let finishedAfterAbort = false;
    const runner = {
      async pdfPageSizes(_source: string, first: number, last: number) { return { binary: "pdfinfo", args: [String(first), String(last)], available: true }; },
      async renderPdfPageRange(_source: string, prefix: string, first: number) { return { binary: "pdftoppm", args: [prefix, String(first)], available: true }; },
      async run(plan: { binary?: string; args: string[] }, signal?: AbortSignal) {
        if (plan.binary === "pdfinfo") return { stdout: pdfinfoSizes(Number(plan.args[0]), Number(plan.args[1])), stderr: "" };
        if (Number(plan.args[1]) === 2) {
          await siblingMayFail;
          throw new Error("pdftoppm crashed");
        }
        // This command completes successfully with its page written, but only after the sibling failed.
        await writeFile(`${plan.args[0]}-${plan.args[1]}.png`, "x");
        releaseSibling();
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        finishedAfterAbort = true;
        return { stdout: "", stderr: "" };
      },
    };
    const sourceCache = new PdfSourceCache(sourceStorage as any);
    const cache = new PdfRasterCache(runner as any, storage as any, sourceCache, { pdftoppmConcurrency: 2, rasterSlots: new Semaphore(4) });
    await expect(cache.renderSelectedPages({ document: { ...makeDocument(), pageCount: 10 }, runId: "run-1", pageNumbers: [1, 2] }))
      .rejects.toThrow("pdftoppm crashed");
    expect(finishedAfterAbort).toBe(true);
    expect(uploads).toEqual([]);
    await sourceCache.clear();
  });

  it("runs every item on one lane when the lane count is not a positive finite number", async () => {
    for (const lanes of [Number.NaN, 0, -2, Number.POSITIVE_INFINITY]) {
      const seen: number[] = [];
      await runLanes([1, 2, 3], lanes, undefined, async (item) => { seen.push(item); });
      expect(seen).toEqual([1, 2, 3]);
    }
    const sourceStorage = {
      async downloadToTempFile(_key: string, pattern: string) {
        const root = await mkdtemp(path.join(tmpdir(), "raster-source-test-"));
        tempRoots.push(root);
        const filePath = path.join(root, pattern.replace("*", "fixture"));
        await writeFile(filePath, "pdf bytes");
        return filePath;
      },
    };
    const uploads: string[] = [];
    const storage = { async objectSize() { return null; }, async putBytes(key: string) { uploads.push(key); }, uri(key: string) { return `s3://test/${key}`; } };
    const runner = {
      async pdfPageSizes(_source: string, first: number, last: number) { return { binary: "pdfinfo", args: [String(first), String(last)], available: true }; },
      async renderPdfPageRange(_source: string, prefix: string, first: number) { return { binary: "pdftoppm", args: [prefix, String(first)], available: true }; },
      async run(plan: { binary?: string; args: string[] }) {
        if (plan.binary === "pdfinfo") return { stdout: pdfinfoSizes(Number(plan.args[0]), Number(plan.args[1])), stderr: "" };
        await writeFile(`${plan.args[0]}-${plan.args[1]}.png`, "x");
        return { stdout: "", stderr: "" };
      },
    };
    const sourceCache = new PdfSourceCache(sourceStorage as any);
    const cache = new PdfRasterCache(runner as any, storage as any, sourceCache, { pdftoppmConcurrency: Number.NaN, rasterSlots: new Semaphore(4) });
    const rendered = await cache.renderSelectedPages({ document: { ...makeDocument(), pageCount: 10 }, runId: "run-1", pageNumbers: [1, 2, 5] });
    expect(rendered.map((page) => page.pageNumber)).toEqual([1, 2, 5]);
    expect(uploads).toHaveLength(3);
    await sourceCache.clear();
  });

  it("bounds sandboxed raster commands across concurrent renders with the process-wide slots", async () => {
    const sourceStorage = {
      async downloadToTempFile(_key: string, pattern: string) {
        const root = await mkdtemp(path.join(tmpdir(), "raster-source-test-"));
        tempRoots.push(root);
        const filePath = path.join(root, pattern.replace("*", "fixture"));
        await writeFile(filePath, "pdf bytes");
        return filePath;
      },
    };
    const storage = { async objectSize() { return null; }, async putBytes() {}, uri(key: string) { return `s3://test/${key}`; } };
    let active = 0;
    let peak = 0;
    const runner = {
      async pdfPageSizes(_source: string, first: number, last: number) { return { binary: "pdfinfo", args: [String(first), String(last)], available: true }; },
      async renderPdfPageRange(_source: string, prefix: string, first: number) { return { binary: "pdftoppm", args: [prefix, String(first)], available: true }; },
      async run(plan: { binary?: string; args: string[] }) {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (plan.binary === "pdfinfo") return { stdout: pdfinfoSizes(Number(plan.args[0]), Number(plan.args[1])), stderr: "" };
          await writeFile(`${plan.args[0]}-${plan.args[1]}.png`, "x");
          return { stdout: "", stderr: "" };
        } finally {
          active -= 1;
        }
      },
    };
    const slots = new Semaphore(3);
    const sourceCache = new PdfSourceCache(sourceStorage as any);
    // Four documents x four lanes would run 16 commands at once without the shared slots.
    const caches = Array.from({ length: 4 }, () => new PdfRasterCache(runner as any, storage as any, sourceCache, { pdftoppmConcurrency: 4, rasterSlots: slots }));
    const rendered = await Promise.all(caches.map((cache, index) => cache.renderSelectedPages({
      document: { ...makeDocument(), id: `doc-${index}`, pageCount: 20 }, runId: "run-1", pageNumbers: [1, 3, 5, 7, 9, 11],
    })));
    expect(rendered.flat()).toHaveLength(24);
    expect(peak).toBe(3);
    expect(slots.inUse).toBe(0);
    await sourceCache.clear();
  });

  it("sizes distant selected pages with one pdfinfo call each, not one call over their span", async () => {
    const sourceStorage = {
      async downloadToTempFile(_key: string, pattern: string) {
        const root = await mkdtemp(path.join(tmpdir(), "raster-source-test-"));
        tempRoots.push(root);
        const filePath = path.join(root, pattern.replace("*", "fixture"));
        await writeFile(filePath, "pdf bytes");
        return filePath;
      },
    };
    const storage = { async objectSize() { return null; }, async putBytes() {}, uri(key: string) { return `s3://test/${key}`; } };
    const sized: Array<[number, number]> = [];
    const runner = {
      async pdfPageSizes(_source: string, first: number, last: number) { sized.push([first, last]); return { binary: "pdfinfo", args: [String(first), String(last)], available: true }; },
      async renderPdfPageRange(_source: string, prefix: string, first: number) { return { binary: "pdftoppm", args: [prefix, String(first)], available: true }; },
      async run(plan: { binary?: string; args: string[] }) {
        if (plan.binary === "pdfinfo") return { stdout: pdfinfoSizes(Number(plan.args[0]), Number(plan.args[1])), stderr: "" };
        await writeFile(`${plan.args[0]}-${plan.args[1]}.png`, "x");
        return { stdout: "", stderr: "" };
      },
    };
    const sourceCache = new PdfSourceCache(sourceStorage as any);
    const cache = new PdfRasterCache(runner as any, storage as any, sourceCache, { rasterSlots: new Semaphore(4) });
    await cache.renderSelectedPages({ document: { ...makeDocument(), pageCount: 40_000 }, runId: "run-1", pageNumbers: [1, 2, 3, 40_000] });
    expect(sized.sort((a, b) => a[0] - b[0])).toEqual([[1, 3], [40_000, 40_000]]);
    await sourceCache.clear();
  });

  it("releases a waiting semaphore slot request when its signal aborts", async () => {
    const slots = new Semaphore(1);
    let release!: () => void;
    const holder = slots.run(undefined, () => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const waiter = slots.run(controller.signal, async () => "ran");
    controller.abort(new Error("cancelled"));
    await expect(waiter).rejects.toThrow("cancelled");
    release();
    await holder;
    expect(slots.inUse).toBe(0);
    expect(await slots.run(undefined, async () => "next")).toBe("next");
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

/** Host pids of live node processes with `arg` among their argv (not the unshare launcher). */
function hostPidsWithArg(arg: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (argv[0] === process.execPath && argv.includes(arg)) found.push(Number(entry));
    } catch {}
  }
  return found;
}
