/*
 * Doppler figures (`pdftomarkdown --images-dir`) on the worker host: the flag, the strict check of the folder a
 * sandboxed PDF provider returns, and storing the figures as document artifacts.
 *
 * The host never decodes or parses a figure. It reads the manifest (bounded JSON), reads each file's bytes to hash and
 * store them, and looks only at their leading signature bytes (WebP RIFF, PNG signature, SVG text prefix). SVGs were
 * reduced to an allowlist inside the VM (a correctness filter, not the boundary); serving them sandboxed is the boundary
 * (server routes/files.ts). File names are derived from
 * validated ids, never taken from the folder, and storage keys from database ids plus that id.
 *
 * Design: docs/extraction/doppler-figures.md.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DOPPLER_FIGURE_FILE_NAME, DOPPLER_FIGURE_LIMITS, DOPPLER_FIGURE_MEDIA_TYPES, DOPPLER_FIGURES_INDEX_SLOT, DOPPLER_FIGURES_INDEX_VERSION,
  DOPPLER_FIGURES_MANIFEST, DOPPLER_MANIFEST_V2_LIMITS, dopplerFigureFileName, dopplerImageExtractEnabled, dopplerFigureSlot,
  dopplerImageMarkerIds, dopplerLedgerAssets, parseDopplerManifest, type DocumentAsset, type DopplerFigureFormat, type DopplerFigureRecord,
  type DopplerManifest,
} from "@docslurp/shared";

import { documentArtifactRoot } from "../lib/artifact-root.js";

/** DOCSLURP_DOPPLER_IMAGE_EXTRACT (shared, so the provider plugin reads it the same way). */
export { dopplerImageExtractEnabled };

/** Refused folder: the message names the rule, never a path or anything read from the folder. */
export class DopplerFigureRejection extends Error {
  constructor(readonly rule: string) {
    super(`Doppler figures rejected: ${rule}`);
    this.name = "DopplerFigureRejection";
  }
}

export interface DopplerFigureFile {
  /** The image that owns the file (its id names the stored object). */
  id: string;
  format: DopplerFigureFormat;
  mediaType: string;
  bytes: Buffer;
  sha256: string;
}

export interface DopplerFigureSet {
  /** The parsed manifest, version 1 (`doppler-figures@1`) or 2 (Doppler's own). */
  manifest: DopplerManifest;
  /** One ledger row per image the manifest reports (storage keys are added when the files are stored). */
  assets: DocumentAsset[];
  files: DopplerFigureFile[];
}

/** How the provider says the figure step ended; the manifest must agree. */
export type DopplerFigureExpectation = "complete" | "partial";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Signature check on the leading bytes only; nothing is decoded. */
export function dopplerFigureMagicMatches(format: DopplerFigureFormat, bytes: Buffer): boolean {
  // JPEG: SOI then a marker, and the EOI marker at the end (a copied DCT stream is a whole JFIF/EXIF/bare file).
  if (format === "jpg") return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (format === "png") return bytes.length > PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  if (format === "webp") {
    // RIFF <size> WEBP, and the RIFF size must be the file's.
    return bytes.length >= 20 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP" &&
      bytes.readUInt32LE(4) + 8 === bytes.length;
  }
  // SVG: UTF-8 text that starts with the XML declaration or the root element (optionally after a BOM and whitespace).
  let start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (start < bytes.length && start < 64 && (bytes[start] === 0x20 || bytes[start] === 0x0a || bytes[start] === 0x0d || bytes[start] === 0x09)) start += 1;
  const head = bytes.toString("latin1", start, start + 6);
  return head.startsWith("<?xml ") || head.startsWith("<svg ") || head.startsWith("<svg\n") || head.startsWith("<svg>");
}

/** Read one regular file, refusing symlinks and anything whose size is not `expected` (at most `cap`). */
async function readExactFile(file: string, expected: number | null, cap: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new DopplerFigureRejection("unreadable-file");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new DopplerFigureRejection("not-a-regular-file");
    if (info.size > cap) throw new DopplerFigureRejection("oversized-file");
    if (expected !== null && info.size !== expected) throw new DopplerFigureRejection("size-mismatch");
    const buffer = Buffer.alloc(info.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== info.size) throw new DopplerFigureRejection("file-changed");
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

/** Version 2 page folders and the file names inside them. */
const PAGE_DIR = /^page-[0-9]{4,10}$/;
const PAGE_FILE = /^(?:image|figure)-[0-9]{3,7}\.(?:webp|svg|png|jpg)$/;

/**
 * Validate a provider's figure folder completely, or throw DopplerFigureRejection.
 *
 * Version 1 (`doppler-figures@1`): a real directory holding only `manifest.json` and `<id>.<format>` regular files.
 * Version 2 (Doppler's manifest): `manifest.json` and `page-NNNN` real directories holding only
 * `(image|figure)-NNN.<format>` regular files. Either way: no links, no other names or nesting; the manifest parses
 * strictly; every image's page is in the document; the files present are exactly the ones the manifest says were
 * extracted; each file's size equals `bytes` (within the caps), its SHA-256 equals `sha256`, and its leading bytes carry
 * its format's signature. `expect` is what the provider reported: a complete run (exit 0) must not hand back a partial
 * manifest, and a partial one (exit 5) must hand back a version 2 manifest that says it is incomplete.
 */
export async function readDopplerFigureDir(
  dir: string,
  args: { pageCount: number; signal?: AbortSignal; expect?: DopplerFigureExpectation },
): Promise<DopplerFigureSet> {
  const info = await lstat(dir).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new DopplerFigureRejection("not-a-directory");
  const listed = await readdir(dir, { withFileTypes: true });
  if (listed.length > DOPPLER_FIGURE_LIMITS.maxFiles + 1) throw new DopplerFigureRejection("too-many-files");
  const flat = new Set<string>();
  const pageDirs: string[] = [];
  let hasManifest = false;
  for (const dirent of listed) {
    if (dirent.isDirectory() && PAGE_DIR.test(dirent.name)) { pageDirs.push(dirent.name); continue; }
    if (!dirent.isFile()) throw new DopplerFigureRejection("unexpected-entry");
    if (dirent.name === DOPPLER_FIGURES_MANIFEST) { hasManifest = true; continue; }
    if (!DOPPLER_FIGURE_FILE_NAME.test(dirent.name)) throw new DopplerFigureRejection("unexpected-file");
    flat.add(dirent.name);
  }
  if (!hasManifest) throw new DopplerFigureRejection("missing-manifest");
  const raw = await readExactFile(path.join(dir, DOPPLER_FIGURES_MANIFEST), null, DOPPLER_MANIFEST_V2_LIMITS.maxManifestBytes);
  let json: unknown;
  try { json = JSON.parse(raw.toString("utf8")); } catch { throw new DopplerFigureRejection("manifest-not-json"); }
  const manifest = parseDopplerManifest(json);
  if (!manifest) throw new DopplerFigureRejection("manifest-invalid");
  if (manifest.version === 1 && raw.length > DOPPLER_FIGURE_LIMITS.maxManifestBytes) throw new DopplerFigureRejection("oversized-file");
  const complete = manifest.version === 1 || manifest.manifest.complete;
  if ((args.expect === "partial" && complete) || (args.expect === "complete" && !complete)) throw new DopplerFigureRejection("outcome-mismatch");
  const pageCount = Number.isSafeInteger(args.pageCount) && args.pageCount > 0 ? args.pageCount : 0;
  if (manifest.manifest.images.some((entry) => entry.page > pageCount)) throw new DopplerFigureRejection("page-outside-document");

  // Where each extracted image's file must be, relative to the folder, by the id that owns it.
  const expected = new Map<string, { id: string; format: DopplerFigureFormat; bytes: number; sha256: string }>();
  const present = new Set<string>();
  if (manifest.version === 1) {
    if (pageDirs.length > 0) throw new DopplerFigureRejection("unexpected-entry");
    for (const entry of manifest.manifest.images) {
      if (entry.file === null) continue;
      expected.set(dopplerFigureFileName(entry.id, entry.format!), { id: entry.id, format: entry.format!, bytes: entry.bytes!, sha256: entry.sha256! });
    }
    for (const name of flat) present.add(name);
  } else {
    if (flat.size > 0) throw new DopplerFigureRejection("unexpected-file");
    if (pageDirs.length > DOPPLER_MANIFEST_V2_LIMITS.maxPageDirs) throw new DopplerFigureRejection("too-many-files");
    for (const entry of manifest.manifest.images) {
      if (entry.status !== "extracted") continue;
      expected.set(entry.path!, { id: entry.id, format: entry.format!, bytes: entry.bytes, sha256: entry.sha256! });
    }
    for (const pageDir of pageDirs) {
      args.signal?.throwIfAborted();
      const inner = await readdir(path.join(dir, pageDir), { withFileTypes: true });
      if (present.size + inner.length > DOPPLER_FIGURE_LIMITS.maxFiles) throw new DopplerFigureRejection("too-many-files");
      for (const dirent of inner) {
        if (!dirent.isFile()) throw new DopplerFigureRejection("unexpected-entry");
        if (!PAGE_FILE.test(dirent.name)) throw new DopplerFigureRejection("unexpected-file");
        present.add(`${pageDir}/${dirent.name}`);
      }
    }
  }
  if (expected.size !== present.size || [...present].some((name) => !expected.has(name))) throw new DopplerFigureRejection("files-do-not-match-manifest");
  const files: DopplerFigureFile[] = [];
  let total = 0;
  for (const [relative, entry] of expected) {
    args.signal?.throwIfAborted();
    // `relative` comes from the validated manifest (a fixed pattern derived from ids), never from the listing.
    const bytes = await readExactFile(path.join(dir, relative), entry.bytes, DOPPLER_FIGURE_LIMITS.maxFileBytes);
    total += bytes.length;
    if (total > DOPPLER_FIGURE_LIMITS.maxTotalBytes) throw new DopplerFigureRejection("total-bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== entry.sha256) throw new DopplerFigureRejection("sha256-mismatch");
    if (!dopplerFigureMagicMatches(entry.format, bytes)) throw new DopplerFigureRejection("wrong-magic");
    files.push({ id: entry.id, format: entry.format, mediaType: DOPPLER_FIGURE_MEDIA_TYPES[entry.format], bytes, sha256 });
  }
  return { manifest, assets: dopplerLedgerAssets(manifest), files };
}

/** The storage key of one figure file: the document's tenant-scoped artifact root, the document id and the figure's file name. */
export function dopplerFigureStorageKey(document: { id: string; userId: string; runId: string; artifactRoot?: string | null }, runId: string, fileName: string): string {
  if (!DOPPLER_FIGURE_FILE_NAME.test(fileName) && fileName !== "index.json") throw new Error("Invalid Doppler figure file name");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(document.id)) throw new Error("Invalid document id for a figure key");
  return `${documentArtifactRoot(document, runId)}/doppler-figures/${document.id}/${fileName}`;
}

/** Index records: one per manifest entry, with the slot of the file it shows (its own, or the one it shares). */
export function dopplerFigureRecords(manifest: DopplerManifest): DopplerFigureRecord[] {
  if (manifest.version === 2) {
    const assets = dopplerLedgerAssets(manifest);
    return manifest.manifest.images.map((entry, i) => {
      const fileOf = assets[i]!.fileOf;
      const format = entry.status === "extracted" ? entry.format : null;
      return {
        id: entry.id, page: entry.page, bbox: entry.bbox, kind: entry.kind, fate: entry.fate, format,
        mediaType: format ? DOPPLER_FIGURE_MEDIA_TYPES[format] : null, bytes: entry.bytes, sha256: entry.sha256,
        width: entry.width, height: entry.height, fileOf, slot: fileOf ? dopplerFigureSlot(fileOf) : null,
        ...(entry.fallback === undefined ? {} : { fallback: entry.fallback }),
        ...(entry.error === undefined ? {} : { error: entry.error }),
        ...(entry.reason === undefined ? {} : { skipped: entry.reason }),
      };
    });
  }
  return manifest.manifest.images.map((entry) => {
    const fileOf = entry.file !== null ? entry.id : entry.repeat_of ?? null;
    return {
      id: entry.id, page: entry.page, bbox: entry.bbox, kind: entry.kind, fate: entry.fate, format: entry.format,
      mediaType: entry.format ? DOPPLER_FIGURE_MEDIA_TYPES[entry.format] : null, bytes: entry.bytes ?? 0, sha256: entry.sha256,
      width: entry.width, height: entry.height, fileOf, slot: fileOf ? dopplerFigureSlot(fileOf) : null,
      ...(entry.fallback === undefined ? {} : { fallback: entry.fallback }),
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(entry.skipped === undefined ? {} : { skipped: entry.skipped }),
    };
  });
}

export interface DopplerFigureStorage {
  putBytes(key: string, data: Uint8Array, contentType: string): Promise<void>;
  putJson(key: string, value: unknown): Promise<void>;
  uri(key: string): string;
  /** Removes partial uploads after a failed store; without it they stay unrecorded (unreachable) orphans. */
  deleteKeys?(keys: string[]): Promise<void>;
}

/** Why storing a validated figure set failed: a fixed slug for stage stats and telemetry, never the storage error text. */
export type DopplerFigureStoreFailure = "store-object-failed" | "store-index-failed";

/**
 * Storing figures failed part way. Nothing was recorded, so no figure (and no index) is reachable for the document;
 * `cleanup` says whether the objects written so far were deleted too.
 */
export class DopplerFigureStoreError extends Error {
  constructor(
    readonly reason: DopplerFigureStoreFailure,
    readonly cleanup: "deleted" | "failed" | "unavailable" | "none",
    options: { cause: unknown },
  ) {
    super(`Doppler figures were not stored (${reason})`, options);
    this.name = "DopplerFigureStoreError";
  }
}

export interface DopplerFigureStats {
  status: "stored";
  entries: number;
  files: number;
  bytes: number;
  byKind: Record<string, number>;
  byFormat: Record<string, number>;
  /** Marker ids in the stored Markdown, and how many of them the index resolves to a file. */
  markers: number;
  markersResolved: number;
  storeMs: number;
}

export interface StoredDopplerFigures {
  indexUri: string;
  /** Artifact slots to record for the document: the index and one per stored file. */
  slots: Array<{ slot: string; uri: string }>;
  /** Storage key of each stored file, by the id that owns it (for the asset ledger). */
  keys: Map<string, string>;
  stats: DopplerFigureStats;
}

/** Store validated figures and their index under the document's artifact root. */
export async function storeDopplerFigures(args: {
  storage: DopplerFigureStorage;
  document: { id: string; userId: string; runId: string; artifactRoot?: string | null };
  runId: string;
  figures: DopplerFigureSet;
  /** The stored Markdown: which markers it holds, and whether each names a stored figure. */
  markdown: string;
  signal?: AbortSignal;
}): Promise<StoredDopplerFigures> {
  const started = Date.now();
  const slots: StoredDopplerFigures["slots"] = [];
  const records = dopplerFigureRecords(args.figures.manifest);
  const keys = new Map<string, string>();
  const resolvable = new Set(records.filter((record) => record.fileOf).map((record) => record.id));
  const markers = dopplerImageMarkerIds(args.markdown);
  const indexKey = dopplerFigureStorageKey(args.document, args.runId, "index.json");
  // Files first, the index last: until the index is written (and the caller records the slots) the set is not visible.
  // Any failure removes what this call wrote, best effort, including an index whose write may have landed anyway.
  const written: string[] = [];
  let phase: DopplerFigureStoreFailure = "store-object-failed";
  try {
    for (const file of args.figures.files) {
      args.signal?.throwIfAborted();
      const key = dopplerFigureStorageKey(args.document, args.runId, dopplerFigureFileName(file.id, file.format));
      written.push(key);
      await args.storage.putBytes(key, file.bytes, file.mediaType);
      slots.push({ slot: dopplerFigureSlot(file.id), uri: args.storage.uri(key) });
      keys.set(file.id, key);
    }
    args.signal?.throwIfAborted();
    phase = "store-index-failed";
    written.push(indexKey);
    await args.storage.putJson(indexKey, {
      version: DOPPLER_FIGURES_INDEX_VERSION, documentId: args.document.id,
      // Ids the Markdown's markers name that this index resolves; the rest stay unresolved (text could imitate a marker).
      markers: markers.filter((id) => resolvable.has(id)),
      figures: records,
    });
    // A cancellation that arrived during the final write still cancels: nothing is recorded and what was written is removed.
    args.signal?.throwIfAborted();
  } catch (error) {
    let cleanup: DopplerFigureStoreError["cleanup"] = "none";
    if (written.length > 0) {
      if (!args.storage.deleteKeys) cleanup = "unavailable";
      else cleanup = await args.storage.deleteKeys(written).then(() => "deleted" as const, () => "failed" as const);
    }
    // Cancellation stays cancellation: the caller must stop the document, not record a figure failure.
    if (args.signal?.aborted) throw error;
    throw new DopplerFigureStoreError(phase, cleanup, { cause: error });
  }
  slots.unshift({ slot: DOPPLER_FIGURES_INDEX_SLOT, uri: args.storage.uri(indexKey) });
  const count = <K extends string>(values: K[]) => values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
  const stats: DopplerFigureStats = {
    status: "stored",
    entries: records.length,
    files: args.figures.files.length,
    bytes: args.figures.files.reduce((sum, file) => sum + file.bytes.length, 0),
    byKind: count(records.map((record) => record.kind)),
    byFormat: count(args.figures.files.map((file) => file.format)),
    markers: markers.length,
    markersResolved: markers.filter((id) => resolvable.has(id)).length,
    storeMs: Date.now() - started,
  };
  return { indexUri: args.storage.uri(indexKey), slots, keys, stats };
}
