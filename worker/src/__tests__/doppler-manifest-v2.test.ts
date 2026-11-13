import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dopplerAssetCaps, dopplerImageLimits, dopplerLedgerAssets, dopplerManifestV2Schema, parseDopplerManifest } from "@docslurp/shared";

import { DopplerFigureRejection, dopplerFigureRecords, readDopplerFigureDir, readLedgerSpill, storeDopplerFigures, type DopplerFigureSet } from "../extractors/doppler-figures.js";
import { ByteBudget } from "../extractors/doppler-upload.js";

async function rowsOf(set: DopplerFigureSet) {
  const rows = [];
  for await (const row of readLedgerSpill(set.ledger.spill)) rows.push(row);
  return rows;
}
import { v2Manifest, writeV2Folder, type V2Manifest } from "../test/doppler-manifest-v2.js";

const DOC = { id: "0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b", userId: "user-1", runId: "run-1" };

let work: string;
let dir: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "doppler-v2-test-"));
  dir = path.join(work, "figures");
});
afterEach(async () => { await rm(work, { recursive: true, force: true }); }, 60_000);

async function rule(mutate: (m: V2Manifest, files: Map<string, Buffer>) => unknown = () => undefined, options: { partial?: boolean; expect?: "complete" | "partial"; pageCount?: number; sourceSha256?: string } = {}): Promise<string> {
  const { manifest, files } = v2Manifest({ partial: options.partial });
  const replaced = mutate(manifest, files);
  await rm(dir, { recursive: true, force: true });
  await writeV2Folder(dir, replaced ?? manifest, files);
  try {
    await readDopplerFigureDir(dir, { pageCount: options.pageCount ?? 3, expect: options.expect, sourceSha256: options.sourceSha256 });
  } catch (error) {
    if (error instanceof DopplerFigureRejection) return error.rule;
    throw error;
  }
  return "accepted";
}

describe("manifest v2: the happy path", () => {
  it("accepts a complete folder and maps every image to a ledger row", async () => {
    const { manifest, files } = v2Manifest();
    await writeV2Folder(dir, manifest, files);
    const set = await readDopplerFigureDir(dir, { pageCount: 3, expect: "complete" });
    expect(set.version).toBe(2);
    expect(set.files.map((file) => [file.id, file.format])).toEqual([["p1.1", "webp"], ["p1.g1", "svg"], ["p3.1", "jpg"]]);
    expect((await rowsOf(set)).map((a) => [a.assetId, a.status, a.reason, a.source, a.fileOf, a.linkPath])).toEqual([
      ["p1.1", "extracted", null, "render", "p1.1", "images/page-0001/image-001.webp"],
      ["p1.g1", "extracted", null, "render", "p1.g1", "images/page-0001/figure-001.svg"],
      ["p2.1", "not-extracted", "repeat", null, "p1.1", "images/page-0001/image-001.webp"],
      ["p2.2", "unlinked", null, null, null, null],
      ["p3.1", "extracted", null, "copy", "p3.1", "images/page-0003/image-001.jpg"],
    ]);
  });

  it("stores Doppler's own folder layout under the document's tenant root, keys derived from the owning ids", async () => {
    const { manifest, files } = v2Manifest();
    await writeV2Folder(dir, manifest, files);
    const set = await readDopplerFigureDir(dir, { pageCount: 3 });
    const keys: string[] = [];
    const json = new Map<string, unknown>();
    const markdown = "A\n\n![image](images/page-0001/image-001.webp)\n";
    const stored = await storeDopplerFigures({
      storage: { putBytes: async (key) => { keys.push(key); }, putJson: async (key, value) => { keys.push(key); json.set(key, value); }, uri: (key) => `s3://b/${key}` },
      document: DOC, runId: "run-1", figures: set, markdown, documentMarkdown: Buffer.from(markdown),
      source: { sourceKey: "uploads/s1/a.pdf", sha256: "a".repeat(64), pageCount: 3, mimeType: "application/pdf" },
    });
    const root = `user-1/run-1/doppler/${DOC.id}`;
    // Every image file first; then the manifest, the Markdown and the source pointer; the index last.
    expect(keys.slice(0, 3).sort()).toEqual([`${root}/images/page-0001/figure-001.svg`, `${root}/images/page-0001/image-001.webp`, `${root}/images/page-0003/image-001.jpg`]);
    expect(keys.slice(3, 6).sort()).toEqual([`${root}/document.md`, `${root}/images/manifest.json`, `${root}/source.json`]);
    expect(keys[6]).toBe(`${root}/index.json`);
    // The ledger's link path and the storage key share one relative path under the folder.
    for (const asset of (await rowsOf(set)).filter((a) => a.status === "extracted")) expect(stored.keys.get(asset.assetId)).toBe(`${root}/${asset.linkPath}`);
    expect(stored.manifest).toEqual({ key: `${root}/images/manifest.json`, sha256: createHash("sha256").update(await readFile(path.join(dir, "manifest.json"))).digest("hex") });
    expect(json.get(`${root}/source.json`)).toEqual({ sourceKey: "uploads/s1/a.pdf", sha256: "a".repeat(64), pageCount: 3, mimeType: "application/pdf" });
    // Slots for every served object, none for the source pointer.
    expect(stored.slots.map((s) => s.slot)).toEqual(["doppler-figures", "doppler-figure:p1.1", "doppler-figure:p1.g1", "doppler-figure:p3.1", "doppler-manifest", "doppler-markdown"]);
    expect(stored.slots.some((s) => s.uri.endsWith("/source.json"))).toBe(false);
  });

  it("an extract run's own prefix is the root (documentArtifactRoot)", async () => {
    const { manifest, files } = v2Manifest();
    await writeV2Folder(dir, manifest, files);
    const set = await readDopplerFigureDir(dir, { pageCount: 3 });
    const stored = await storeDopplerFigures({
      storage: { putBytes: async () => {}, putJson: async () => {}, uri: (key) => `s3://b/${key}` },
      document: { ...DOC, artifactRoot: "extracts/org-1/ex-1" }, runId: "run-1", figures: set, markdown: "",
    });
    expect(stored.keys.get("p1.1")).toBe(`extracts/org-1/ex-1/doppler/${DOC.id}/images/page-0001/image-001.webp`);
  });

  it("never stores page-facts.jsonl (its doc line can carry the PDF's untrusted producer/creator): no object, no slot", async () => {
    const { manifest, files } = v2Manifest();
    await writeV2Folder(dir, manifest, files);
    await writeFile(path.join(dir, "page-facts.jsonl"), '{"type":"doc","producer":"<script>x</script>"}\n');
    const set = await readDopplerFigureDir(dir, { pageCount: 3 });
    const put = new Map<string, Buffer>();
    const stored = await storeDopplerFigures({
      storage: { putBytes: async (key, data) => { put.set(key, Buffer.from(data)); }, putJson: async () => {}, uri: (key) => `s3://b/${key}` },
      document: DOC, runId: "run-1", figures: set, markdown: "",
    });
    expect([...put.keys()].some((key) => key.includes("page-facts"))).toBe(false);
    expect(stored.slots.some((s) => s.slot.includes("page-facts") || s.uri.includes("page-facts"))).toBe(false);
  });

  it("accepts a partial folder (exit 5) and keeps its resumable images", async () => {
    expect(await rule(() => undefined, { partial: true, expect: "partial" })).toBe("accepted");
    const set = await readDopplerFigureDir(dir, { pageCount: 3, expect: "partial" });
    expect((await rowsOf(set)).find((a) => a.assetId === "p3.2")).toMatchObject({ status: "not-extracted", reason: "budget", resumable: true, fileOf: null });
  });

  it("refuses a provider outcome the manifest contradicts", async () => {
    expect(await rule(() => undefined, { partial: true, expect: "complete" })).toBe("outcome-mismatch");
    expect(await rule(() => undefined, { expect: "partial" })).toBe("outcome-mismatch");
  });
});

describe("manifest v2: hostile or oversized manifests are refused", () => {
  const entry = (m: V2Manifest, id: string) => m.images.find((e) => e.id === id)!;
  const cases: Array<[string, (m: V2Manifest, files: Map<string, Buffer>) => unknown]> = [
    ["a path that climbs out", (m) => { entry(m, "p1.1").path = "../../etc/passwd"; }],
    ["a path for another id", (m) => { entry(m, "p1.1").path = "page-0001/image-002.webp"; entry(m, "p1.1").link = "images/page-0001/image-002.webp"; }],
    ["a path with extra leading zeros", (m) => { entry(m, "p1.1").path = "page-00001/image-001.webp"; entry(m, "p1.1").link = "images/page-00001/image-001.webp"; }],
    ["an absolute link prefix", (m) => { m.link_prefix = "/images/"; for (const e of m.images) if (e.link) e.link = `/images/${e.path}`; }],
    ["a link prefix with ..", (m) => { m.link_prefix = "../"; for (const e of m.images) if (e.link) e.link = `../${e.path}`; }],
    ["a link that is not prefix and path", (m) => { entry(m, "p1.1").link = "https://evil.example/x.webp"; }],
    ["an unknown field", (m) => { entry(m, "p1.1").alt = "<script>"; }],
    ["an unknown top-level field", (m) => { m.title = "Quarterly earnings"; }],
    ["an unknown status", (m) => { entry(m, "p1.1").status = "maybe"; }],
    ["an unknown fate", (m) => { entry(m, "p2.2").fate = "hidden"; }],
    ["an unknown reason", (m) => { entry(m, "p2.1").reason = "because"; }],
    ["resumable without a batch reason", (m) => { entry(m, "p2.1").resumable = true; m.resumable = true; m.complete = false; }],
    ["a copied source on a picture", (m) => { entry(m, "p1.1").source = "copy"; }],
    ["an id on another page", (m) => { entry(m, "p1.1").page = 2; }],
    ["a vector id on a picture", (m) => { entry(m, "p1.g1").kind = "picture"; }],
    ["a dangling repeat", (m) => { entry(m, "p2.1").repeat_of = "p9.9"; }],
    ["two images owning one file", (m) => { const e = entry(m, "p2.1"); Object.assign(e, { status: "extracted", reason: undefined, source: "render", bytes: entry(m, "p1.1").bytes, sha256: entry(m, "p1.1").sha256, width: 60, height: 40 }); m.totals.extracted += 1; m.totals.not_extracted -= 1; }],
    ["totals that disagree", (m) => { m.totals.images += 1; }],
    ["resumable at the top without a resumable image", (m) => { m.resumable = true; m.complete = false; }],
    ["a non-finite number", (m) => JSON.stringify(m).replace('"dpi":150', '"dpi":1e400')],
    ["a negative byte count", (m) => { entry(m, "p2.2").bytes = -1; }],
    ["a long string", (m) => { entry(m, "p1.1").error = "x".repeat(10_000); }],
    ["a sha256 that is not hex", (m) => { entry(m, "p1.1").sha256 = "Z".repeat(64); }],
    ["a complete manifest with a stopped batch", (m) => { m.batches[1]!.status = "timeout"; m.totals.batches_cut = 1; }],
    ["a complete manifest with an image a stopped batch left", (m) => { Object.assign(entry(m, "p2.1"), { reason: "renderer", repeat_of: undefined }); m.totals.repeats = 0; }],
    ["a decoded scan written as JPEG", (m) => { entry(m, "p3.1").source = "decode"; }],
    ["a picture over 8 MiB", (m) => { entry(m, "p1.1").bytes = 9 * 1024 * 1024; }],
    ["an extracted image at the path of the image it repeats", (m) => {
      const e = entry(m, "p1.g1");
      Object.assign(e, { kind: "vector", repeat_of: "p1.1", path: "page-0001/image-001.webp", link: "images/page-0001/image-001.webp" });
    }],
    ["a repeat of a repeat", (m) => {
      m.images.push({ ...entry(m, "p2.1"), id: "p2.3" , repeat_of: "p2.1" });
      m.totals.images += 1; m.totals.linked += 1; m.totals.not_extracted += 1; m.totals.repeats += 1;
    }],
    ["a repeat cycle", (m) => { entry(m, "p2.1").repeat_of = "p2.1"; }],
    ["totals.bytes that disagree", (m) => { m.totals.bytes += 1; }],
    ["totals.linked that disagree", (m) => { m.totals.linked += 1; }],
    ["totals.repeats that disagree", (m) => { m.totals.repeats = 0; }],
    ["totals.fallbacks that disagree", (m) => { m.totals.fallbacks = 0; }],
    ["totals.scans that disagree", (m) => { m.totals.scans = 0; }],
    ["totals.scan_bytes that disagree", (m) => { m.totals.scan_bytes += 1; }],
    ["totals.batches_cut that disagree", (m) => { m.totals.batches_cut = 1; }],
    ["a page outside the document", (m) => { entry(m, "p2.2").page = 4; entry(m, "p2.2").id = "p4.2"; }],
    ["an unknown scan_pages mode", (m) => { m.scan_pages = "copy-all"; }],
    ["scan-not-copyable on a not-extracted image", (m) => { entry(m, "p2.1").reason = "scan-not-copyable"; }],
    ["scan-not-copyable on an extracted image", (m) => { Object.assign(entry(m, "p3.1"), { reason: "scan-not-copyable" }); }],
    ["scan-not-copyable on an unlinked image that is not a background", (m) => { entry(m, "p2.2").reason = "scan-not-copyable"; }],
    ["a not-extracted reason on an unlinked image", (m) => { Object.assign(entry(m, "p2.2"), { fate: "background", reason: "copy" }); }],
  ];
  for (const [name, mutate] of cases) {
    it(`refuses ${name}`, async () => {
      expect(await rule(mutate)).toMatch(/^(manifest-invalid|page-outside-document)$/);
    });
  }

  it("the cases above are each the only change: the unchanged fixture passes", async () => {
    expect(await rule()).toBe("accepted");
  });

  it("accepts --scan-pages copy (Doppler #39) with an unlinked background scan, reason scan-not-copyable", async () => {
    expect(await rule((m) => { m.scan_pages = "copy"; Object.assign(entry(m, "p2.2"), { fate: "background", reason: "scan-not-copyable" }); })).toBe("accepted");
  });

  it("refuses an oversized manifest before parsing it (the cap scales with the page count)", async () => {
    expect(await rule((m) => JSON.stringify(m) + " ".repeat(dopplerAssetCaps(3).manifestBytes))).toBe("oversized-file");
  });

  it("refuses more entries than the document's cap", async () => {
    const extra = dopplerAssetCaps(3).entries;
    expect(await rule((m) => {
      const base = entry(m, "p2.2");
      for (let i = 0; i < extra; i += 1) m.images.push({ ...base, id: `p2.${i + 10}` });
      m.totals.images += extra; m.totals.unlinked += extra;
    })).toBe("too-many-entries");
  }, 60_000);

  it("refuses a link prefix other than the images/ folder the host asks for, and a manifest of another PDF", async () => {
    expect(await rule((m) => { m.link_prefix = "img/"; for (const e of m.images) if (e.link) e.link = `img/${e.path}`; })).toBe("link-prefix");
    expect(await rule(() => undefined, { sourceSha256: "c".repeat(64) })).toBe("source-mismatch");
    expect(await rule(() => undefined, { sourceSha256: "a".repeat(64) })).toBe("accepted");
  });

  it("refuses files the manifest does not name, misplaced files, links and nesting", async () => {
    expect(await rule((_m, files) => { files.set("page-0002/image-009.webp", files.get("page-0001/image-001.webp")!); })).toBe("files-do-not-match-manifest");
    expect(await rule((_m, files) => { files.set("page-0001/notes.txt", Buffer.from("x")); })).toBe("unexpected-file");
    expect(await rule((_m, files) => { files.set("p1.1.webp", files.get("page-0001/image-001.webp")!); })).toBe("unexpected-file");
    await rm(dir, { recursive: true, force: true });
    expect(await rule((_m, files) => { files.delete("page-0003/image-001.jpg"); })).toBe("files-do-not-match-manifest");
    await rm(dir, { recursive: true, force: true });
    expect(await rule((_m, files) => { files.set("page-0001/image-001.webp", Buffer.from("not a webp at all")); })).toMatch(/size-mismatch|sha256-mismatch/);
  });

  it("refuses a page folder that is a symlink or holds a directory", async () => {
    const { manifest, files } = v2Manifest();
    await writeV2Folder(dir, manifest, files);
    await mkdir(path.join(work, "elsewhere"));
    await symlink(path.join(work, "elsewhere"), path.join(dir, "page-0002"));
    await expect(readDopplerFigureDir(dir, { pageCount: 3 })).rejects.toMatchObject({ rule: "unexpected-entry" });
    await rm(path.join(dir, "page-0002"));
    await mkdir(path.join(dir, "page-0001", "deeper"));
    await expect(readDopplerFigureDir(dir, { pageCount: 3 })).rejects.toMatchObject({ rule: "unexpected-entry" });
  });

  it("refuses a hard link (a file with a second name, possibly outside the folder)", async () => {
    const { manifest, files } = v2Manifest();
    await writeV2Folder(dir, manifest, files);
    await link(path.join(dir, "page-0001", "image-001.webp"), path.join(work, "outside.webp"));
    await expect(readDopplerFigureDir(dir, { pageCount: 3 })).rejects.toMatchObject({ rule: "hard-link" });
  });

  it("refuses a page folder swapped for a symlink after the listing", async () => {
    const { manifest, files } = v2Manifest();
    await writeV2Folder(dir, manifest, files);
    const hooks = {
      afterListing: async () => {
        // Same files, outside the folder: the reader must not follow the swapped name out of it.
        await rename(path.join(dir, "page-0001"), path.join(work, "moved-page"));
        await symlink(path.join(work, "moved-page"), path.join(dir, "page-0001"));
      },
    };
    await expect(readDopplerFigureDir(dir, { pageCount: 3, hooks })).rejects.toBeInstanceOf(DopplerFigureRejection);
  });

  it("refuses a page folder with more entries than the file cap, without listing it whole", async () => {
    const { manifest, files } = v2Manifest();
    await writeV2Folder(dir, manifest, files);
    const cap = dopplerAssetCaps(3).files;
    await mkdir(path.join(dir, "page-0002"), { recursive: true });
    const names = Array.from({ length: cap + 5 }, (_, i) => path.join(dir, "page-0002", `image-${String(i + 100).padStart(5, "0")}.webp`));
    for (let i = 0; i < names.length; i += 256) await Promise.all(names.slice(i, i + 256).map((name) => writeFile(name, "")));
    await expect(readDopplerFigureDir(dir, { pageCount: 3 })).rejects.toMatchObject({ rule: "too-many-files" });
  }, 180_000);

  it("refuses a file that is a symlink inside a page folder", async () => {
    const { manifest, files } = v2Manifest();
    files.delete("page-0003/image-001.jpg");
    await writeV2Folder(dir, manifest, files);
    await writeFile(path.join(work, "secret.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]));
    await mkdir(path.join(dir, "page-0003"), { recursive: true });
    await symlink(path.join(work, "secret.jpg"), path.join(dir, "page-0003", "image-001.jpg"));
    await expect(readDopplerFigureDir(dir, { pageCount: 3 })).rejects.toMatchObject({ rule: "unexpected-entry" });
  });
});

describe("version 1 maps into the ledger with what it has", () => {
  it("files are extracted, repeats and errors not extracted, fate skips unlinked, unknown values other", () => {
    const parsed = parseDopplerManifest({
      version: "doppler-figures@1",
      images: [
        { id: "p1.1", page: 1, bbox: [0, 0, 10, 10], kind: "picture", fate: "block", file: "p1.1.webp", format: "webp", bytes: 20, sha256: "c".repeat(64), width: 6, height: 4 },
        { id: "p2.1", page: 2, bbox: [0, 0, 10, 10], kind: "picture", fate: "duplicate", file: null, format: null, bytes: null, sha256: null, width: null, height: null, repeat_of: "p1.1" },
        { id: "p2.2", page: 2, bbox: [0, 0, 10, 10], kind: "picture", fate: "watermark", file: null, format: null, bytes: null, sha256: null, width: null, height: null, skipped: "fate" },
        { id: "p3.g1", page: 3, bbox: [0, 0, 10, 10], kind: "vector", fate: "block", file: null, format: null, bytes: null, sha256: null, width: null, height: null, error: "pixels" },
        { id: "p3.2", page: 3, bbox: [0, 0, 10, 10], kind: "picture", fate: "mystery", file: null, format: null, bytes: null, sha256: null, width: null, height: null, skipped: "novel" },
        { id: "p4.1", page: 4, bbox: [0, 0, 10, 10], kind: "picture", fate: "page-scan", file: "p4.1.jpg", format: "jpg", bytes: 10, sha256: "d".repeat(64), width: 1700, height: 2200, fallback: "raster" },
        { id: "p5.1", page: 5, bbox: [0, 0, 10, 10], kind: "picture", fate: "block", file: "p5.1.jpg", format: "jpg", bytes: 10, sha256: "e".repeat(64), width: 17, height: 22 },
      ],
    });
    expect(parsed?.version).toBe(1);
    expect(dopplerLedgerAssets(parsed!).map((a) => [a.assetId, a.fate, a.status, a.reason, a.source, a.fileOf, a.fallback, a.linkPath])).toEqual([
      ["p1.1", "block", "extracted", null, "render", "p1.1", null, null],
      ["p2.1", "duplicate", "not-extracted", "repeat", null, "p1.1", null, null],
      ["p2.2", "watermark", "unlinked", null, null, null, null, null],
      ["p3.g1", "block", "not-extracted", "error", null, null, null, null],
      ["p3.2", "other", "not-extracted", "other", null, null, null, null],
      ["p4.1", "page-scan", "extracted", null, "copy", "p4.1", "other", null],
      // A version 1 JPEG is a copy of the PDF's stream only for a page scan.
      ["p5.1", "block", "extracted", null, "render", "p5.1", null, null],
    ]);
  });

  it("the v2 schema is strict about its own version", () => {
    expect(dopplerManifestV2Schema.safeParse({ ...v2Manifest().manifest, version: 3 }).success).toBe(false);
    expect(parseDopplerManifest({ ...v2Manifest().manifest, version: "2" })).toBeNull();
  });
});

describe("caps scale with the document (HIGH-1)", () => {
  it("accepts a scanned book of about 1 MiB JPEG pages past the old fixed 64 MiB total", async () => {
    const pages = 72;
    const jpeg = (n: number) => { const b = Buffer.alloc(1024 * 1024 - 4096 + n, 7); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[b.length - 2] = 0xff; b[b.length - 1] = 0xd9; return b; };
    const files = new Map<string, Buffer>();
    const images: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= pages; page += 1) {
      const rel = `page-${String(page).padStart(4, "0")}/image-001.jpg`;
      const bytes = jpeg(page);
      files.set(rel, bytes);
      images.push({ id: `p${page}.1`, page, bbox: [0, 0, 612, 792], kind: "picture", fate: "page-scan", obj: [page + 10, 0], path: rel, link: `images/${rel}`,
        status: "extracted", format: "jpg", source: "copy", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: 1700, height: 2200 });
    }
    const total = [...files.values()].reduce((sum, b) => sum + b.length, 0);
    expect(total).toBeGreaterThan(64 * 1024 * 1024);
    const { manifest } = v2Manifest();
    Object.assign(manifest, {
      images, batches: [{ pages: [1, 64], status: "ok" }, { pages: [65, 72], status: "ok" }],
      totals: { images: pages, linked: pages, extracted: pages, not_extracted: 0, unlinked: 0, bytes: total, repeats: 0, fallbacks: 0, scans: pages, scan_bytes: total, batches: 2, batches_cut: 0 },
    });
    await writeV2Folder(dir, manifest, files);
    const set = await readDopplerFigureDir(dir, { pageCount: pages, expect: "complete" });
    expect(set.files).toHaveLength(pages);
    // The same folder for a 3-page document is over that document's caps.
    await expect(readDopplerFigureDir(dir, { pageCount: 3 })).rejects.toBeInstanceOf(DopplerFigureRejection);
  }, 60_000);

  it("a copied page scan may pass 8 MiB (up to 64 MiB); a picture may not", async () => {
    const big = Buffer.alloc(20 * 1024 * 1024, 1); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff; big[big.length - 2] = 0xff; big[big.length - 1] = 0xd9;
    const sha = createHash("sha256").update(big).digest("hex");
    expect(await rule((m, files) => {
      files.set("page-0003/image-001.jpg", big);
      const scan = m.images.find((e) => e.id === "p3.1")!;
      m.totals.bytes += big.length - (scan.bytes as number); m.totals.scan_bytes = big.length;
      Object.assign(scan, { bytes: big.length, sha256: sha });
    })).toBe("accepted");
  }, 30_000);

  it("derives Doppler's flags from the same caps", () => {
    const limits = dopplerImageLimits(500);
    const caps = dopplerAssetCaps(500);
    expect(limits.imagesDocMaxBytes).toBe(caps.totalBytes);
    expect(limits.imagesMaxFileBytes).toBe(8 * 1024 * 1024);
    expect(limits.linkPrefix).toBe("images/");
    // Every batch at its budgets still fits the document's file cap.
    const batches = Math.ceil(500 / limits.batchPages);
    expect(batches * (limits.imagesMax + limits.scanMax)).toBeLessThanOrEqual(caps.files);
    expect(dopplerAssetCaps(1_000_000)).toMatchObject({ files: 32_768, totalBytes: 4 * 1024 ** 3, entries: 131_072, manifestBytes: 16 * 1024 ** 2 });
  });
});

describe("LOW-3: the legacy whole-JSON parse is reserved from the worker budget", () => {
  it("reserves about 10x the manifest's size while it parses, and releases it once the rows are spilled", async () => {
    const { manifest, files } = v2Manifest();
    await writeV2Folder(dir, manifest, files);
    const size = (await readFile(path.join(dir, "manifest.json"))).length;
    const budget = new ByteBudget(1024 * 1024 * 1024);
    const set = await readDopplerFigureDir(dir, { pageCount: 3, parseBudget: budget });
    expect(budget.peak).toBe(10 * size);
    expect(budget.inUse).toBe(0);
    expect(set.version).toBe(2);
    // A refused manifest releases its reservation too.
    await writeFile(path.join(dir, "manifest.json"), "{not json");
    await expect(readDopplerFigureDir(dir, { pageCount: 3, parseBudget: budget })).rejects.toMatchObject({ rule: "manifest-not-json" });
    expect(budget.inUse).toBe(0);
  });

  it("builds the index records from the rows it already computed (no second dopplerLedgerAssets pass)", () => {
    const parsed = parseDopplerManifest(v2Manifest().manifest)!;
    const rows = dopplerLedgerAssets(parsed).map((row) => ({ ...row, fileOf: row.fileOf ? "p3.1" : null }));
    expect(dopplerFigureRecords(parsed, rows).filter((r) => r.fileOf).every((r) => r.fileOf === "p3.1")).toBe(true);
  });
});
