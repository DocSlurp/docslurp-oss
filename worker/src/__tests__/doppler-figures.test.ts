import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOPPLER_FIGURE_LIMITS, DOPPLER_MANIFEST_V2_LIMITS, dopplerFigureUrls, imageAnchorsToAltText, resolveDopplerImageMarkers } from "@docslurp/shared";

import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";

import {
  DopplerFigureRejection, DopplerFigureStoreError, dopplerFigureMagicMatches, dopplerFigureStorageKey, dopplerImageExtractEnabled, readDopplerFigureDir, storeDopplerFigures,
} from "../extractors/doppler-figures.js";
import {
  acceptSandboxedPdfResult, assertExtractorPluginConfiguration, registerExtractorPlugin, resetExtractorPluginsForTest, sandboxedPdfFigures,
  type SandboxedPdfExtractorProvider, type SandboxedPdfJob,
} from "../extractors/plugins.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "doppler-figures");
const DOC = { id: "0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b", userId: "user-1", runId: "run-1" };

let work: string;
let dir: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "doppler-figures-test-"));
  dir = path.join(work, "figures");
  await cp(FIXTURE, dir, { recursive: true });
});
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

async function manifest(): Promise<{ version: string; images: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
}
async function writeManifest(value: unknown): Promise<void> {
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(value));
}
async function rejection(pageCount = 10): Promise<string> {
  try {
    await readDopplerFigureDir(dir, { pageCount });
  } catch (error) {
    if (error instanceof DopplerFigureRejection) return error.rule;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("storeDopplerFigures: a failed upload stores nothing", () => {
  const recordingStorage = (fail: { bytes?: string; json?: boolean }, withDelete = true) => {
    const live = new Set<string>();
    const storage = {
      putBytes: vi.fn(async (key: string) => { if (fail.bytes && key.endsWith(fail.bytes)) throw new Error("boom"); live.add(key); }),
      putJson: vi.fn(async (key: string) => { live.add(key); if (fail.json) throw new Error("boom"); }),
      uri: (key: string) => `s3://bucket/${key}`,
      ...(withDelete ? { deleteKeys: vi.fn(async (keys: string[]) => { for (const key of keys) live.delete(key); }) } : {}),
    };
    return { storage, live };
  };

  it("an object failure deletes the files already written and names the phase", async () => {
    const set = await readDopplerFigureDir(dir, { pageCount: 5 });
    const { storage, live } = recordingStorage({ bytes: "/p5.g1.png" });
    const error = await storeDopplerFigures({ storage, document: DOC, runId: "run-1", figures: set, markdown: "" }).catch((e) => e);
    expect(error).toBeInstanceOf(DopplerFigureStoreError);
    expect(error).toMatchObject({ reason: "store-object-failed", cleanup: "deleted" });
    expect(storage.putJson).not.toHaveBeenCalled();
    expect(live.size).toBe(0);
  });

  it("an index failure deletes the files and the index, even when the index write landed", async () => {
    const set = await readDopplerFigureDir(dir, { pageCount: 5 });
    const { storage, live } = recordingStorage({ json: true });
    const error = await storeDopplerFigures({ storage, document: DOC, runId: "run-1", figures: set, markdown: "" }).catch((e) => e);
    expect(error).toMatchObject({ reason: "store-index-failed", cleanup: "deleted" });
    expect(live.size).toBe(0);
  });

  it("without deleteKeys the failure still reports, with cleanup unavailable", async () => {
    const set = await readDopplerFigureDir(dir, { pageCount: 5 });
    const { storage } = recordingStorage({ json: true }, false);
    await expect(storeDopplerFigures({ storage, document: DOC, runId: "run-1", figures: set, markdown: "" }))
      .rejects.toMatchObject({ reason: "store-index-failed", cleanup: "unavailable" });
  });

  it("cancellation stays an abort, not a figure failure", async () => {
    const set = await readDopplerFigureDir(dir, { pageCount: 5 });
    const controller = new AbortController();
    const { storage, live } = recordingStorage({});
    storage.putBytes.mockImplementationOnce(async (key: string) => { live.add(key); controller.abort(); });
    const error = await storeDopplerFigures({ storage, document: DOC, runId: "run-1", figures: set, markdown: "", signal: controller.signal }).catch((e) => e);
    expect(error).not.toBeInstanceOf(DopplerFigureStoreError);
    expect(error.name).toBe("AbortError");
    expect(live.size).toBe(0);
  });

  it("cancellation during a successful final index write records no slots and removes everything written", async () => {
    const set = await readDopplerFigureDir(dir, { pageCount: 5 });
    const controller = new AbortController();
    const { storage, live } = recordingStorage({});
    storage.putJson.mockImplementationOnce(async (key: string) => { live.add(key); controller.abort(); });
    const error = await storeDopplerFigures({ storage, document: DOC, runId: "run-1", figures: set, markdown: "", signal: controller.signal }).catch((e) => e);
    expect(error).not.toBeInstanceOf(DopplerFigureStoreError);
    expect(error.name).toBe("AbortError");
    expect(storage.deleteKeys).toHaveBeenCalledTimes(1);
    expect(live.size).toBe(0);
  });
});

describe("readDopplerFigureDir: the happy path", () => {
  it("accepts the fixture folder: raster, vector, PNG fallback, a repeat and a failed figure", async () => {
    const set = await readDopplerFigureDir(dir, { pageCount: 5 });
    expect(set.assets.map((e) => e.assetId)).toEqual(["p3.1", "p3.g2", "p4.1", "p5.g1", "p5.2"]);
    expect(set.files.map((f) => [f.id, f.format, f.mediaType])).toEqual([
      ["p3.1", "webp", "image/webp"], ["p3.g2", "svg", "image/svg+xml"], ["p5.g1", "png", "image/png"],
    ]);
    for (const file of set.files) expect(createHash("sha256").update(file.bytes).digest("hex")).toBe(file.sha256);
  });

  it("stores figures under the document's artifact root, keyed by ids, with an index and slots", async () => {
    const set = await readDopplerFigureDir(dir, { pageCount: 5 });
    const put = new Map<string, { bytes: Buffer; type: string }>();
    const json = new Map<string, unknown>();
    const storage = {
      putBytes: vi.fn(async (key: string, data: Uint8Array, type: string) => { put.set(key, { bytes: Buffer.from(data), type }); }),
      putJson: vi.fn(async (key: string, value: unknown) => { json.set(key, value); }),
      uri: (key: string) => `s3://bucket/${key}`,
    };
    const markdown = "A\n\n![image](doppler-image:p3.1)\n\n![image](doppler-image:p3.g2)\f![image](doppler-image:p4.1)\f![image](doppler-image:p5.2) ![image](doppler-image:p9.9)";
    const stored = await storeDopplerFigures({ storage, document: DOC, runId: "run-1", figures: set, markdown });
    const root = `user-1/run-1/doppler-figures/${DOC.id}`;
    expect([...put.keys()]).toEqual([`${root}/p3.1.webp`, `${root}/p3.g2.svg`, `${root}/p5.g1.png`]);
    expect(put.get(`${root}/p3.g2.svg`)!.type).toBe("image/svg+xml");
    expect(stored.slots).toEqual([
      { slot: "doppler-figures", uri: `s3://bucket/${root}/index.json` },
      { slot: "doppler-figure:p3.1", uri: `s3://bucket/${root}/p3.1.webp` },
      { slot: "doppler-figure:p3.g2", uri: `s3://bucket/${root}/p3.g2.svg` },
      { slot: "doppler-figure:p5.g1", uri: `s3://bucket/${root}/p5.g1.png` },
    ]);
    const index = json.get(`${root}/index.json`) as { markers: string[]; figures: Array<{ id: string; fileOf: string | null; slot: string | null; bbox: number[] }> };
    // p5.2 failed (no file) and p9.9 is not in the manifest: neither marker resolves.
    expect(index.markers).toEqual(["p3.1", "p3.g2", "p4.1"]);
    expect(index.figures.find((f) => f.id === "p4.1")).toMatchObject({ fileOf: "p3.1", slot: "doppler-figure:p3.1" });
    expect(index.figures.find((f) => f.id === "p5.2")).toMatchObject({ fileOf: null, slot: null });
    expect(index.figures.find((f) => f.id === "p3.g2")!.bbox).toEqual([72, 300, 112, 330]);
    expect(stored.stats).toMatchObject({ status: "stored", entries: 5, files: 3, markers: 5, markersResolved: 3, byFormat: { webp: 1, svg: 1, png: 1 } });
  });

  it("builds keys only from ids", () => {
    expect(dopplerFigureStorageKey(DOC, "run-1", "p3.1.webp")).toBe(`user-1/run-1/doppler-figures/${DOC.id}/p3.1.webp`);
    expect(dopplerFigureStorageKey({ ...DOC, artifactRoot: "extracts/org-1/ex-1" }, "run-1", "p3.1.webp")).toBe(`extracts/org-1/ex-1/doppler-figures/${DOC.id}/p3.1.webp`);
    expect(() => dopplerFigureStorageKey(DOC, "run-1", "../../x.webp")).toThrow();
    expect(() => dopplerFigureStorageKey({ ...DOC, id: "../other" }, "run-1", "p3.1.webp")).toThrow();
  });
});

describe("readDopplerFigureDir: hostile folders", () => {
  it("refuses an extra file in the folder", async () => {
    await writeFile(path.join(dir, "notes.txt"), "x");
    expect(await rejection()).toBe("unexpected-file");
  });

  it("refuses an extra figure file the manifest does not name, and a named file that is missing", async () => {
    await writeFile(path.join(dir, "p7.1.webp"), "RIFF");
    expect(await rejection()).toBe("files-do-not-match-manifest");
    await rm(path.join(dir, "p7.1.webp"));
    await rm(path.join(dir, "p3.1.webp"));
    expect(await rejection()).toBe("files-do-not-match-manifest");
  });

  it("refuses subdirectories and symlinks, including a symlinked figure", async () => {
    await mkdir(path.join(dir, "p8.1.webp"));
    expect(await rejection()).toBe("unexpected-entry");
    await rm(path.join(dir, "p8.1.webp"), { recursive: true });
    await rm(path.join(dir, "p3.1.webp"));
    await symlink("/etc/passwd", path.join(dir, "p3.1.webp"));
    expect(await rejection()).toBe("unexpected-entry");
  });

  it("refuses a symlinked folder", async () => {
    const link = path.join(work, "link");
    await symlink(dir, link);
    await expect(readDopplerFigureDir(link, { pageCount: 10 })).rejects.toMatchObject({ rule: "not-a-directory" });
  });

  it.each([
    ["path traversal file name", { file: "../../../etc/passwd" }],
    ["absolute file name", { file: "/etc/passwd" }],
    ["file name not derived from the id", { file: "p3.2.webp" }],
    ["traversal id", { id: "../p3.1", file: "../p3.1.webp" }],
    ["unknown field", { path: "/tmp/x" }],
    ["unknown format", { format: "html", file: "p3.1.html" }],
  ])("refuses a manifest with a %s", async (_name, patch) => {
    const value = await manifest();
    Object.assign(value.images[0]!, patch);
    await writeManifest(value);
    expect(await rejection()).toBe("manifest-invalid");
  });

  it("refuses a manifest that is not JSON, is oversized or is missing", async () => {
    await writeFile(path.join(dir, "manifest.json"), "{nope");
    expect(await rejection()).toBe("manifest-not-json");
    await writeFile(path.join(dir, "manifest.json"), Buffer.alloc(DOPPLER_MANIFEST_V2_LIMITS.maxManifestBytes + 1, 0x20));
    expect(await rejection()).toBe("oversized-file");
    // A valid version 1 manifest past version 1's own cap (whitespace keeps it valid JSON) is refused too.
    const v1 = Buffer.from(JSON.stringify(await JSON.parse(await readFile(path.join(FIXTURE, "manifest.json"), "utf8"))));
    await writeFile(path.join(dir, "manifest.json"), Buffer.concat([v1, Buffer.alloc(DOPPLER_FIGURE_LIMITS.maxManifestBytes, 0x20)]));
    expect(await rejection()).toBe("oversized-file");
    await rm(path.join(dir, "manifest.json"));
    expect(await rejection()).toBe("missing-manifest");
  });

  it("refuses an oversized figure file, whatever the manifest claims", async () => {
    const big = Buffer.alloc(DOPPLER_FIGURE_LIMITS.maxFileBytes + 1);
    big.write("RIFF", 0, "latin1");
    await writeFile(path.join(dir, "p3.1.webp"), big);
    expect(await rejection()).toBe("oversized-file");
    const value = await manifest();
    value.images[0]!.bytes = DOPPLER_FIGURE_LIMITS.maxFileBytes + 1;
    await writeManifest(value);
    expect(await rejection()).toBe("manifest-invalid");
  });

  it("refuses a file whose size or hash does not match the manifest", async () => {
    const original = await readFile(path.join(dir, "p3.1.webp"));
    await writeFile(path.join(dir, "p3.1.webp"), Buffer.concat([original, Buffer.from("x")]));
    expect(await rejection()).toBe("size-mismatch");
    const flipped = Buffer.from(original);
    flipped[flipped.length - 1] ^= 0xff;
    await writeFile(path.join(dir, "p3.1.webp"), flipped);
    expect(await rejection()).toBe("sha256-mismatch");
  });

  it("refuses wrong magic: HTML posing as SVG, PNG posing as WebP", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>\n");
    const png = await readFile(path.join(dir, "p5.g1.png"));
    for (const [id, bytes] of [["p3.g2", html], ["p3.1", png]] as const) {
      await cp(FIXTURE, dir, { recursive: true, force: true });
      const value = await manifest();
      const entry = value.images.find((e) => e.id === id)!;
      Object.assign(entry, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      await writeManifest(value);
      await writeFile(path.join(dir, entry.file as string), bytes);
      expect(await rejection(), id).toBe("wrong-magic");
    }
  });

  it("refuses figures on pages outside the document", async () => {
    expect(await rejection(4)).toBe("page-outside-document");
  });

  it("checks signatures on leading bytes only", () => {
    expect(dopplerFigureMagicMatches("svg", Buffer.from("﻿  <?xml version=\"1.0\"?><svg/>"))).toBe(true);
    expect(dopplerFigureMagicMatches("svg", Buffer.from("<svgx>"))).toBe(false);
    // Scans copied out unchanged: a whole JPEG (SOI ... EOI), never a truncated one or a PNG named .jpg.
    expect(dopplerFigureMagicMatches("jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]))).toBe(true);
    expect(dopplerFigureMagicMatches("jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe(false);
    expect(dopplerFigureMagicMatches("jpg", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xd9]))).toBe(false);
    expect(dopplerFigureMagicMatches("svg", Buffer.from("<!DOCTYPE svg><svg/>"))).toBe(false);
    expect(dopplerFigureMagicMatches("webp", Buffer.from("RIFF\x04\x00\x00\x00WEBP", "latin1"))).toBe(false);
    expect(dopplerFigureMagicMatches("png", Buffer.from("\x89PNG", "latin1"))).toBe(false);
  });
});

describe("DOCSLURP_DOPPLER_IMAGE_EXTRACT", () => {
  it("is off unless set, and loud on a typo", () => {
    expect(dopplerImageExtractEnabled({})).toBe(false);
    expect(dopplerImageExtractEnabled({ DOCSLURP_DOPPLER_IMAGE_EXTRACT: "0" })).toBe(false);
    expect(dopplerImageExtractEnabled({ DOCSLURP_DOPPLER_IMAGE_EXTRACT: "on" })).toBe(true);
    expect(() => dopplerImageExtractEnabled({ DOCSLURP_DOPPLER_IMAGE_EXTRACT: "yes please" })).toThrow();
  });
});

describe("plugin contract", () => {
  const provider = (figures: boolean): SandboxedPdfExtractorProvider => ({
    id: "test-vm", maxSourceBytes: 1024, assertConfigured() {}, timeoutMs: () => 1000,
    run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    ...(figures ? { figures: { producerId: "test-figures" } } : {}),
  });
  afterEach(() => resetExtractorPluginsForTest());

  it("refuses to start with the flag on but no VM route or a provider without figures", () => {
    const vm = { DOCSLURP_PDF_MODE: "vm", DOCSLURP_DOPPLER_IMAGE_EXTRACT: "1" };
    expect(() => assertExtractorPluginConfiguration({ DOCSLURP_DOPPLER_IMAGE_EXTRACT: "1" })).toThrow(/DOCSLURP_DOPPLER_IMAGE_EXTRACT/);
    registerExtractorPlugin({ apiVersion: 1, name: "test", sandboxedPdf: provider(false) });
    expect(() => assertExtractorPluginConfiguration(vm)).toThrow(/returns Doppler figures/);
    resetExtractorPluginsForTest();
    registerExtractorPlugin({ apiVersion: 1, name: "test", sandboxedPdf: provider(true) });
    expect(() => assertExtractorPluginConfiguration(vm)).not.toThrow();
    // Flag off: a provider with figures changes nothing.
    expect(() => assertExtractorPluginConfiguration({ DOCSLURP_PDF_MODE: "vm" })).not.toThrow();
  });

  it("keeps the figure outcome per job, bounds the raw reason and refuses unrequested figures", () => {
    const asked: SandboxedPdfJob = { input: "/in", output: "/out", figures: { dir: "/out.figures" } };
    acceptSandboxedPdfResult(asked, { stdout: "", stderr: "", exitCode: 0, figures: { status: "extracted" } }, 3);
    expect(sandboxedPdfFigures(asked)).toEqual({ status: "extracted" });
    acceptSandboxedPdfResult(asked, { stdout: "", stderr: "", exitCode: 0, figures: { status: "failed", reason: `pdfregions\u0000 ${"x".repeat(900)}` } }, 3);
    const failed = sandboxedPdfFigures(asked) as { status: "failed"; reason: string };
    expect(failed.status).toBe("failed");
    expect(failed.reason.length).toBe(500);
    expect(failed.reason).not.toContain("\u0000");
    acceptSandboxedPdfResult(asked, { stdout: "", stderr: "", exitCode: 0 }, 3);
    expect(sandboxedPdfFigures(asked)).toEqual({ status: "failed", reason: "provider-reported-no-figure-outcome" });
    const plain: SandboxedPdfJob = { input: "/in", output: "/out" };
    expect(acceptSandboxedPdfResult(plain, { stdout: "", stderr: "", exitCode: 0 }, 3).figures).toBeUndefined();
    expect(sandboxedPdfFigures(plain)).toBeUndefined();
    expect(() => acceptSandboxedPdfResult(plain, { stdout: "", stderr: "", exitCode: 0, figures: { status: "extracted" } }, 3)).toThrow(/unrequested/);
  });
});

describe("markers in text", () => {
  const md = "Intro\n\n![image](doppler-image:p3.1)\n\nAn icon ![image](doppler-image:p3.g2) inline.";

  it("drops markers from embedding and summary text", () => {
    expect(imageAnchorsToAltText(md)).toBe("Intro\n\n\nAn icon  inline.");
    expect(imageAnchorsToAltText("plain")).toBe("plain");
  });

  it("makes a marker line its own empty image block that keeps the id", () => {
    const doc = buildCanonicalDocumentFromMarkdown({ documentId: "doc-1", text: md, pageCount: 1, sourceArtifactUri: "s3://b/doc.md", extractor: "vm-pdf" });
    const figure = doc.blocks.find((block) => block.metadata.dopplerImageId === "p3.1");
    expect(figure).toMatchObject({ text: "", metadata: { extractor: "doppler-figure" } });
    expect(doc.blocks.map((block) => block.text).join("\n")).not.toContain("doppler-image");
  });
});

describe("golden folders from a real Doppler run (fixtures/doppler-golden, see PROVENANCE.json)", () => {
  const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "doppler-golden");
  // What the guest does to Doppler's manifest (worker-plugins/doppler guest collect_figures): keep the documented fields.
  const FIELDS = ["id", "page", "bbox", "kind", "fate", "file", "format", "bytes", "sha256", "width", "height", "repeat_of", "fallback", "error", "skipped"];
  async function asGuestHandsIt(name: string): Promise<{ folder: string; markdown: string }> {
    const folder = path.join(work, name);
    await cp(path.join(GOLDEN, name, "figures"), folder, { recursive: true });
    const raw = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8")) as { version: number; images: Array<Record<string, unknown>> };
    expect(raw.version).toBe(1); // Doppler's own manifest version
    const images = raw.images.map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => FIELDS.includes(key))));
    await writeFile(path.join(folder, "manifest.json"), JSON.stringify({ version: "doppler-figures@1", images }));
    return { folder, markdown: await readFile(path.join(GOLDEN, name, "doc.md"), "utf8") };
  }
  async function storeAndResolve(name: string, pageCount: number) {
    const { folder, markdown } = await asGuestHandsIt(name);
    const set = await readDopplerFigureDir(folder, { pageCount });
    const json = new Map<string, any>();
    const storage = { putBytes: async () => {}, putJson: async (key: string, value: unknown) => { json.set(key, value); }, uri: (key: string) => `s3://bucket/${key}` };
    const stored = await storeDopplerFigures({ storage, document: DOC, runId: "run-1", figures: set, markdown });
    const index = [...json.values()][0] as { figures: Array<{ id: string; fileOf: string | null; skipped?: string }> };
    const artifacts = stored.slots.map(({ slot, uri }) => ({ slot: `${DOC.id}:${slot}`, url: `/v1/files/t/${uri.split("/").pop()}` }));
    const urls = dopplerFigureUrls(DOC.id, artifacts, index.figures);
    return { set, index, markdown, resolved: resolveDopplerImageMarkers(markdown, (id) => urls.get(id)), urls };
  }

  it("repeats (link mode): every marker resolves, repeats to their first figure's file", async () => {
    const { set, index, resolved, urls } = await storeAndResolve("repeats", 4);
    expect(set.files.map((f) => f.id)).toEqual(["p1.1", "p3.1"]);
    expect(index.figures.filter((f) => f.skipped === "repeat").map((f) => [f.id, f.fileOf])).toEqual([["p2.1", "p1.1"], ["p3.2", "p3.1"], ["p4.1", "p1.1"]]);
    expect(urls.get("p4.1")).toBe("/v1/files/t/p1.1.webp");
    expect(resolved).not.toContain("doppler-image:");
    expect(resolved.match(/!\[image\]\(\/v1\/files\/t\/p[13]\.1\.webp\)/g)).toHaveLength(5);
  });

  it("typst: a raster and an SVG resolve; figures Doppler skipped by fate keep `skipped` and no file", async () => {
    const { set, index, resolved } = await storeAndResolve("typst", 4);
    expect(set.files.map((f) => [f.id, f.mediaType])).toEqual([["p1.1", "image/webp"], ["p3.g1", "image/svg+xml"]]);
    expect(index.figures.filter((f) => f.skipped).map((f) => [f.id, f.skipped, f.fileOf])).toEqual([["p2.1", "fate", null], ["p4.1", "fate", null]]);
    expect(resolved).toContain("](/v1/files/t/p3.g1.svg)");
    expect(resolved).not.toContain("doppler-image:");
  });

  it("refuses the raw Doppler manifest: only the guest's doppler-figures@1 shape crosses", async () => {
    const folder = path.join(work, "raw");
    await cp(path.join(GOLDEN, "repeats", "figures"), folder, { recursive: true });
    await expect(readDopplerFigureDir(folder, { pageCount: 4 })).rejects.toMatchObject({ rule: "manifest-invalid" });
  });
});

describe("continuation comments in canonical blocks", () => {
  it("never become block text", () => {
    const md = "Intro of the masked<!-- doppler:paragraph-continued -->\n\n<!-- doppler:table-continued header=repeated -->\n\nword based objective.";
    const doc = buildCanonicalDocumentFromMarkdown({ documentId: "doc-1", text: md, pageCount: 1, sourceArtifactUri: "s3://b/doc.md", extractor: "vm-pdf" });
    expect(doc.blocks.map((block) => block.text)).toEqual(["Intro of the masked", "word based objective."]);
  });
});
