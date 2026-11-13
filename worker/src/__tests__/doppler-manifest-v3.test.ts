import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DopplerFigureRejection, downloadDopplerImagesDir, readDopplerFigureDir, readLedgerSpill, storeDopplerFigures, type DopplerFigureSet } from "../extractors/doppler-figures.js";
import { ByteBudget } from "../extractors/doppler-upload.js";
import { dopplerAssetCaps } from "@docslurp/shared";
import { v2Manifest, v3ShardText, v3Text, writeShardedFolder, writeV3Folder } from "../test/doppler-manifest-v2.js";

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
    expect(set.manifests[0]!.relative).toBe("manifest.jsonl");
    expect(set.manifests[0]!.sha256).toBe(createHash("sha256").update(await readFile(path.join(dir, "manifest.jsonl"))).digest("hex"));
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
  }, 60_000);

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

  it("MEDIUM-2: a line padded past its type's cap is refused (real image lines are about 216 bytes)", async () => {
    const pad = (line: string, to: number) => `{${" ".repeat(Math.max(0, to - line.length))}${line.slice(1)}`;
    expect(await rule(v3Text(base(), { mutateLines: (lines) => { lines[1] = pad(lines[1]!, 3000); } }))).toBe("manifest-line-too-long");
    expect(await rule(v3Text(base(), { mutateLines: (lines) => { lines[0] = pad(lines[0]!, 2100); } }))).toBe("manifest-line-too-long");
    // Within the cap, padding is still valid JSON and accepted.
    expect(await rule(v3Text(base(), { mutateLines: (lines) => { lines[1] = pad(lines[1]!, 1500); } }))).toBe("accepted");
  });

  it("MEDIUM-2: a padded manifest past the folder's manifest byte cap is refused before a line is read", async () => {
    // 3 pages: min(64 MiB, 1 KiB x 16,432 entries) = about 16 MiB. 9,000 padded furniture lines of 1,900 bytes are each
    // within every per-line cap and well under the line count cap, yet over 17 MB in all.
    const m = base();
    const furniture = m.images.find((e) => e.id === "p2.2")!;
    const extra = 9_000;
    for (let i = 0; i < extra; i += 1) m.images.splice(4 + i, 0, { ...furniture, id: `p2.${i + 3}` });
    m.totals.images += extra;
    m.totals.unlinked += extra;
    const text = v3Text(m, { mutateLines: (lines) => {
      for (let i = 1; i < lines.length; i += 1) if (lines[i]!.includes('"status":"unlinked"')) lines[i] = `{${" ".repeat(1900 - lines[i]!.length)}${lines[i]!.slice(1)}`;
    } });
    expect(text.length).toBeGreaterThan(dopplerAssetCaps(3).manifestV3Bytes);
    expect(await rule(text)).toBe("oversized-file");
  }, 60_000);

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

  it("a file that fails verification midway aborts its upload and deletes the partial object, and nothing else stays", async () => {
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
    expect(deleted).toContain(`user-1/run-1/doppler/${DOC.id}/images/page-0004/image-001.jpg`);
    expect(order).not.toContain(`user-1/run-1/doppler/${DOC.id}/images/page-0004/image-001.jpg`);
    expect(objects.size).toBe(0);
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
    // document.md is the Markdown slot's bytes; Doppler's links survive the host's sanitizing, so they still resolve.
    const markdownBytes = await readFile(path.join(GOLDEN, "v3-repeats", "document.md"));
    await storeDopplerFigures({ storage, document: DOC, runId: "run-1", figures: set, markdown: "", documentMarkdown: markdownBytes });
    const prefix = `user-1/run-1/doppler/${DOC.id}/`;
    const { objects } = storage.stats();
    // The manifest bytes are Doppler's, unchanged.
    expect(objects.get(`${prefix}images/manifest.jsonl`)!.equals(await readFile(path.join(GOLDEN, "v3-repeats", "images", "manifest.jsonl")))).toBe(true);
    // Every link of document.md, resolved against the folder, is a stored object.
    const markdown = objects.get(`${prefix}document.md`)!.toString();
    const links = [...markdown.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(objects.has(`${prefix}${link}`), link).toBe(true);
  });
});

describe("sharded documents: one manifest per shard", () => {
  async function shardRule(build: (m: ReturnType<typeof base>, files: Map<string, Buffer>) => Array<{ range: [number, number]; text: string }>, options: { partial?: boolean } = {}) {
    const { manifest, files } = v2Manifest({ partial: options.partial });
    const shards = build(manifest, files);
    await rm(dir, { recursive: true, force: true });
    await writeShardedFolder(dir, shards, files);
    try {
      return await readDopplerFigureDir(dir, { pageCount: 3 });
    } catch (error) {
      if (error instanceof DopplerFigureRejection) return error.rule;
      throw error;
    }
  }
  const two = (m: ReturnType<typeof base>) => [{ range: [1, 2] as [number, number], text: v3ShardText(m, [1, 2]) }, { range: [3, 3] as [number, number], text: v3ShardText(m, [3, 3]) }];

  it("accepts two shards: the union of their rows, one record per shard, complete only if every shard is", async () => {
    const set = await shardRule(two) as DopplerFigureSet;
    expect(typeof set).toBe("object");
    expect(set.manifests.map((m) => [m.relative, m.range, m.complete])).toEqual([
      ["shards/0001-0002/manifest.jsonl", [1, 2], true], ["shards/0003-0003/manifest.jsonl", [3, 3], true],
    ]);
    expect((await rowsOf(set)).map((r) => r.assetId)).toEqual(["p1.1", "p1.g1", "p2.1", "p2.2", "p3.1"]);
    expect(set.complete).toBe(true);
    const partial = await shardRule(two, { partial: true }) as DopplerFigureSet;
    expect(partial.complete).toBe(false);
    expect(partial.manifests.map((m) => m.resumable)).toEqual([0, 1]);
  });

  it("stores each shard's manifest beside the page folders", async () => {
    const set = await shardRule(two) as DopplerFigureSet;
    const storage = slowStreamingStorage();
    const stored = await storeDopplerFigures({ storage, document: DOC, runId: "run-1", figures: set, markdown: "" });
    const images = `user-1/run-1/doppler/${DOC.id}/images/`;
    expect(stored.manifest).toBeNull();
    expect(stored.manifests.map((m) => [m.key, m.range])).toEqual([[`${images}shards/0001-0002/manifest.jsonl`, [1, 2]], [`${images}shards/0003-0003/manifest.jsonl`, [3, 3]]]);
    expect(storage.stats().objects.has(`${images}page-0003/image-001.jpg`)).toBe(true);
    expect(stored.slots.map((s) => s.slot)).toContain("doppler-manifest:0001-0002");
  });

  it("refuses overlapping ranges, another PDF, other settings, a file with no owner, and an image outside its shard", async () => {
    expect(await shardRule((m) => [{ range: [1, 2], text: v3ShardText(m, [1, 2]) }, { range: [2, 3], text: v3ShardText(m, [2, 3]) }])).toBe("shards-overlap");
    expect(await shardRule((m) => {
      const other = { ...m, source_sha256: "c".repeat(64) };
      return [{ range: [1, 2], text: v3ShardText(m, [1, 2]) }, { range: [3, 3], text: v3ShardText(other, [3, 3]) }];
    })).toBe("shards-source-mismatch");
    expect(await shardRule((m) => [{ range: [1, 2], text: v3ShardText(m, [1, 2]) }, { range: [3, 3], text: v3ShardText({ ...m, dpi: 300 }, [3, 3]) }])).toBe("shards-settings-mismatch");
    // Shard 3-3's manifest left out: page-0003's file has no owner.
    expect(await shardRule((m) => [{ range: [1, 2], text: v3ShardText(m, [1, 2]) }])).toBe("files-do-not-match-manifest");
    // An image line of page 3 in the 1-2 shard.
    expect(await shardRule((m) => [{ range: [1, 2], text: v3ShardText(m, [1, 2], { mutateLines: (lines) => {
      const p3 = JSON.stringify({ type: "image", ...m.images.find((e) => e.id === "p3.1") });
      lines.splice(lines.findIndex((l) => l.includes('"type":"batch"')), 0, p3);
    } }) }])).toBe("manifest-shard-range");
    // A header whose pages are not the folder's range.
    expect(await shardRule((m) => [{ range: [1, 2], text: v3ShardText(m, [1, 2]).replace('"pages":[1,2]', '"pages":[1,3]') }, { range: [3, 3], text: v3ShardText(m, [3, 3]) }])).toMatch(/^manifest-/);
    // Both a top-level manifest and shards.
    expect(await shardRule((m, files) => { void files; return two(m); }).then(async () => {
      await writeFile(path.join(dir, "manifest.jsonl"), v3Text(m0()));
      try { await readDopplerFigureDir(dir, { pageCount: 3 }); return "accepted"; } catch (error) { return (error as DopplerFigureRejection).rule; }
    })).toBe("unexpected-entry");
  }, 60_000);

  it("LOW-5: shards start at page 1, leave no hole, and end within the document", async () => {
    // Page 2 has no file (a repeat and furniture), so a 1-1 + 3-3 split would otherwise drop its rows silently.
    expect(await shardRule((m) => [{ range: [1, 1], text: v3ShardText(m, [1, 1]) }, { range: [3, 3], text: v3ShardText(m, [3, 3]) }])).toBe("shards-not-contiguous");
    expect(await shardRule((m) => [{ range: [2, 3], text: v3ShardText(m, [2, 3]) }])).toBe("shards-not-contiguous");
    expect(await shardRule((m) => [{ range: [1, 2], text: v3ShardText(m, [1, 2]) }, { range: [3, 4], text: v3ShardText(m, [3, 4]) }])).toBe("page-outside-document");
  }, 60_000);
});

const m0 = () => v2Manifest().manifest;

describe("figure outcome gaps", () => {
  it("keeps sorted, non-overlapping page gaps within the document; unknown reasons become other", async () => {
    const { parseSandboxedPdfFigureOutcome } = await import("../extractors/plugins.js");
    expect(parseSandboxedPdfFigureOutcome({ status: "partial", gaps: [{ first: 1, last: 2, reason: "plugin:doc-pass-budget" }, { first: 5, last: 5, reason: "rm -rf /" }] }, 500, 10))
      .toEqual({ status: "partial", gaps: [{ first: 1, last: 2, reason: "plugin:doc-pass-budget" }, { first: 5, last: 5, reason: "other" }] });
    const refused = { status: "failed", reason: "provider-reported-invalid-gaps" };
    expect(parseSandboxedPdfFigureOutcome({ status: "partial", gaps: [{ first: 1, last: 3, reason: "converter:timeout" }, { first: 3, last: 4, reason: "converter:timeout" }] }, 500, 10)).toEqual(refused);
    expect(parseSandboxedPdfFigureOutcome({ status: "partial", gaps: [{ first: 4, last: 5, reason: "x" }, { first: 1, last: 2, reason: "x" }] }, 500, 10)).toEqual(refused);
    expect(parseSandboxedPdfFigureOutcome({ status: "partial", gaps: [{ first: 9, last: 11, reason: "x" }] }, 500, 10)).toEqual(refused);
    expect(parseSandboxedPdfFigureOutcome({ status: "partial", gaps: [{ first: 0, last: 1, reason: "x" }] }, 500, 10)).toEqual(refused);
    expect(parseSandboxedPdfFigureOutcome({ status: "partial", gaps: [{ first: 2, last: 1, reason: "x" }] }, 500, 10)).toEqual(refused);
    expect(parseSandboxedPdfFigureOutcome({ status: "partial", gaps: [{ first: 1.5, last: 2, reason: "x" }] }, 500, 10)).toEqual(refused);
    const many = Array.from({ length: 129 }, (_, i) => ({ first: i + 1, last: i + 1, reason: "converter:budget" }));
    expect(parseSandboxedPdfFigureOutcome({ status: "partial", gaps: many }, 500, 1000)).toEqual(refused);
    expect(parseSandboxedPdfFigureOutcome({ status: "partial", gaps: many.slice(0, 128) }, 500, 1000)).toMatchObject({ status: "partial" });
  });

  it("the plugin host says which outcomes this core accepts", async () => {
    const { createExtractorPluginHost } = await import("../extractors/plugins.js");
    expect(createExtractorPluginHost().figureOutcomes).toEqual(["extracted", "partial", "failed"]);
  });
});

describe("LOW-7: the resume DIR must be new or empty", () => {
  it("refuses a directory that already holds anything, or a symlink, before downloading a byte", async () => {
    const reads: string[] = [];
    const storage = { getBytes: async (key: string) => { reads.push(key); return Buffer.alloc(0); } };
    const args = (target: string) => ({ storage, document: DOC, runId: "run-1", manifestSha256: "a".repeat(64), pageCount: 3, dir: target });
    const full = path.join(work, "full");
    await mkdir(full);
    await writeFile(path.join(full, "manifest.jsonl"), "planted\n");
    await expect(downloadDopplerImagesDir(args(full))).rejects.toMatchObject({ rule: "resume-dir-not-empty" });
    const link = path.join(work, "link");
    await symlink(work, link);
    await expect(downloadDopplerImagesDir(args(link))).rejects.toMatchObject({ rule: "resume-dir-not-empty" });
    expect(reads).toEqual([]);
    // An empty or absent directory is accepted (the download then runs; here it fails on the fake manifest's hash).
    const empty = path.join(work, "empty");
    await mkdir(empty);
    await expect(downloadDopplerImagesDir(args(empty))).rejects.toMatchObject({ rule: "manifest-changed" });
    await expect(downloadDopplerImagesDir(args(path.join(work, "absent", "dir")))).rejects.toMatchObject({ rule: "manifest-changed" });
  });
});
