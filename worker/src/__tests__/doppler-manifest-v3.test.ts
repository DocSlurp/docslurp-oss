import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DopplerFigureRejection, readDopplerFigureDir, readLedgerSpill, storeDopplerFigures, type DopplerFigureSet } from "../extractors/doppler-figures.js";
import { ByteBudget } from "../extractors/doppler-upload.js";
import { v2Manifest, v3Text, writeV3Folder } from "../test/doppler-manifest-v2.js";

// Version 3 (`manifest.jsonl`, `doppler-images/3`): read line by line in fixed memory, every line checked as it arrives,
// the end line's counts, totals and hash checked against what came before. And the store: bounded memory, bounded
// concurrency, files verified as they stream, the manifest written only after every file.
const DOC = { id: "0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b", userId: "user-1", runId: "run-1" };

let work: string;
let dir: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "doppler-v3-test-"));
  dir = path.join(work, "figures");
});
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

/** `gc()` for this test (V8 exposes it once the flag is set at run time). */
function forcedGc(): () => void {
  v8.setFlagsFromString("--expose-gc");
  return runInNewContext("gc") as () => void;
}

async function rowsOf(set: DopplerFigureSet) {
  const rows = [];
  for await (const row of readLedgerSpill(set.ledger.spill)) rows.push(row);
  return rows;
}

async function rule(text: string, options: { partial?: boolean; pageCount?: number } = {}): Promise<string> {
  const { files } = v2Manifest({ partial: options.partial });
  await rm(dir, { recursive: true, force: true });
  await writeV3Folder(dir, text, files);
  try {
    await readDopplerFigureDir(dir, { pageCount: options.pageCount ?? 3 });
  } catch (error) {
    if (error instanceof DopplerFigureRejection) return error.rule;
    throw error;
  }
  return "accepted";
}

const base = (options: { partial?: boolean } = {}) => v2Manifest(options).manifest;

describe("manifest v3: reading", () => {
  it("reads a complete manifest.jsonl into the same ledger rows as version 2", async () => {
    const { files, manifest } = v2Manifest();
    await writeV3Folder(dir, v3Text(manifest), files);
    const set = await readDopplerFigureDir(dir, { pageCount: 3, expect: "complete" });
    expect(set.version).toBe(3);
    expect(set.manifestFile).toBe("manifest.jsonl");
    expect(set.manifestSha256).toBe(createHash("sha256").update(await readFile(path.join(dir, "manifest.jsonl"))).digest("hex"));
    expect((await rowsOf(set)).map((a) => [a.assetId, a.status, a.reason, a.source, a.fileOf, a.linkPath])).toEqual([
      ["p1.1", "extracted", null, "render", "p1.1", "images/page-0001/image-001.webp"],
      ["p1.g1", "extracted", null, "render", "p1.g1", "images/page-0001/figure-001.svg"],
      ["p2.1", "not-extracted", "repeat", null, "p1.1", "images/page-0001/image-001.webp"],
      ["p2.2", "unlinked", null, null, null, null],
      ["p3.1", "extracted", null, "copy", "p3.1", "images/page-0003/image-001.jpg"],
    ]);
    expect(set.run).toMatchObject({ complete: true, resumable: false, deadlineMs: 121_500 });
  });

  it("a partial manifest keeps its resumable images and the last cut page", async () => {
    const { files, manifest } = v2Manifest({ partial: true });
    await writeV3Folder(dir, v3Text(manifest), files);
    const set = await readDopplerFigureDir(dir, { pageCount: 3, expect: "partial" });
    expect(set.ledger.counts.resumable).toBe(1);
    expect(set.run).toMatchObject({ complete: false, resumable: true, lastCutPage: 3 });
  });

  it("refuses a manifest without its end line (truncated), or cut mid-line", async () => {
    expect(await rule(v3Text(base(), { omitEnd: true }))).toBe("manifest-missing-end-line");
    const whole = v3Text(base());
    expect(await rule(whole.slice(0, whole.length - 20))).toBe("manifest-unterminated-line");
  });

  it("refuses a tampered hash, and a line changed after the hash was taken", async () => {
    expect(await rule(v3Text(base(), { endPatch: { sha256: "0".repeat(64) } }))).toBe("manifest-hash-mismatch");
    const text = v3Text(base()).replace('"dpi":150', '"dpi":151');
    expect(await rule(text)).toBe("manifest-hash-mismatch");
  });

  it("refuses lines out of order and unknown line types", async () => {
    expect(await rule(v3Text(base(), { mutateLines: (lines) => { lines.push(lines.splice(5, 1)[0]!); } }))).toBe("manifest-lines-out-of-order");
    expect(await rule(v3Text(base(), { mutateLines: (lines) => { const [a, b] = [lines[1]!, lines[2]!]; lines[1] = b; lines[2] = a; } }))).toBe("manifest-lines-out-of-order");
    expect(await rule(v3Text(base(), { mutateLines: (lines) => { lines.push(lines.shift()!); } }))).toBe("manifest-lines-out-of-order");
    expect(await rule(v3Text(base(), { mutateLines: (lines) => { lines.splice(1, 0, JSON.stringify({ type: "comment", text: "hi" })); } }))).toBe("manifest-unknown-line-type");
    expect(await rule(`${v3Text(base())}${JSON.stringify({ type: "image" })}\n`)).toBe("manifest-line-after-end");
  });

  it("refuses an oversized line and a non-ASCII byte", async () => {
    expect(await rule(v3Text(base(), { mutateLines: (lines) => { lines[1] = lines[1]!.replace("}", `,"pad":"${"x".repeat(70 * 1024)}"}`); } }))).toBe("manifest-line-too-long");
    expect(await rule(v3Text(base(), { mutateLines: (lines) => { lines[0] = lines[0]!.replace('"skip"', '"skïp"'); } }))).toBe("manifest-not-ascii");
  });

  it("refuses end counts or totals that disagree with the lines", async () => {
    expect(await rule(v3Text(base(), { endPatch: { images: 4 } }))).toBe("manifest-counts-mismatch");
    expect(await rule(v3Text(base(), { endPatch: { batches: 1 } }))).toBe("manifest-counts-mismatch");
    const m = base();
    m.totals.bytes += 1;
    expect(await rule(v3Text(m))).toBe("manifest-totals-mismatch");
    const stopped = base();
    stopped.batches[1]!.status = "timeout";
    stopped.totals.batches_cut = 1;
    expect(await rule(v3Text(stopped))).toBe("manifest-complete-mismatch");
    expect(await rule(v3Text(base(), { endPatch: { resumable: true, complete: false } }))).toBe("manifest-resumable-mismatch");
  });

  it("refuses a hostile image line on its own, and a repeat that names a later image", async () => {
    expect(await rule(v3Text(base(), { mutateLines: (lines) => { lines[1] = lines[1]!.replace('"page-0001/image-001.webp"', '"../../etc/passwd"'); } }))).toBe("manifest-image-invalid");
    const m = base();
    // p2.1 repeats p1.1: point it at p3.1 (a later id) instead.
    const repeat = m.images.find((e) => e.id === "p2.1")!;
    Object.assign(repeat, { repeat_of: "p3.1", path: "page-0003/image-001.jpg", link: "images/page-0003/image-001.jpg", format: "jpg" });
    expect(await rule(v3Text(m))).toBe("manifest-repeat-invalid");
  });

  it("refuses more lines than the document's entry cap", async () => {
    const m = base();
    const furniture = m.images.find((e) => e.id === "p2.2")!;
    const extra = 16_384 + 16 * 3;
    for (let i = 0; i < extra; i += 1) m.images.splice(4 + i, 0, { ...furniture, id: `p2.${i + 3}` });
    m.totals.images += extra;
    m.totals.unlinked += extra;
    expect(await rule(v3Text(m))).toBe("manifest-too-many-lines");
  }, 30_000);

  it("reads a 100,000-line manifest within the fixed memory budget", async () => {
    const pages = 6400;
    const images: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= pages; page += 1) {
      for (let i = 1; i <= 16 && images.length < 100_000; i += 1) {
        images.push({ id: `p${page}.${i}`, page, bbox: [1, 2, 3, 4], kind: "picture", fate: "furniture", obj: [3, 0], path: null, link: null, status: "unlinked", format: null, source: null, bytes: 0, sha256: null, width: 0, height: 0 });
      }
    }
    const m = base();
    Object.assign(m, {
      images, batches: Array.from({ length: pages / 64 }, (_, b) => ({ pages: [b * 64 + 1, b * 64 + 64], status: "ok" })),
      totals: { images: images.length, linked: 0, extracted: 0, not_extracted: 0, unlinked: images.length, bytes: 0, repeats: 0, fallbacks: 0, scans: 0, scan_bytes: 0, batches: pages / 64, batches_cut: 0 },
    });
    const text = v3Text(m);
    images.length = 0;
    await writeV3Folder(dir, text, new Map());
    const size = Buffer.byteLength(text);
    const gc = forcedGc();
    gc();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 2);
    const started = Date.now();
    const set = await readDopplerFigureDir(dir, { pageCount: pages, expect: "complete" });
    clearInterval(sampler);
    const ms = Date.now() - started;
    gc();
    const retainedMiB = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    expect(set.ledger.rows).toBe(100_000);
    console.log(`[doppler-v3-test] 100,000 lines (${(size / 1024 / 1024).toFixed(1)} MiB): ${ms} ms, heap peak +${((peak - before) / 1024 / 1024).toFixed(1)} MiB (garbage included), retained +${retainedMiB.toFixed(1)} MiB`);
    // Nothing of the manifest is kept: the rows are on disk, the reader held one line and a spill buffer at a time.
    expect(retainedMiB).toBeLessThan(8);
  }, 120_000);
});

/** A storage double with a streaming PUT that consumes slowly and counts what it holds. */
function slowStreamingStorage(options: { failKey?: string } = {}) {
  let inFlight = 0;
  let peakInFlight = 0;
  let concurrent = 0;
  let peakConcurrent = 0;
  const order: string[] = [];
  const deleted: string[] = [];
  const objects = new Map<string, Buffer>();
  return {
    stats: () => ({ peakInFlight, peakConcurrent, order, deleted, objects }),
    putBytes: async (key: string, data: Uint8Array) => {
      concurrent += 1; peakConcurrent = Math.max(peakConcurrent, concurrent);
      inFlight += data.length; peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      objects.set(key, Buffer.from(data));
      order.push(key);
      inFlight -= data.length;
      concurrent -= 1;
    },
    putJson: async (key: string, value: unknown) => { objects.set(key, Buffer.from(JSON.stringify(value))); order.push(key); },
    putStream: async (key: string, body: Readable, size: number) => {
      concurrent += 1; peakConcurrent = Math.max(peakConcurrent, concurrent);
      const parts: Buffer[] = [];
      try {
        for await (const chunk of body) {
          const data = chunk as Buffer;
          inFlight += data.length; peakInFlight = Math.max(peakInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          parts.push(data);
          inFlight -= data.length;
        }
      } finally {
        concurrent -= 1;
      }
      const whole = Buffer.concat(parts);
      expect(whole.length).toBe(size);
      objects.set(key, whole);
      order.push(key);
    },
    deleteKeys: async (keys: string[]) => { for (const key of keys) { deleted.push(key); objects.delete(key); } },
    uri: (key: string) => `s3://b/${key}`,
  };
}

/** A version 3 folder of `count` page scans of `bytes` each. */
async function scanBook(count: number, bytes: number): Promise<void> {
  const files = new Map<string, Buffer>();
  const images: Array<Record<string, unknown>> = [];
  let total = 0;
  for (let page = 1; page <= count; page += 1) {
    const data = Buffer.alloc(bytes + page, page % 251);
    data[0] = 0xff; data[1] = 0xd8; data[2] = 0xff; data[data.length - 2] = 0xff; data[data.length - 1] = 0xd9;
    const rel = `page-${String(page).padStart(4, "0")}/image-001.jpg`;
    files.set(rel, data);
    total += data.length;
    images.push({ id: `p${page}.1`, page, bbox: [0, 0, 612, 792], kind: "picture", fate: "page-scan", obj: [page, 0], path: rel, link: `images/${rel}`, status: "extracted",
      format: "jpg", source: "copy", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), width: 1700, height: 2200 });
  }
  const m = base();
  const batches = Array.from({ length: Math.ceil(count / 64) }, (_, b) => ({ pages: [b * 64 + 1, Math.min(count, b * 64 + 64)], status: "ok" }));
  Object.assign(m, { images, batches, totals: { images: count, linked: count, extracted: count, not_extracted: 0, unlinked: 0, bytes: total, repeats: 0, fallbacks: 0, scans: count, scan_bytes: total, batches: batches.length, batches_cut: 0 } });
  await writeV3Folder(dir, v3Text(m), files);
}

describe("storing: fixed memory, bounded concurrency, verified streams", () => {
  it("never holds more than the budget, never runs more uploads than the cap, and writes the manifest after every file", async () => {
    await scanBook(40, 1024 * 1024);
    const set = await readDopplerFigureDir(dir, { pageCount: 40, expect: "complete" });
    const storage = slowStreamingStorage();
    const budgets = { job: new ByteBudget(6 * 1024 * 1024), worker: new ByteBudget(64 * 1024 * 1024), concurrency: 4 };
    const stored = await storeDopplerFigures({ storage, document: DOC, runId: "run-1", figures: set, markdown: "", budgets });
    const { peakInFlight, peakConcurrent, order } = storage.stats();
    expect(budgets.job.peak).toBeLessThanOrEqual(budgets.job.limit);
    expect(peakInFlight).toBeLessThanOrEqual(budgets.job.limit);
    expect(peakConcurrent).toBeLessThanOrEqual(4);
    expect(peakConcurrent).toBeGreaterThan(1);
    const manifestAt = order.indexOf(`user-1/run-1/doppler/${DOC.id}/images/manifest.jsonl`);
    const lastFile = Math.max(...[...stored.keys.values()].map((key) => order.indexOf(key)));
    expect(manifestAt).toBeGreaterThan(lastFile);
    expect(order.at(-1)).toBe(`user-1/run-1/doppler/${DOC.id}/index.json`);
    expect(stored.stats.peakBufferBytes).toBeLessThanOrEqual(6 * 1024 * 1024);
  }, 60_000);

  it("a file that fails verification midway aborts its upload and deletes only that object; verified files stay", async () => {
    await scanBook(6, 2 * 1024 * 1024);
    const set = await readDopplerFigureDir(dir, { pageCount: 6, expect: "complete" });
    // Changed after the read: same size, different bytes near the end.
    const victim = path.join(dir, "page-0004", "image-001.jpg");
    const bytes = await readFile(victim);
    bytes[bytes.length - 100] ^= 0xff;
    await writeFile(victim, bytes);
    const storage = slowStreamingStorage();
    const error = await storeDopplerFigures({ storage, document: DOC, runId: "run-1", figures: set, markdown: "", budgets: { job: new ByteBudget(8 * 1024 * 1024), worker: new ByteBudget(64 * 1024 * 1024), concurrency: 2 } }).catch((e) => e);
    expect(error).toBeInstanceOf(DopplerFigureRejection);
    expect(error.rule).toBe("sha256-mismatch");
    const { deleted, objects, order } = storage.stats();
    const victimKey = `user-1/run-1/doppler/${DOC.id}/images/page-0004/image-001.${set.files.find((f) => f.id === "p4.1")!.sha256.slice(0, 16)}.jpg`;
    expect(deleted).toEqual([victimKey]);
    expect(order).not.toContain(victimKey);
    expect(objects.has(victimKey)).toBe(false);
    expect(order.some((key) => key.endsWith("manifest.jsonl"))).toBe(false);
  }, 60_000);

  it("a reservation larger than the budget is clamped, never a deadlock", async () => {
    const budget = new ByteBudget(1024);
    expect(await budget.acquire(10_000)).toBe(1024);
    const waiting = budget.acquire(1);
    let done = false;
    void waiting.then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(done).toBe(false);
    budget.release(1024);
    await waiting;
    expect(budget.peak).toBe(1024);
  });
});

describe("a real Doppler run (fixtures/doppler-golden/v3-repeats, see PROVENANCE.json)", () => {
  const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "doppler-golden");

  it("reads Doppler's own manifest.jsonl, stores its folder as is, and the Markdown's links resolve with no rewriting", async () => {
    const folder = path.join(work, "images");
    await cp(path.join(GOLDEN, "v3-repeats", "images"), folder, { recursive: true });
    const source = createHash("sha256").update(await readFile(path.join(GOLDEN, "repeats", "source.pdf"))).digest("hex");
    const set = await readDopplerFigureDir(folder, { pageCount: 4, expect: "complete", sourceSha256: source });
    expect(set.version).toBe(3);
    expect((await rowsOf(set)).map((r) => [r.assetId, r.status, r.reason, r.fileOf])).toEqual([
      ["p1.1", "extracted", null, "p1.1"], ["p2.1", "not-extracted", "repeat", "p1.1"], ["p3.1", "extracted", null, "p3.1"],
      ["p3.2", "not-extracted", "repeat", "p3.1"], ["p4.1", "not-extracted", "repeat", "p1.1"],
    ]);
    const storage = slowStreamingStorage();
    const markdownPath = path.join(GOLDEN, "v3-repeats", "document.md");
    await storeDopplerFigures({ storage, document: DOC, runId: "run-1", figures: set, markdown: "", dopplerMarkdownPath: markdownPath });
    const prefix = `user-1/run-1/doppler/${DOC.id}/`;
    const { objects } = storage.stats();
    // The stored manifest is the canonical re-serialisation: the same lines as JSON values, and it validates again.
    const canonical = objects.get(`${prefix}images/manifest.jsonl`)!.toString().trimEnd().split("\n").map((line) => JSON.parse(line));
    const original = (await readFile(path.join(GOLDEN, "v3-repeats", "images", "manifest.jsonl"), "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(canonical.slice(0, -1)).toEqual(original.slice(0, -1));
    expect(canonical.at(-1)).toEqual({ ...original.at(-1), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // Every link of document.md names a ledger row whose owner's file is a stored (content-addressed) object.
    const markdown = objects.get(`${prefix}document.md`)!.toString();
    const links = [...markdown.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    const rows = await rowsOf(set);
    for (const link of links) {
      const row = rows.find((r) => r.linkPath === link);
      expect(row, link).toBeDefined();
      const owner = rows.find((r) => r.assetId === row!.fileOf)!;
      expect(objects.has(`${prefix}images/${link.slice("images/".length).replace(/\.(\w+)$/, `.${owner.sha256!.slice(0, 16)}.$1`)}`) || objects.has(`${prefix}images/${owner.linkPath!.slice("images/".length).replace(/\.(\w+)$/, `.${owner.sha256!.slice(0, 16)}.$1`)}`), link).toBe(true);
    }
  });
});
