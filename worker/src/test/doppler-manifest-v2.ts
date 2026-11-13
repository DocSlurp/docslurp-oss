/*
 * A small Doppler manifest version 2 images folder for tests: the shape `pdftomarkdown --images-dir` writes
 * (manifest.json plus page-NNNN/(image|figure)-NNN.<format> files), built in code so each test can bend one field.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const V2_SOURCE_SHA = "a".repeat(64);
export const V2_SETTINGS_SHA = "b".repeat(64);

function webp(payload = 8): Buffer {
  const body = Buffer.alloc(12 + payload);
  body.write("RIFF", 0, "latin1");
  body.writeUInt32LE(body.length - 8, 4);
  body.write("WEBP", 8, "latin1");
  return body;
}
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const jpg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const svg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><path d="M0 0L1 1"/></svg>');

export type V2Entry = Record<string, unknown>;
export interface V2Manifest {
  version: 2;
  images: V2Entry[];
  batches: Array<Record<string, unknown>>;
  totals: Record<string, number>;
  [key: string]: unknown;
}

const file = (bytes: Buffer) => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });

/**
 * Pages 1-3. p1.1 a WebP picture; p1.g1 an SVG figure; p2.1 repeats p1.1 (shares its path, no file); p2.2 furniture
 * (unlinked); p3.1 a copied JPEG page scan; and, when `partial`, p3.2 left by a budget-stopped batch (resumable).
 */
export function v2Manifest(options: { partial?: boolean } = {}): { manifest: V2Manifest; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>([
    ["page-0001/image-001.webp", webp()],
    ["page-0001/figure-001.svg", svg()],
    ["page-0003/image-001.jpg", jpg()],
  ]);
  const base = (id: string, page: number, kind: string, fate: string) => ({ id, page, bbox: [10, 20, 110, 220], kind, fate, obj: kind === "vector" ? null : [12, 0] });
  const linked = (p: string) => ({ path: p, link: `images/${p}` });
  const images: V2Entry[] = [
    { ...base("p1.1", 1, "picture", "block"), ...linked("page-0001/image-001.webp"), status: "extracted", format: "webp", source: "render", ...file(files.get("page-0001/image-001.webp")!), width: 60, height: 40 },
    { ...base("p1.g1", 1, "vector", "block"), ...linked("page-0001/figure-001.svg"), status: "extracted", format: "svg", source: "render", ...file(files.get("page-0001/figure-001.svg")!), width: 40, height: 30, fallback: "svg_allowlist" },
    { ...base("p2.1", 2, "picture", "block"), ...linked("page-0001/image-001.webp"), status: "not-extracted", reason: "repeat", repeat_of: "p1.1", format: "webp", source: null, bytes: 0, sha256: null, width: 0, height: 0 },
    { ...base("p2.2", 2, "picture", "furniture"), path: null, link: null, status: "unlinked", format: null, source: null, bytes: 0, sha256: null, width: 0, height: 0 },
    { ...base("p3.1", 3, "picture", "page-scan"), ...linked("page-0003/image-001.jpg"), status: "extracted", format: "jpg", source: "copy", ...file(files.get("page-0003/image-001.jpg")!), width: 1700, height: 2200 },
  ];
  if (options.partial) {
    images.push({ ...base("p3.2", 3, "picture", "inline"), ...linked("page-0003/image-002.webp"), status: "not-extracted", reason: "budget", resumable: true, format: "webp", source: null, bytes: 0, sha256: null, width: 0, height: 0 });
  }
  const count = (status: string) => images.filter((entry) => entry.status === status).length;
  const manifest: V2Manifest = {
    version: 2, source_sha256: V2_SOURCE_SHA, settings_sha256: V2_SETTINGS_SHA, resumes: 0, resumable: !!options.partial,
    link_prefix: "images/", dpi: 150, min_side_pt: 24, repeats: "skip", scan_pages: "image", scan_dpi: 200, scan_max_dpi: 300,
    batch_pages: 2, deadline_ms: 121_500, complete: !options.partial,
    batches: [{ pages: [1, 2], status: "ok" }, options.partial ? { pages: [3, 3], status: "budget", cut_page: 3 } : { pages: [3, 3], status: "ok" }],
    images,
    totals: {
      images: images.length, linked: images.filter((entry) => entry.path !== null).length, extracted: count("extracted"),
      not_extracted: count("not-extracted"), unlinked: count("unlinked"), bytes: [...files.values()].reduce((sum, b) => sum + b.length, 0),
      repeats: 1, fallbacks: 1, scans: 1, scan_bytes: files.get("page-0003/image-001.jpg")!.length, batches: 2, batches_cut: options.partial ? 1 : 0,
    },
  };
  return { manifest, files };
}

/** Write a manifest and its files into `dir` (created). */
export async function writeV2Folder(dir: string, manifest: unknown, files: ReadonlyMap<string, Buffer>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [relative, bytes] of files) {
    await mkdir(path.join(dir, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(dir, relative), bytes);
  }
  await writeFile(path.join(dir, "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
}

/**
 * The same images as `manifest.jsonl` (`doppler-images/3`): a header line, one image line per entry (in id order), one
 * batch line per batch, and the end line with the hash of every byte before it. `mutateLines` bends the text lines
 * before the end line is hashed (unless `rawEnd` replaces the end line too).
 */
export function v3Text(manifest: V2Manifest, options: { pages?: [number, number] | null; mutateLines?: (lines: string[]) => void; endPatch?: Record<string, unknown>; omitEnd?: boolean } = {}): string {
  const { version: _v, images, batches, totals, complete, resumable, ...rest } = manifest as V2Manifest & { complete: boolean; resumable: boolean };
  const header = {
    type: "header", schema: "doppler-images/3", source_sha256: rest.source_sha256, settings_sha256: rest.settings_sha256, link_prefix: rest.link_prefix,
    pages: options.pages ?? null, dpi: rest.dpi, min_side_pt: rest.min_side_pt, repeats: rest.repeats, scan_pages: rest.scan_pages, scan_dpi: rest.scan_dpi,
    scan_max_dpi: rest.scan_max_dpi, batch_pages: rest.batch_pages, deadline_ms: rest.deadline_ms, resumes: rest.resumes,
  };
  const lines = [JSON.stringify(header), ...images.map((entry) => JSON.stringify({ type: "image", ...entry })), ...batches.map((batch) => JSON.stringify({ type: "batch", pages: batch.pages, status: batch.status, cut_page: batch.cut_page ?? null }))];
  options.mutateLines?.(lines);
  const body = lines.map((line) => `${line}\n`).join("");
  if (options.omitEnd) return body;
  const end = { type: "end", complete, resumable, totals, images: images.length, batches: batches.length, sha256: createHash("sha256").update(body).digest("hex"), ...options.endPatch };
  return `${body}${JSON.stringify(end)}\n`;
}

/** Write a version 3 folder: `manifest.jsonl` and the page files. */
export async function writeV3Folder(dir: string, text: string, files: ReadonlyMap<string, Buffer>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [relative, bytes] of files) {
    await mkdir(path.join(dir, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(dir, relative), bytes);
  }
  await writeFile(path.join(dir, "manifest.jsonl"), text);
}
