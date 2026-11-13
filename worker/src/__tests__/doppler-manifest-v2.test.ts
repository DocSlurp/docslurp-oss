import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOPPLER_MANIFEST_V2_LIMITS, dopplerLedgerAssets, dopplerManifestV2Schema, parseDopplerManifest } from "@docslurp/shared";

import { DopplerFigureRejection, readDopplerFigureDir, storeDopplerFigures } from "../extractors/doppler-figures.js";
import { v2Manifest, writeV2Folder, type V2Manifest } from "../test/doppler-manifest-v2.js";

const DOC = { id: "0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b", userId: "user-1", runId: "run-1" };

let work: string;
let dir: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "doppler-v2-test-"));
  dir = path.join(work, "figures");
});
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

async function rule(mutate: (m: V2Manifest, files: Map<string, Buffer>) => unknown = () => undefined, options: { partial?: boolean; expect?: "complete" | "partial"; pageCount?: number } = {}): Promise<string> {
  const { manifest, files } = v2Manifest({ partial: options.partial });
  const replaced = mutate(manifest, files);
  await writeV2Folder(dir, replaced ?? manifest, files);
  try {
    await readDopplerFigureDir(dir, { pageCount: options.pageCount ?? 3, expect: options.expect });
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
    expect(set.manifest.version).toBe(2);
    expect(set.files.map((file) => [file.id, file.format])).toEqual([["p1.1", "webp"], ["p1.g1", "svg"], ["p3.1", "jpg"]]);
    expect(set.assets.map((a) => [a.assetId, a.status, a.reason, a.source, a.fileOf, a.linkPath])).toEqual([
      ["p1.1", "extracted", null, "render", "p1.1", "images/page-0001/image-001.webp"],
      ["p1.g1", "extracted", null, "render", "p1.g1", "images/page-0001/figure-001.svg"],
      ["p2.1", "not-extracted", "repeat", null, "p1.1", "images/page-0001/image-001.webp"],
      ["p2.2", "unlinked", null, null, null, null],
      ["p3.1", "extracted", null, "copy", "p3.1", "images/page-0003/image-001.jpg"],
    ]);
  });

  it("stores a version 2 file under a key derived from the id that owns it, not from its path", async () => {
    const { manifest, files } = v2Manifest();
    await writeV2Folder(dir, manifest, files);
    const set = await readDopplerFigureDir(dir, { pageCount: 3 });
    const keys: string[] = [];
    const stored = await storeDopplerFigures({
      storage: { putBytes: async (key) => { keys.push(key); }, putJson: async () => {}, uri: (key) => `s3://b/${key}` },
      document: DOC, runId: "run-1", figures: set, markdown: "![image](images/page-0001/image-001.webp)",
    });
    const root = `user-1/run-1/doppler-figures/${DOC.id}`;
    expect(keys).toEqual([`${root}/p1.1.webp`, `${root}/p1.g1.svg`, `${root}/p3.1.jpg`]);
    expect([...stored.keys]).toEqual([["p1.1", `${root}/p1.1.webp`], ["p1.g1", `${root}/p1.g1.svg`], ["p3.1", `${root}/p3.1.jpg`]]);
  });

  it("accepts a partial folder (exit 5) and keeps its resumable images", async () => {
    expect(await rule(() => undefined, { partial: true, expect: "partial" })).toBe("accepted");
    const set = await readDopplerFigureDir(dir, { pageCount: 3, expect: "partial" });
    expect(set.assets.find((a) => a.assetId === "p3.2")).toMatchObject({ status: "not-extracted", reason: "budget", resumable: true, fileOf: null });
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
    ["too many images", (m) => { m.images = Array.from({ length: DOPPLER_MANIFEST_V2_LIMITS.maxEntries + 1 }, (_, i) => ({ ...entry(m, "p2.2"), id: `p2.${i + 10}` })); }],
    ["a page outside the document", (m) => { entry(m, "p2.2").page = 4; entry(m, "p2.2").id = "p4.2"; }],
  ];
  for (const [name, mutate] of cases) {
    it(`refuses ${name}`, async () => {
      expect(await rule(mutate)).toMatch(/^(manifest-invalid|page-outside-document)$/);
    });
  }

  it("refuses an oversized manifest before parsing it", async () => {
    expect(await rule((m) => JSON.stringify(m) + " ".repeat(DOPPLER_MANIFEST_V2_LIMITS.maxManifestBytes))).toBe("oversized-file");
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
    ]);
  });

  it("the v2 schema is strict about its own version", () => {
    expect(dopplerManifestV2Schema.safeParse({ ...v2Manifest().manifest, version: 3 }).success).toBe(false);
    expect(parseDopplerManifest({ ...v2Manifest().manifest, version: "2" })).toBeNull();
  });
});
