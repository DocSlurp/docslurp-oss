/*
 * Doppler images (`pdftomarkdown --images-dir`) on the worker host: the flag, the strict check of the folder a sandboxed
 * PDF provider returns, and storing it in object storage in Doppler's own layout (DOPPLER_STORE_LAYOUT).
 *
 * The host never decodes or parses an image. It reads the manifest (version 3 `manifest.jsonl` line by line in fixed
 * memory; legacy version 1 and 2 `manifest.json` whole, bounded), streams each file to storage while it hashes it and
 * checks its leading signature bytes, and verifies every file against the manifest before its upload may complete. SVGs
 * were reduced to an allowlist inside the VM (a correctness filter, not the boundary); serving them sandboxed is the
 * boundary (server routes/files.ts). Paths are derived from validated ids, never taken from the folder, and storage keys
 * from the document's tenant-scoped artifact root plus that path.
 *
 * Memory: the ledger rows go to a spill file as they are read (the ledger write streams them back after the checkpoint),
 * and file bytes in RAM are bounded by a fixed budget (extractors/doppler-upload.ts), whatever the document's size.
 *
 * Design: docs/extraction/doppler-figures.md.
 */
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, readdir, realpath, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  DOPPLER_FIGURE_FILE_NAME, DOPPLER_FIGURE_LIMITS, DOPPLER_FIGURE_MEDIA_TYPES, DOPPLER_FIGURES_INDEX_SLOT, DOPPLER_FIGURES_INDEX_VERSION,
  DOPPLER_FIGURES_MANIFEST, DOPPLER_MANIFEST_V3_FILE, DOPPLER_MANIFEST_V3_LINE_BYTES, DOPPLER_MANIFEST_V2_LIMITS, DOPPLER_STORE_LAYOUT,
  DOPPLER_SHARDS_MAX, dopplerShardCoverage, type DopplerFigureGap, DopplerManifestV3Error, DopplerManifestV3Validator, dopplerShardFolder, parseDopplerShardFolder, addDocumentAssetCount, dopplerAssetCaps, dopplerAssetPath, dopplerAssetStorageKey,
  dopplerDocumentPrefix, dopplerEntryFileCap, dopplerFigureSlot, dopplerImageExtractEnabled, dopplerImageMarkerIds, dopplerLedgerAssets,
  dopplerManifestRunFacts, dopplerManifestV3RunFacts, emptyDocumentAssetCounts, parseDopplerFigureId, parseDopplerManifest,
  type DocumentAsset, type DocumentAssetCounts, type DopplerAssetCaps, type DopplerFigureFormat, type DopplerFigureRecord,
  type DopplerManifest, type DopplerManifestRunFacts, type DopplerManifestV3Header,
} from "@docslurp/shared";

import { isMissingObject as isMissingObjectError, objectDigest, type FigureObjectReader } from "../db/document-asset-ledger.js";
import { documentArtifactRoot } from "../lib/artifact-root.js";
import {
  StreamCheckError, boundedPool, checkedFileStream, dopplerFigureBufferBytes, dopplerFigureUploadConcurrency, dopplerWorkerBudget, reserve,
  ByteBudget, DOPPLER_UPLOAD_CHUNK_BYTES, DOPPLER_UPLOAD_SMALL_FILE_BYTES, type StreamCheck,
} from "./doppler-upload.js";

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
  /** Where the file is in the provider's folder (from the validated manifest, never from the listing). */
  relative: string;
  /** Its size (checked at read time) and SHA-256 as the manifest states them (checked while it uploads). */
  size: number;
  sha256: string;
  /** The largest this file may be (8 MiB, or 64 MiB for a copied or decoded page scan). */
  cap: number;
}

/** One manifest of the folder: where it is, its size and SHA-256, and (for a shard) its page range and own facts. */
export interface DopplerManifestFile {
  relative: string;
  size: number;
  sha256: string;
  range: [number, number] | null;
  run: DopplerManifestRunFacts | null;
  complete: boolean;
  /** Images of this manifest a resume would retry. */
  resumable: number;
}

/** One spilled ledger row (JSON line) with the index record fields only the index needs. */
interface SpillLine { r: DocumentAsset; x?: DopplerFigureRecord }

export interface DopplerFigureSet {
  /** The folder the set was read from (quiescent: the provider's VM has exited). */
  dir: string;
  version: 1 | 2 | 3;
  /**
   * The manifests, stored unchanged: one (`manifest.json`, or `manifest.jsonl` for version 3), or one per shard
   * (`shards/<first>-<last>/manifest.jsonl`, version 3 only) when the provider converted the document in page ranges.
   */
  manifests: DopplerManifestFile[];
  /** Run facts of the whole folder (version 2 and 3; null for version 1); for shards, the shared fields only. */
  run: DopplerManifestRunFacts | null;
  /** Every manifest says complete. */
  complete: boolean;

  /** The files to store; no bytes are held: each is streamed, checked and uploaded by storeDopplerFigures. */
  files: DopplerFigureFile[];
  /** The ledger rows, one JSON line each in id order, spilled to a private temporary file (see disposeDopplerFigureSet). */
  ledger: { spill: string; rows: number; counts: DocumentAssetCounts };
  caps: DopplerAssetCaps;
}

/** Remove a set's spill (when its ledger write will not happen). */
export async function disposeDopplerFigureSet(set: Pick<DopplerFigureSet, "ledger"> | null | undefined): Promise<void> {
  if (set) await rm(path.dirname(set.ledger.spill), { recursive: true, force: true }).catch(() => undefined);
}

/** Read the spilled rows back, in order (the ledger write streams them; tests read them). */
export async function* readLedgerSpill(spill: string): AsyncGenerator<DocumentAsset> {
  for await (const line of spillLines(spill)) yield line.r;
}

async function* spillLines(spill: string): AsyncGenerator<SpillLine> {
  const handle = await open(spill, constants.O_RDONLY);
  try {
    let rest = "";
    const buffer = Buffer.allocUnsafe(256 * 1024);
    for (let position = 0; ;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const text = rest + buffer.toString("utf8", 0, bytesRead);
      const lines = text.split("\n");
      rest = lines.pop()!;
      for (const line of lines) if (line) yield JSON.parse(line) as SpillLine;
    }
    if (rest) yield JSON.parse(rest) as SpillLine;
  } finally {
    await handle.close();
  }
}

/** Buffered appends to a spill file (about 256 KiB held at a time). */
class SpillWriter {
  private pending: string[] = [];
  private pendingBytes = 0;
  rows = 0;
  readonly counts = emptyDocumentAssetCounts();
  private constructor(readonly path: string, private readonly handle: FileHandle) {}
  static async create(): Promise<SpillWriter> {
    const dir = await mkdtemp(path.join(tmpdir(), "doppler-ledger-"));
    const file = path.join(dir, "rows.jsonl");
    return new SpillWriter(file, await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
  }
  async add(line: SpillLine): Promise<void> {
    const text = `${JSON.stringify(line)}\n`;
    this.pending.push(text);
    this.pendingBytes += text.length;
    this.rows += 1;
    addDocumentAssetCount(this.counts, line.r);
    if (this.pendingBytes >= 256 * 1024) await this.flush();
  }
  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    await this.handle.write(this.pending.join(""));
    this.pending = [];
    this.pendingBytes = 0;
  }
  async close(): Promise<void> {
    await this.flush();
    await this.handle.close();
  }
  async discard(): Promise<void> {
    await this.handle.close().catch(() => undefined);
    await rm(path.dirname(this.path), { recursive: true, force: true });
  }
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

/**
 * The folder the reader trusts: its device and inode, and its real path. Every directory and file below it is opened
 * without following a final link, must be on the same device, and must resolve (realpath) to exactly the expected path
 * under it, so a component swapped for a symlink after the listing is refused rather than followed out of the folder.
 * The folder must be quiescent (the provider's VM has exited): these checks are defense in depth, not a race-free walk.
 */
interface FolderRoot { dir: string; real: string; dev: number; ino: number }

async function openRoot(dir: string): Promise<FolderRoot> {
  const info = await lstat(dir).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new DopplerFigureRejection("not-a-directory");
  const real = await realpath(dir).catch(() => null);
  if (!real) throw new DopplerFigureRejection("not-a-directory");
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) throw new DopplerFigureRejection("not-a-directory");
  try {
    const opened = await handle.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) throw new DopplerFigureRejection("folder-changed");
  } finally {
    await handle.close();
  }
  return { dir, real, dev: info.dev, ino: info.ino };
}

/** `relative` must still resolve to itself under the root (no component became a link). */
async function assertContained(root: FolderRoot, relative: string): Promise<void> {
  const resolved = await realpath(path.join(root.dir, relative)).catch(() => null);
  if (resolved !== path.join(root.real, relative)) throw new DopplerFigureRejection("path-escapes-folder");
}

/** A page directory, checked like the root: a real directory on the root's device, the same one the listing saw. */
async function checkedSubdir(root: FolderRoot, name: string, listed: Pick<Stats, "dev" | "ino">): Promise<void> {
  const handle = await open(path.join(root.dir, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) throw new DopplerFigureRejection("unexpected-entry");
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== root.dev || opened.dev !== listed.dev || opened.ino !== listed.ino) {
      throw new DopplerFigureRejection("folder-changed");
    }
  } finally {
    await handle.close();
  }
  await assertContained(root, name);
}

/** Directory entries, read one at a time and refused past `cap` (a huge directory is never listed whole). */
async function boundedEntries(dir: string, cap: number): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> {
  const entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }> = [];
  const handle = await opendir(dir, { bufferSize: 64 }).catch(() => null);
  if (!handle) throw new DopplerFigureRejection("unexpected-entry");
  try {
    for (let dirent = await handle.read(); dirent !== null; dirent = await handle.read()) {
      if (entries.length >= cap) throw new DopplerFigureRejection("too-many-files");
      entries.push({ name: dirent.name, isFile: dirent.isFile(), isDirectory: dirent.isDirectory() });
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return entries;
}

/**
 * Open one file of the folder: a regular file on the root's device with exactly one link (a hard link could alias a
 * file outside the folder), not reached through a link, whose size is `expected` (when given) and at most `cap`.
 */
async function openFolderFile(root: FolderRoot, relative: string, expected: number | null, cap: number): Promise<{ handle: FileHandle; size: number }> {
  let handle: FileHandle;
  try {
    handle = await open(path.join(root.dir, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new DopplerFigureRejection("unreadable-file");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new DopplerFigureRejection("not-a-regular-file");
    if (info.nlink !== 1) throw new DopplerFigureRejection("hard-link");
    if (info.dev !== root.dev) throw new DopplerFigureRejection("path-escapes-folder");
    if (info.size > cap) throw new DopplerFigureRejection("oversized-file");
    if (expected !== null && info.size !== expected) throw new DopplerFigureRejection("size-mismatch");
    await assertContained(root, relative);
    return { handle, size: info.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Read one folder file whole (bounded by `cap`, so at most one file's bytes are held at a time). */
async function readFolderFile(root: FolderRoot, relative: string, expected: number | null, cap: number): Promise<Buffer> {
  const { handle, size } = await openFolderFile(root, relative, expected, cap);
  try {
    const buffer = Buffer.alloc(size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== size) throw new DopplerFigureRejection("file-changed");
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

/** dopplerFigureMagicMatches from a file's first 64 and last 2 bytes and its size. */
function magicMatchesHeadTail(format: DopplerFigureFormat, head: Buffer, tail: Buffer, size: number): boolean {
  if (format === "jpg") return size >= 4 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff && tail[0] === 0xff && tail[1] === 0xd9;
  if (format === "webp") return size >= 20 && head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP" && head.readUInt32LE(4) + 8 === size;
  if (format === "png") return size > PNG_SIGNATURE.length && head.subarray(0, 8).equals(PNG_SIGNATURE);
  return dopplerFigureMagicMatches("svg", head);
}

/** A whole-JSON (version 1 or 2) manifest parse peaks near this many times its size (JSON.parse plus the strict schema). */
const V2_PARSE_FACTOR = 10;

/** Version 2 and 3 page folders and the file names inside them. */
const PAGE_DIR = /^page-[0-9]{4,10}$/;
const PAGE_FILE = /^(?:image|figure)-[0-9]{3,7}\.(?:webp|svg|png|jpg)$/;

/** Test-only hooks (never set in production): run between the listing and the reads, to swap a component. */
export interface DopplerFigureReadHooks { afterListing?: () => Promise<void> }

/** id order (page, pictures before figures, index), for spilling version 1 rows in the order the ledger write needs. */
function idOrder(a: string, b: string): number {
  const x = parseDopplerFigureId(a)!;
  const y = parseDopplerFigureId(b)!;
  return x.pageNumber - y.pageNumber || Number(x.vector) - Number(y.vector) || x.index - y.index;
}

/**
 * Read a version 3 `manifest.jsonl` line by line: at most 64 KiB per line (and its type's own cap), ASCII only,
 * `\n`-terminated, hashed as it is read (the end line carries the hash of every byte before it), and at most `maxBytes`
 * in all (what is left of the folder's manifest byte cap). Holds one line and one read buffer at a time.
 */
async function readManifestLines(
  root: FolderRoot, validator: DopplerManifestV3Validator, onImage: (accepted: NonNullable<ReturnType<DopplerManifestV3Validator["accept"]>>) => Promise<void>,
  signal: AbortSignal | undefined, relative: string, maxBytes: number,
): Promise<{ size: number; sha256: string }> {
  // A manifest past the cap is refused before a line is read (openFolderFile: `oversized-file`), and one that grows
  // past it while it is read stops there (`file-changed`).
  const { handle, size } = await openFolderFile(root, relative, null, maxBytes);
  const whole = createHash("sha256");
  const preceding = createHash("sha256");
  const buffer = Buffer.allocUnsafe(DOPPLER_MANIFEST_V3_LINE_BYTES);
  let carry = Buffer.alloc(0);
  let position = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > size) throw new DopplerFigureRejection("file-changed");
      const chunk = buffer.subarray(0, bytesRead);
      whole.update(chunk);
      let start = 0;
      for (let i = 0; i < chunk.length; i += 1) {
        const byte = chunk[i]!;
        if (byte >= 0x80) throw new DopplerFigureRejection("manifest-not-ascii");
        if (byte !== 0x0a) continue;
        const line = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(start, i)]) : chunk.subarray(start, i);
        carry = Buffer.alloc(0);
        start = i + 1;
        if (line.length + 1 > DOPPLER_MANIFEST_V3_LINE_BYTES) throw new DopplerFigureRejection("manifest-line-too-long");
        const text = line.toString("latin1");
        // The hash of every byte before this line, computed only for what may be the end line.
        const before = text.includes('"end"') ? preceding.copy().digest("hex") : undefined;
        let accepted;
        try {
          accepted = validator.accept(text, before);
        } catch (error) {
          if (error instanceof DopplerManifestV3Error) throw new DopplerFigureRejection(`manifest-${error.rule}`);
          throw error;
        }
        preceding.update(line);
        preceding.update("\n");
        if (accepted) await onImage(accepted);
      }
      const tail = chunk.subarray(start);
      if (carry.length + tail.length >= DOPPLER_MANIFEST_V3_LINE_BYTES) throw new DopplerFigureRejection("manifest-line-too-long");
      carry = carry.length > 0 ? Buffer.concat([carry, tail]) : Buffer.from(tail);
    }
    if (position !== size) throw new DopplerFigureRejection("file-changed");
    // A last line without its `\n` is a truncated manifest.
    if (carry.length > 0) throw new DopplerFigureRejection("manifest-unterminated-line");
    try {
      validator.finish();
    } catch (error) {
      if (error instanceof DopplerManifestV3Error) throw new DopplerFigureRejection(`manifest-${error.rule}`);
      throw error;
    }
    return { size, sha256: whole.digest("hex") };
  } finally {
    await handle.close();
  }
}

/**
 * Validate a provider's images folder, or throw DopplerFigureRejection. The folder must be quiescent: the provider's VM
 * has exited and nothing else writes it.
 *
 * Version 3 (`manifest.jsonl`, `doppler-images/3`) and version 2 (`manifest.json`): the manifest, optionally
 * `page-facts.jsonl` (allowed, never read or stored), and `page-NNNN` real directories holding only `(image|figure)-NNN.<format>` regular files.
 * Version 1 (`doppler-figures@1`): `manifest.json` and `<id>.<format>` regular files. Always: no links (symbolic or
 * hard), no other names or nesting, directories read entry by entry with a cap; the manifest is strict and within the
 * caps for the document's page count (`dopplerAssetCaps`); every image's page is in the document; a version 2 or 3
 * manifest names this document's PDF (`sourceSha256`, when the host knows it) and links into `images/`; the files present
 * are exactly the ones the manifest says were extracted, each of the stated size within its cap. Each file's SHA-256 and
 * signature are checked while it uploads (storeDopplerFigures), never by reading it twice. `expect` is what the provider
 * reported: a complete run (exit 0) must not hand back a partial manifest, and a partial one (exit 5) must hand back a
 * version 2 or 3 manifest that says it is incomplete.
 *
 * The ledger rows are spilled to a private temporary file as they are read; the caller passes the set on to the ledger
 * write, or disposes of it (disposeDopplerFigureSet).
 */
export async function readDopplerFigureDir(
  dir: string,
  args: {
    pageCount: number; signal?: AbortSignal; expect?: DopplerFigureExpectation; sourceSha256?: string | null; hooks?: DopplerFigureReadHooks;
    /** The outcome's declared gaps (SandboxedPdfFigureOutcome.gaps): with a partial outcome, the pages no shard covers. */
    gaps?: readonly DopplerFigureGap[] | null;
    /** The pages this folder was asked for (a resumed shard or gap); the whole document by default. */
    range?: readonly [number, number];
    /** Where a legacy (version 1 or 2) manifest's whole-JSON parse is reserved; the worker's figure budget by default. */
    parseBudget?: ByteBudget;
  },
): Promise<DopplerFigureSet> {
  const pageCount = Number.isSafeInteger(args.pageCount) && args.pageCount > 0 ? args.pageCount : 0;
  const caps = dopplerAssetCaps(pageCount);
  const root = await openRoot(dir);
  const listed = await boundedEntries(dir, Math.max(caps.pageDirs, DOPPLER_FIGURE_LIMITS.maxFiles) + 3);
  const flat = new Set<string>();
  const pageDirs: string[] = [];
  let manifestFile: string | null = null;
  let hasPageFacts = false;
  let hasShards = false;
  for (const dirent of listed) {
    if (dirent.isDirectory && PAGE_DIR.test(dirent.name)) { pageDirs.push(dirent.name); continue; }
    if (dirent.isDirectory && dirent.name === "shards") { hasShards = true; continue; }
    if (!dirent.isFile) throw new DopplerFigureRejection("unexpected-entry");
    if (dirent.name === DOPPLER_FIGURES_MANIFEST || dirent.name === DOPPLER_MANIFEST_V3_FILE) {
      if (manifestFile) throw new DopplerFigureRejection("unexpected-file");
      manifestFile = dirent.name;
      continue;
    }
    if (dirent.name === DOPPLER_STORE_LAYOUT.pageFacts) { hasPageFacts = true; continue; }
    if (!DOPPLER_FIGURE_FILE_NAME.test(dirent.name)) throw new DopplerFigureRejection("unexpected-file");
    flat.add(dirent.name);
  }
  // One manifest, or one per shard (version 3), never both.
  if (manifestFile && hasShards) throw new DopplerFigureRejection("unexpected-entry");
  if (!manifestFile && !hasShards) throw new DopplerFigureRejection("missing-manifest");
  const shardRanges: Array<[number, number]> = [];
  if (hasShards) {
    const shardsInfo = await lstat(path.join(dir, "shards")).catch(() => null);
    if (!shardsInfo || !shardsInfo.isDirectory() || shardsInfo.isSymbolicLink()) throw new DopplerFigureRejection("unexpected-entry");
    await checkedSubdir(root, "shards", shardsInfo);
    for (const dirent of await boundedEntries(path.join(dir, "shards"), DOPPLER_SHARDS_MAX)) {
      const range = dirent.isDirectory ? parseDopplerShardFolder(dirent.name) : null;
      if (!range) throw new DopplerFigureRejection("unexpected-entry");
      const relative = `shards/${dirent.name}`;
      const info = await lstat(path.join(dir, relative)).catch(() => null);
      if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new DopplerFigureRejection("unexpected-entry");
      await checkedSubdir(root, relative, info);
      const inner = await boundedEntries(path.join(dir, relative), 2);
      if (inner.length !== 1 || !inner[0]!.isFile || inner[0]!.name !== DOPPLER_MANIFEST_V3_FILE) throw new DopplerFigureRejection("unexpected-entry");
      shardRanges.push(range);
    }
    if (shardRanges.length === 0) throw new DopplerFigureRejection("missing-manifest");
    shardRanges.sort((a, b) => a[0] - b[0]);
    // Shard ranges never overlap: page paths are global, and each page belongs to one shard's manifest.
    for (let i = 1; i < shardRanges.length; i += 1) if (shardRanges[i]![0] <= shardRanges[i - 1]![1]) throw new DopplerFigureRejection("shards-overlap");
    // Coverage (dopplerShardCoverage): a partial outcome's shards and declared gaps (a failed batch or shard publishes no
    // folder) cover the asked pages exactly once; an extracted outcome keeps the strict rule (from the first page, no hole,
    // within the document).
    const asked = args.range ?? [1, pageCount] as const;
    const coverage = dopplerShardCoverage(shardRanges, args.gaps, { first: asked[0], last: asked[1], partial: args.expect === "partial" });
    if (coverage) throw new DopplerFigureRejection(coverage);
  }
  // Page folders as listed (device and inode), to refuse one swapped before it is opened.
  const listedDirs = new Map<string, Stats>();
  for (const name of pageDirs) {
    const info = await lstat(path.join(dir, name)).catch(() => null);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new DopplerFigureRejection("unexpected-entry");
    listedDirs.set(name, info);
  }
  await args.hooks?.afterListing?.();

  // Where each extracted image's file must be, relative to the folder, by the id that owns it.
  const expected = new Map<string, DopplerFigureFile>();
  let fileBytes = 0;
  const addFile = (relative: string, id: string, format: DopplerFigureFormat, size: number, sha256: string, cap: number) => {
    if (size > cap) throw new DopplerFigureRejection("oversized-file");
    expected.set(relative, { id, format, mediaType: DOPPLER_FIGURE_MEDIA_TYPES[format], relative, size, sha256, cap });
    fileBytes += size;
    if (expected.size > caps.files) throw new DopplerFigureRejection("too-many-files");
    if (fileBytes > caps.totalBytes) throw new DopplerFigureRejection("total-bytes");
  };
  const spill = await SpillWriter.create();
  let version: 1 | 2 | 3;
  const manifests: DopplerManifestFile[] = [];
  let run: DopplerManifestRunFacts | null;
  let complete: boolean;
  /** Releases the version 2 parse reservation (idempotent). */
  let releaseParse: (() => void) | null = null;
  try {
    if (manifestFile === DOPPLER_MANIFEST_V3_FILE || hasShards) {
      version = 3;
      if (flat.size > 0) throw new DopplerFigureRejection("unexpected-file");
      // The manifests in page order: one, or one per shard. Lines are counted against the cap across all of them.
      const jobs: Array<{ relative: string; range: [number, number] | null }> = hasShards
        ? shardRanges.map((range) => ({ relative: `shards/${dopplerShardFolder(range[0], range[1])}/${DOPPLER_MANIFEST_V3_FILE}`, range }))
        : [{ relative: DOPPLER_MANIFEST_V3_FILE, range: null }];
      let linesLeft = caps.entries;
      // Every manifest of the folder counts against one byte cap, and toward the folder's total bytes.
      let bytesLeft = caps.manifestV3Bytes;
      let first: DopplerManifestV3Header | null = null;
      for (const job of jobs) {
        const validator = new DopplerManifestV3Validator({ maxLines: linesLeft, maxPage: pageCount, ...(job.range ? { range: job.range } : {}) });
        let resumable = 0;
        let checked = false;
        const checkHeader = (header: DopplerManifestV3Header) => {
          if (header.link_prefix !== DOPPLER_STORE_LAYOUT.imagesFolder) throw new DopplerFigureRejection("link-prefix");
          if (args.sourceSha256 && header.source_sha256 !== args.sourceSha256) throw new DopplerFigureRejection("source-mismatch");
          // Shards of one conversion: the same PDF and the same settings, apart from each shard's own range, resumes,
          // deadline and the settings digest those change.
          if (first && !sameShardSettings(first, header)) throw new DopplerFigureRejection(first.source_sha256 !== header.source_sha256 ? "shards-source-mismatch" : "shards-settings-mismatch");
        };
        const read = await readManifestLines(root, validator, async ({ row, file, error }) => {
          if (!checked) { checkHeader(validator.headerLine!); checked = true; }
          if (file) addFile(file.path, file.id, file.format, file.bytes, file.sha256, dopplerEntryFileCap(file, caps));
          if (row.resumable) resumable += 1;
          await spill.add({ r: row, x: recordOf(row, error) });
        }, args.signal, job.relative, bytesLeft);
        bytesLeft -= read.size;
        fileBytes += read.size;
        if (fileBytes > caps.totalBytes) throw new DopplerFigureRejection("total-bytes");
        const summary = validator.finish();
        if (!checked) checkHeader(summary.header);
        first ??= summary.header;
        linesLeft -= summary.images + summary.batches;
        manifests.push({ relative: job.relative, size: read.size, sha256: read.sha256, range: job.range, run: dopplerManifestV3RunFacts(summary), complete: summary.complete, resumable });
      }
      complete = manifests.every((m) => m.complete);
      const firstRun = manifests[0]!.run!;
      run = manifests.length === 1 ? firstRun : {
        ...firstRun, settingsSha256: null, manifestResumes: 0, complete,
        resumable: manifests.some((m) => m.resumable > 0),
        lastCutPage: manifests.map((m) => m.run!.lastCutPage).filter((page): page is number => page !== null).at(-1) ?? null,
      };
    } else {
      const cap = Math.min(caps.manifestBytes, DOPPLER_MANIFEST_V2_LIMITS.maxManifestBytes);
      // A legacy manifest is parsed whole: JSON.parse plus the strict schema peak near 10x its size (measured), so that
      // much is reserved from the worker's figure budget until the rows are spilled. Version 2 is dropped once the
      // Doppler pin writes version 3 (docs/extraction/doppler-figures.md).
      const probe = await openFolderFile(root, manifestFile!, null, cap);
      await probe.handle.close();
      const parseBudget = args.parseBudget ?? dopplerWorkerBudget();
      const held = await parseBudget.acquire(V2_PARSE_FACTOR * probe.size, args.signal);
      let released = false;
      releaseParse = () => { if (!released) { released = true; parseBudget.release(held); } };
      const raw = await readFolderFile(root, manifestFile!, probe.size, cap);
      fileBytes += raw.length;
      let json: unknown;
      try { json = JSON.parse(raw.toString("utf8")); } catch { throw new DopplerFigureRejection("manifest-not-json"); }
      const manifest = parseDopplerManifest(json);
      json = undefined;
      if (!manifest) throw new DopplerFigureRejection("manifest-invalid");
      if (manifest.version === 1 && raw.length > DOPPLER_FIGURE_LIMITS.maxManifestBytes) throw new DopplerFigureRejection("oversized-file");
      if (manifest.manifest.images.some((entry) => entry.page > pageCount)) throw new DopplerFigureRejection("page-outside-document");
      version = manifest.version;
      const counts = { resumable: 0 };
      if (manifest.version === 1) {
        if (pageDirs.length > 0 || hasPageFacts) throw new DopplerFigureRejection("unexpected-entry");
        for (const entry of manifest.manifest.images) {
          if (entry.file === null) continue;
          addFile(`${entry.id}.${entry.format!}`, entry.id, entry.format!, entry.bytes!, entry.sha256!, DOPPLER_FIGURE_LIMITS.maxFileBytes);
        }
        if (fileBytes > DOPPLER_FIGURE_LIMITS.maxTotalBytes) throw new DopplerFigureRejection("total-bytes");
        run = null;
        complete = true;
      } else {
        const m = manifest.manifest;
        if (flat.size > 0) throw new DopplerFigureRejection("unexpected-file");
        if (m.link_prefix !== DOPPLER_STORE_LAYOUT.imagesFolder) throw new DopplerFigureRejection("link-prefix");
        if (args.sourceSha256 && m.source_sha256 !== args.sourceSha256) throw new DopplerFigureRejection("source-mismatch");
        if (m.images.length > caps.entries) throw new DopplerFigureRejection("too-many-entries");
        for (const entry of m.images) {
          if (entry.status !== "extracted") continue;
          addFile(entry.path!, entry.id, entry.format!, entry.bytes, entry.sha256!, dopplerEntryFileCap(entry, caps));
        }
        run = dopplerManifestRunFacts(manifest);
        complete = m.complete;
      }
      // Spill in id order, with each entry's index record (the rows computed once, and the records from them).
      const rows = dopplerLedgerAssets(manifest);
      const records = dopplerFigureRecords(manifest, rows);
      const order = rows.map((_, i) => i).sort((a, b) => idOrder(rows[a]!.assetId, rows[b]!.assetId));
      for (const i of order) {
        if (rows[i]!.resumable) counts.resumable += 1;
        await spill.add({ r: rows[i]!, x: records[i]! });
      }
      manifests.push({
        relative: manifestFile!, size: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), range: null, run, complete,
        resumable: counts.resumable,
      });
      releaseParse();
    }
    // A partial outcome is partial by its manifests or by its declared gaps (a failed range published no folder, so the
    // shards that did publish may all be complete); a complete one has neither.
    const gapsDeclared = (args.gaps?.length ?? 0) > 0;
    if ((args.expect === "partial" && complete && !gapsDeclared) || (args.expect === "complete" && (!complete || gapsDeclared))) {
      throw new DopplerFigureRejection("outcome-mismatch");
    }
    if (gapsDeclared) complete = false;

    const present = new Set<string>();
    if (version === 1) {
      for (const name of flat) present.add(name);
    } else {
      if (pageDirs.length > caps.pageDirs) throw new DopplerFigureRejection("too-many-files");
      for (const pageDir of pageDirs) {
        args.signal?.throwIfAborted();
        await checkedSubdir(root, pageDir, listedDirs.get(pageDir)!);
        const inner = await boundedEntries(path.join(dir, pageDir), caps.files - present.size + 1);
        if (present.size + inner.length > caps.files) throw new DopplerFigureRejection("too-many-files");
        for (const dirent of inner) {
          if (!dirent.isFile) throw new DopplerFigureRejection("unexpected-entry");
          if (!PAGE_FILE.test(dirent.name)) throw new DopplerFigureRejection("unexpected-file");
          present.add(`${pageDir}/${dirent.name}`);
        }
        // Still the folder the listing saw.
        const after = await lstat(path.join(dir, pageDir)).catch(() => null);
        const before = listedDirs.get(pageDir)!;
        if (!after || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new DopplerFigureRejection("folder-changed");
      }
    }
    if (expected.size !== present.size || [...present].some((name) => !expected.has(name))) throw new DopplerFigureRejection("files-do-not-match-manifest");
    for (const entry of expected.values()) {
      args.signal?.throwIfAborted();
      // `relative` comes from the validated manifest (a fixed pattern derived from ids), never from the listing.
      const { handle } = await openFolderFile(root, entry.relative, entry.size, entry.cap);
      await handle.close();
    }
    // `page-facts.jsonl` (when present) is never read or stored: its document line can carry the PDF's own producer
    // and creator strings, untrusted text. Facts are stored only once a validating reader re-serialises them.
    await spill.close();
    return {
      dir, version, manifests, run, complete, files: [...expected.values()],
      ledger: { spill: spill.path, rows: spill.rows, counts: spill.counts }, caps,
    };
  } catch (error) {
    await spill.discard();
    throw error;
  } finally {
    releaseParse?.();
  }
}

/** Whether two shard headers describe one conversion: equal apart from the shard's range, resumes, deadline and settings digest. */
function sameShardSettings(a: DopplerManifestV3Header, b: DopplerManifestV3Header): boolean {
  const strip = ({ pages: _p, resumes: _r, deadline_ms: _d, settings_sha256: _s, ...rest }: DopplerManifestV3Header) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

/** The index record of a version 2 or 3 row (version 1 keeps the record its manifest gives). */
function recordOf(row: DocumentAsset, error?: string): DopplerFigureRecord {
  const format = row.status === "extracted" ? row.format : null;
  return {
    id: row.assetId, page: row.pageNumber, bbox: row.bbox ?? [0, 0, 0, 0], kind: row.kind, fate: row.fate, format,
    mediaType: format ? DOPPLER_FIGURE_MEDIA_TYPES[format] : null, bytes: row.bytes ?? 0, sha256: row.sha256,
    width: row.width ?? 0, height: row.height ?? 0, fileOf: row.fileOf, slot: row.fileOf ? dopplerFigureSlot(row.fileOf) : null,
    ...(row.fallback === null ? {} : { fallback: row.fallback }),
    ...(error === undefined ? {} : { error }),
    ...(row.reason === null ? {} : { skipped: row.reason }),
  };
}

/**
 * The key of one object in the document's Doppler folder (`<artifact root>/doppler/<document>/`): a fixed name of the
 * layout, or an image file at the path derived from its owning id. Never a name taken from the provider's folder.
 */
export function dopplerFolderKey(
  document: { id: string; userId: string; runId: string; artifactRoot?: string | null },
  runId: string,
  object: "markdown" | "source" | "index" | "manifest" | "manifestV3" | "pageFacts" | { id: string; format: DopplerFigureFormat } | { shard: readonly [number, number] },
): string {
  const root = documentArtifactRoot(document, runId);
  const prefix = dopplerDocumentPrefix(root, document.id);
  const images = `${prefix}${DOPPLER_STORE_LAYOUT.imagesFolder}`;
  if (typeof object === "object" && "shard" in object) return `${images}shards/${dopplerShardFolder(object.shard[0], object.shard[1])}/${DOPPLER_MANIFEST_V3_FILE}`;
  if (typeof object === "object") return dopplerAssetStorageKey(root, document.id, object.id, object.format);
  switch (object) {
    case "markdown": return `${prefix}${DOPPLER_STORE_LAYOUT.markdown}`;
    case "source": return `${prefix}${DOPPLER_STORE_LAYOUT.source}`;
    case "index": return `${prefix}${DOPPLER_STORE_LAYOUT.index}`;
    case "manifest": return `${images}${DOPPLER_STORE_LAYOUT.manifest}`;
    case "manifestV3": return `${images}${DOPPLER_MANIFEST_V3_FILE}`;
    // Written by extract-markdown from the host's validated facts (dopplerPageFactsJsonl), never copied from the provider's folder.
    case "pageFacts": return `${images}${DOPPLER_STORE_LAYOUT.pageFacts}`;
  }
}

/** Index records: one per manifest entry, with the slot of the file it shows (its own, or the one it shares). */
export function dopplerFigureRecords(manifest: DopplerManifest, ledgerAssets?: readonly DocumentAsset[]): DopplerFigureRecord[] {
  if (manifest.version === 2) {
    const assets = ledgerAssets ?? dopplerLedgerAssets(manifest);
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
  /**
   * One streaming PUT of exactly `size` bytes (ArtifactStore.putSizedStream). Without it every file is read whole, one
   * at a time per upload slot, within the same budget.
   */
  putStream?(key: string, body: Readable, size: number, contentType: string): Promise<void>;
  /**
   * Conditional creates (`If-None-Match: *`): write the object only if the key is free, else report `exists` without
   * touching it. With them, a figure already at its key is accepted only when its SHA-256 is the manifest's (read through
   * `openStream`), never overwritten. Without them (a store that cannot), keys are still write-once in practice: they sit
   * under the run's own artifact root, and a stale run's writes are refused by the ledger (stale-write).
   */
  putBytesIfAbsent?(key: string, data: Uint8Array, contentType: string): Promise<"created" | "exists">;
  putStreamIfAbsent?(key: string, body: Readable, size: number, contentType: string): Promise<"created" | "exists">;
  openStream?(key: string, signal?: AbortSignal): Promise<{ stream: AsyncIterable<Uint8Array>; size: number | null }>;
  /** Never called on a failure path: figures are kept (owner rule); the orphan GC is the only deleter. */
  deleteKeys?(keys: string[]): Promise<void>;
}

/**
 * The ledger beside an upload: `pending` records the next files before their upload, `stored` flips them once they
 * landed and checked out. Called once per FIGURE_LEDGER_BATCH files, in order.
 */
export interface DopplerFigureLedgerHooks {
  pending(rows: Array<DocumentAsset & { storageKey: string }>): Promise<void>;
  stored(files: Array<{ id: string; key: string }>): Promise<void>;
  /**
   * Repair: an object with other bytes sits at a figure's key. Under the document's ledger lock, `replace` runs (delete,
   * then create) only when no stored row vouches for that key; otherwise the folder is refused (`object-conflict`).
   */
  replace?(key: string, replace: () => Promise<void>): Promise<void>;
}

/** Files recorded pending, uploaded and flipped to stored per step. */
export const FIGURE_LEDGER_BATCH = 64;

/** Why storing a validated figure set failed: a fixed slug for stage stats and telemetry, never the storage error text. */
export type DopplerFigureStoreFailure = "store-object-failed" | "store-index-failed";

/**
 * Storing figures failed part way. Nothing was recorded, so no figure (and no index) is reachable for the document;
 * `cleanup` says whether the objects written so far were deleted too.
 */
export class DopplerFigureStoreError extends Error {
  constructor(
    readonly reason: DopplerFigureStoreFailure,
    /** `kept`: verified uploads stay for the next attempt to adopt; nothing is deleted on a failure path. */
    readonly cleanup: "kept" | "none",
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
  /** The most bytes this job held for uploads at once, and its budget. */
  peakBufferBytes: number;
  bufferBudgetBytes: number;
}

/** Document artifact slots of the Doppler folder (beside `doppler-figure:<id>` per file and the `doppler-figures` index). */
export const DOPPLER_MANIFEST_SLOT = "doppler-manifest";
export const DOPPLER_MARKDOWN_SLOT = "doppler-markdown";
/** The host's canonical page facts (`images/page-facts.jsonl`, extract-markdown), never the provider's file. */
export const DOPPLER_PAGE_FACTS_SLOT = "doppler-page-facts";

export interface StoredDopplerFigures {
  indexUri: string;
  /**
   * Artifact slots to record for the document: the index, the manifest(s), the Markdown and one per stored file. `source.json` has none: it names the source object, which is never served through an artifact.
   */
  slots: Array<{ slot: string; uri: string }>;
  /** Storage key of each stored file, by the id that owns it. */
  keys: Map<string, string>;
  /** The stored manifest's key and SHA-256 (for the extraction level: what a resume downloads); null for shards. */
  manifest: { key: string; sha256: string } | null;
  /** Every stored manifest: one, or one per shard with its page range. */
  manifests: Array<{ key: string; sha256: string; range: [number, number] | null }>;
  /** Bytes of the folder's own files stored (manifests, page facts, Markdown, index): billed with the figures. */
  folderBytes: number;
  /** Every object this call wrote (files, manifests, Markdown, source pointer, index): what a caller removes if it cannot record them. */
  objectKeys: string[];
  stats: DopplerFigureStats;
}

/** What `source.json` records: a pointer to the document's source object (deduplicated across documents, never copied). */
export interface DopplerSourcePointer {
  sourceKey: string;
  sha256: string | null;
  pageCount: number;
  mimeType: string;
}

/** The memory budgets of one store (tests pass their own; production reads the environment). */
export interface DopplerStoreBudgets { job: ByteBudget; worker: ByteBudget; concurrency: number }

export function dopplerStoreBudgets(): DopplerStoreBudgets {
  return { job: new ByteBudget(dopplerFigureBufferBytes()), worker: dopplerWorkerBudget(), concurrency: dopplerFigureUploadConcurrency() };
}

const magicCheck = (format: DopplerFigureFormat) => (head: Buffer, tail: Buffer, size: number) => magicMatchesHeadTail(format, head, tail, size);

/**
 * Upload one file of the folder (or a host file) within the budget: a small file whole, a larger one as a checked stream.
 * The bytes are verified (size, SHA-256 when known, signature when known) before the upload may complete; a mismatch
 * fails the upload, deletes whatever landed, and is a DopplerFigureRejection.
 */
async function uploadChecked(args: {
  storage: DopplerFigureStorage; budgets: DopplerStoreBudgets; key: string; contentType: string; size: number;
  open: () => Promise<FileHandle>; check: StreamCheck; signal?: AbortSignal;
  /** A figure file: created only if absent; an existing object must have exactly these bytes (`object-conflict`). */
  createOnly?: boolean;
  /** Replace an existing object of other bytes when the ledger vouches for none (DopplerFigureLedgerHooks.replace). */
  repair?: DopplerFigureLedgerHooks["replace"];
  /** Called once, just before the first byte may reach storage (the caller tracks what it must clean up). */
  onStart?: () => void;
}): Promise<void> {
  const conditional = !!args.createOnly && !!args.storage.openStream &&
    (args.size > DOPPLER_UPLOAD_SMALL_FILE_BYTES && args.storage.putStream ? !!args.storage.putStreamIfAbsent : !!args.storage.putBytesIfAbsent);
  const settle = async (result: "created" | "exists" | void) => {
    if (result !== "exists") return;
    // Already there (a replayed upload, a retry, a concurrent writer of this run): accept identical bytes only.
    const found = await objectDigest(args.storage as FigureObjectReader, args.key, args.size, args.signal);
    if (!found || found.size !== args.size || (args.check.sha256 !== null && found.sha256 !== args.check.sha256)) {
      // Known-bad bytes at our key (a crashed attempt, an earlier extraction the ledger no longer vouches for): replace them
      // under the document's lock, never while a stored row still points at them.
      if (!args.repair) throw new DopplerFigureRejection("object-conflict");
      await args.repair(args.key, async () => {
        await args.storage.deleteKeys?.([args.key]);
        await uploadChecked({ ...args, repair: undefined });
      });
    }
  };
  const streaming = !!args.storage.putStream && args.size > DOPPLER_UPLOAD_SMALL_FILE_BYTES;
  // The budget is a hard ceiling: a whole-file read larger than the job's or the worker's budget is refused (a store
  // without streaming uploads cannot hold it), never reserved at the clamped limit while the full size is allocated.
  if (!streaming && (args.size > args.budgets.job.limit || args.size > args.budgets.worker.limit)) throw new DopplerFigureRejection("file-over-memory-budget");
  const release = await reserve(args.budgets, streaming ? Math.min(args.size, 2 * DOPPLER_UPLOAD_CHUNK_BYTES) : args.size, args.signal);
  let handle: FileHandle | null = null;
  try {
    args.signal?.throwIfAborted();
    handle = await args.open();
    args.onStart?.();
    if (streaming) {
      try {
        const body = checkedFileStream(handle, args.check);
        await settle(conditional
          ? await args.storage.putStreamIfAbsent!(args.key, body, args.size, args.contentType)
          : await args.storage.putStream!(args.key, body, args.size, args.contentType));
      } catch (error) {
        // A body that failed its check aborts the request, so no object was created; nothing is deleted (an object already
        // at the key may be a committed figure).
        const check = error instanceof StreamCheckError ? error : (error as { cause?: unknown })?.cause instanceof StreamCheckError ? (error as { cause: StreamCheckError }).cause : null;
        if (check) throw new DopplerFigureRejection(check.rule);
        throw error;
      }
      return;
    }
    const data = Buffer.allocUnsafe(args.size);
    let total = 0;
    while (total < args.size) {
      const { bytesRead } = await handle.read(data, total, args.size - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const probe = await handle.read(Buffer.alloc(1), 0, 1, total);
    if (total !== args.check.expectedSize || probe.bytesRead !== 0) throw new DopplerFigureRejection("file-changed");
    if (args.check.sha256 !== null && createHash("sha256").update(data).digest("hex") !== args.check.sha256) throw new DopplerFigureRejection("sha256-mismatch");
    if (args.check.magic && !args.check.magic(data.subarray(0, 64), data.subarray(-2), total)) throw new DopplerFigureRejection("wrong-magic");
    await settle(conditional ? await args.storage.putBytesIfAbsent!(args.key, data, args.contentType) : await args.storage.putBytes(args.key, data, args.contentType));
  } finally {
    await handle?.close().catch(() => undefined);
    release();
  }
}

/** Open a host file (the Markdown, the index) as a plain regular file. */
async function openHostFile(file: string): Promise<{ size: number; open: () => Promise<FileHandle> }> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("not a regular file");
  return { size: info.size, open: () => open(file, constants.O_RDONLY | constants.O_NOFOLLOW) };
}

/**
 * Store a validated images folder in the document's Doppler folder (`DOPPLER_STORE_LAYOUT`): every image file at its page
 * path, uploaded concurrently (DopplerStoreBudgets.concurrency) within the fixed memory budget and verified while it
 * streams; then, once every file has landed and checked out, the manifest bytes unchanged, the Markdown as Doppler
 * wrote it and `source.json`; DocSlurp's index last (never the provider's page facts). Until the caller records the slots
 * nothing is reachable. Nothing is deleted on any failure: verified files stay (pending or stored ledger rows let the next
 * attempt adopt them; the orphan GC removes what no row vouches for).
 */
export async function storeDopplerFigures(args: {
  storage: DopplerFigureStorage;
  document: { id: string; userId: string; runId: string; artifactRoot?: string | null };
  runId: string;
  figures: DopplerFigureSet;
  /** The stored Markdown: which markers it holds, and whether each names a stored figure. */
  markdown: string;
  /**
   * `document.md`: always exactly the bytes of the document's Markdown slot, the text the PII stage scans (sanitized, after
   * any OCR fill or critique), never the provider's raw output. The folder has none when absent.
   */
  documentMarkdown?: Buffer | null;
  /** `source.json`; the folder has none when absent. */
  source?: DopplerSourcePointer | null;
  /**
   * URIs the document's slots (or ledger rows) already reference: committed objects. Informational here: this store never
   * deletes anything on failure (orphan GC is the only deleter), so a committed object is never at risk from it.
   */
  committedUris?: ReadonlySet<string>;
  budgets?: DopplerStoreBudgets;
  /** The ledger beside the upload: pending before each step of FIGURE_LEDGER_BATCH files, stored after it. */
  ledger?: DopplerFigureLedgerHooks;
  /**
   * false (a resume): store only the figure files. The manifests, page facts, Markdown and index are never rewritten
   * before the ledger write commits; the caller writes the new manifests afterwards (storeDopplerFolderManifests).
   */
  folderFiles?: boolean;
  signal?: AbortSignal;
}): Promise<StoredDopplerFigures> {
  const started = Date.now();
  const budgets = args.budgets ?? dopplerStoreBudgets();
  const set = args.figures;
  const key = (object: Parameters<typeof dopplerFolderKey>[2]) => dopplerFolderKey(args.document, args.runId, object);
  const indexKey = key("index");
  const singleManifestKey = key(set.version === 3 ? "manifestV3" : "manifest");
  const root = await openRoot(set.dir);
  const slots: StoredDopplerFigures["slots"] = [];
  const keys = new Map<string, string>();
  /** Keys this call started writing (never every planned key): a failure removes only these, minus committed ones. */
  const written: string[] = [];
  let phase: DopplerFigureStoreFailure = "store-object-failed";
  let work: string | null = null;
  try {
    // 1. Every image file, concurrently, each created only if absent and verified as it streams; with the ledger, in steps of
    //    FIGURE_LEDGER_BATCH: recorded pending, uploaded, flipped to stored (kept whatever later fails).
    for (const file of set.files) keys.set(file.id, key({ id: file.id, format: file.format }));
    const rows = args.ledger ? await extractedRows(set, keys) : null;
    for (let at = 0; at < set.files.length; at += FIGURE_LEDGER_BATCH) {
      const step = set.files.slice(at, at + FIGURE_LEDGER_BATCH);
      if (args.ledger) await args.ledger.pending(step.map((file) => rows!.get(file.id)!));
      written.push(...step.map((file) => keys.get(file.id)!));
      await boundedPool(step, budgets.concurrency, (file) => uploadChecked({
        storage: args.storage, budgets, key: keys.get(file.id)!, contentType: file.mediaType, size: file.size, signal: args.signal,
        open: async () => (await openFolderFile(root, file.relative, file.size, file.cap)).handle,
        check: { expectedSize: file.size, sha256: file.sha256, magic: magicCheck(file.format) }, createOnly: true,
        ...(args.ledger?.replace ? { repair: args.ledger.replace } : {}),
      }), args.signal);
      args.signal?.throwIfAborted();
      if (args.ledger) await args.ledger.stored(step.map((file) => ({ id: file.id, key: keys.get(file.id)! })));
    }
    for (const file of set.files) slots.push({ slot: dopplerFigureSlot(file.id), uri: args.storage.uri(keys.get(file.id)!) });
    args.signal?.throwIfAborted();

    // 2. Only now the manifest, the Markdown and the source pointer (never the provider's page facts).
    const tail: Array<() => Promise<void>> = [];
    const storedManifests: StoredDopplerFigures["manifests"] = [];
    let folderBytes = 0;
    if (args.folderFiles === false) {
      for (const manifest of set.manifests) {
        storedManifests.push({ key: manifest.range ? key({ shard: manifest.range }) : singleManifestKey, sha256: manifest.sha256, range: manifest.range });
      }
      for (const file of set.files) slots.push({ slot: dopplerFigureSlot(file.id), uri: args.storage.uri(keys.get(file.id)!) });
      const single = storedManifests.length === 1 && storedManifests[0]!.range === null ? storedManifests[0]! : null;
      const stats: DopplerFigureStats = {
        status: "stored", entries: set.ledger.rows, files: set.files.length, bytes: set.files.reduce((sum, file) => sum + file.size, 0),
        byKind: {}, byFormat: {}, markers: 0, markersResolved: 0, storeMs: Date.now() - started, peakBufferBytes: budgets.job.peak,
        bufferBudgetBytes: budgets.job.limit,
      };
      return { indexUri: args.storage.uri(indexKey), slots, keys, manifest: single ? { key: single.key, sha256: single.sha256 } : null, manifests: storedManifests, objectKeys: [...new Set(written)], folderBytes: 0, stats };
    }
    for (const manifest of set.manifests) {
      const manifestKey = manifest.range ? key({ shard: manifest.range }) : singleManifestKey;
      folderBytes += manifest.size;
      tail.push(() => uploadChecked({
        storage: args.storage, budgets, key: manifestKey, contentType: set.version === 3 ? "text/plain; charset=utf-8" : "application/json",
        size: manifest.size, signal: args.signal,
        open: async () => (await openFolderFile(root, manifest.relative, manifest.size, manifest.size)).handle,
        check: { expectedSize: manifest.size, sha256: manifest.sha256, magic: null },
        onStart: () => { written.push(manifestKey); },
      }));
      storedManifests.push({ key: manifestKey, sha256: manifest.sha256, range: manifest.range });
      slots.push({
        slot: manifest.range ? `${DOPPLER_MANIFEST_SLOT}:${dopplerShardFolder(manifest.range[0], manifest.range[1])}` : DOPPLER_MANIFEST_SLOT,
        uri: args.storage.uri(manifestKey),
      });
    }
    if (args.documentMarkdown) {
      const markdownKey = key("markdown");
      const bytes = args.documentMarkdown;
      // Not in folder_bytes: a copy of the Markdown slot, which the per-page artifact estimate already covers (L11).
      tail.push(async () => {
        written.push(markdownKey);
        await args.storage.putBytes(markdownKey, bytes, "text/markdown; charset=utf-8");
      });
      slots.push({ slot: DOPPLER_MARKDOWN_SLOT, uri: args.storage.uri(markdownKey) });
    }
    if (args.source) {
      const sourceKey = key("source");
      const source = args.source;
      tail.push(() => {
        written.push(sourceKey);
        return args.storage.putJson(sourceKey, { sourceKey: source.sourceKey, sha256: source.sha256, pageCount: source.pageCount, mimeType: source.mimeType });
      });
    }
    await boundedPool(tail, budgets.concurrency, (task) => task(), args.signal);
    args.signal?.throwIfAborted();

    // 3. DocSlurp's index, built from the spilled rows into a file and uploaded last.
    phase = "store-index-failed";
    work = await mkdtemp(path.join(tmpdir(), "doppler-index-"));
    const built = await writeIndexFile(path.join(work, "index.json"), set, args.document.id, args.markdown);
    const host = await openHostFile(built.path);
    await uploadChecked({
      storage: args.storage, budgets, key: indexKey, contentType: "application/json", size: host.size, signal: args.signal,
      open: host.open, check: { expectedSize: host.size, sha256: null, magic: null },
      onStart: () => { written.push(indexKey); },
    });
    // A cancellation that arrived during the final write still cancels: nothing is recorded (what was written stays for GC).
    args.signal?.throwIfAborted();
    slots.unshift({ slot: DOPPLER_FIGURES_INDEX_SLOT, uri: args.storage.uri(indexKey) });
    const count = <K extends string>(values: K[]) => values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
    const stats: DopplerFigureStats = {
      status: "stored",
      entries: set.ledger.rows,
      files: set.files.length,
      bytes: set.files.reduce((sum, file) => sum + file.size, 0),
      byKind: built.byKind,
      byFormat: count(set.files.map((file) => file.format)),
      markers: built.markers,
      markersResolved: built.markersResolved,
      storeMs: Date.now() - started,
      peakBufferBytes: budgets.job.peak,
      bufferBudgetBytes: budgets.job.limit,
    };
    const single = storedManifests.length === 1 && storedManifests[0]!.range === null ? storedManifests[0]! : null;
    folderBytes += host.size;
    return {
      indexUri: args.storage.uri(indexKey), slots, keys, manifest: single ? { key: single.key, sha256: single.sha256 } : null, manifests: storedManifests,
      objectKeys: [...new Set(written)], folderBytes, stats,
    };
  } catch (error) {
    // Nothing is deleted (owner rule): verified uploads stay for the next attempt to adopt; the orphan GC removes what no
    // ledger row vouches for.
    const cleanup: DopplerFigureStoreError["cleanup"] = written.length > 0 ? "kept" : "none";
    // Cancellation stays cancellation: the caller must stop the document, not record a figure failure.
    if (args.signal?.aborted) throw error;
    // A file that does not match the manifest is a refused folder, like any other mismatch.
    if (error instanceof DopplerFigureRejection) throw error;
    throw new DopplerFigureStoreError(phase, cleanup, { cause: error });
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The extracted rows of the set's files (from the spill), each with its key: what `pending` records. */
async function extractedRows(set: DopplerFigureSet, keys: ReadonlyMap<string, string>): Promise<Map<string, DocumentAsset & { storageKey: string }>> {
  const rows = new Map<string, DocumentAsset & { storageKey: string }>();
  for await (const line of spillLines(set.ledger.spill)) {
    const storageKey = keys.get(line.r.assetId);
    if (line.r.status === "extracted" && storageKey) rows.set(line.r.assetId, { ...line.r, storageKey });
  }
  if (rows.size !== set.files.length) throw new DopplerFigureRejection("files-do-not-match-manifest");
  return rows;
}

/** Write the index JSON from the spilled rows, streaming: `{version, documentId, markers, figures: [...]}`. */
async function writeIndexFile(file: string, set: DopplerFigureSet, documentId: string, markdown: string): Promise<{
  path: string; byKind: Record<string, number>; markers: number; markersResolved: number;
}> {
  // Markers (version 1 Markdown) resolve only to ids this index maps to a file; text could imitate a marker.
  const markerIds = dopplerImageMarkerIds(markdown);
  const wanted = new Set(markerIds);
  const resolvable = new Set<string>();
  const byKind: Record<string, number> = {};
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let pending = `{"version":${JSON.stringify(DOPPLER_FIGURES_INDEX_VERSION)},"documentId":${JSON.stringify(documentId)},"figures":[`;
    let first = true;
    for await (const line of spillLines(set.ledger.spill)) {
      const record = line.x ?? recordOf(line.r);
      byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
      if (record.fileOf && wanted.has(record.id)) resolvable.add(record.id);
      pending += `${first ? "" : ","}${JSON.stringify(record)}`;
      first = false;
      if (pending.length >= 256 * 1024) { await handle.write(pending); pending = ""; }
    }
    const markers = markerIds.filter((id) => resolvable.has(id));
    pending += `],"markers":${JSON.stringify(markers)}}\n`;
    await handle.write(pending);
    return { path: file, byKind, markers: markerIds.length, markersResolved: markers.length };
  } finally {
    await handle.close();
  }
}

// ---- Resume: the images folder as a DIR again ----

/** Reads stored objects (the worker's ArtifactStore): streamed when it can, else whole. */
export interface DopplerFolderReader {
  getBytes(key: string): Promise<Buffer>;
  openStream?(key: string, signal?: AbortSignal): Promise<{ stream: AsyncIterable<Uint8Array>; size: number | null }>;
}

/** Download one object to a new file (mode 0600, never replacing one), checking its size and SHA-256 as it streams. */
async function downloadChecked(reader: DopplerFolderReader, key: string, file: string, expected: { size: number | null; sha256: string; max?: number }, signal?: AbortSignal): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const hash = createHash("sha256");
  let total = 0;
  try {
    const whole = async function* () { yield await reader.getBytes(key); };
    const chunks: AsyncIterable<Uint8Array> = reader.openStream ? (await reader.openStream(key, signal)).stream : whole();
    for await (const chunk of chunks) {
      signal?.throwIfAborted();
      total += chunk.length;
      if (expected.size !== null && total > expected.size) throw new DopplerFigureRejection("size-mismatch");
      if (expected.max !== undefined && total > expected.max) throw new DopplerFigureRejection("oversized-file");
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  if ((expected.size !== null && total !== expected.size) || hash.digest("hex") !== expected.sha256) {
    throw new DopplerFigureRejection(expected.size === null ? "manifest-changed" : "sha256-mismatch");
  }
}

/**
 * Rebuild `pdftomarkdown --images-resume`'s DIR from stored state, for a resume worker: the document's (or one shard's)
 * `manifest.jsonl`, whose SHA-256 must be the one the ledger recorded, validated line by line. By default that is all
 * (`manifestOnly`): Doppler resumes from the manifest alone and writes only the images still to do, so finished figures
 * never travel back into the VM (no transfer, no VM disk or memory for them). `manifestOnly: false` also downloads every
 * file the manifest lists as extracted, each from the key derived from its id (never a listing) to its page path, checked
 * against the manifest's size and SHA-256 (tests and debugging). Streamed throughout. `page-facts.jsonl` stays out.
 * `dir` must be absent (it is created, mode 0700) or an empty real directory: a download never mixes with files already
 * there.
 */
export async function downloadDopplerImagesDir(args: {
  storage: DopplerFolderReader;
  document: { id: string; userId: string; runId: string; artifactRoot?: string | null };
  runId: string;
  manifestSha256: string;
  pageCount: number;
  dir: string;
  /** One shard's manifest (`images/shards/<first>-<last>/manifest.jsonl`), validated against that range. */
  shard?: { first: number; last: number };
  /** Default true: the manifest only. */
  manifestOnly?: boolean;
  signal?: AbortSignal;
}): Promise<{ files: number; bytes: number }> {
  await mkdir(path.dirname(args.dir), { recursive: true, mode: 0o700 });
  try {
    await mkdir(args.dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(args.dir);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(args.dir)).length > 0) throw new DopplerFigureRejection("resume-dir-not-empty");
  }
  const caps = dopplerAssetCaps(args.pageCount);
  const manifestPath = path.join(args.dir, DOPPLER_MANIFEST_V3_FILE);
  const manifestKey = dopplerFolderKey(args.document, args.runId, args.shard ? { shard: [args.shard.first, args.shard.last] as const } : "manifestV3");
  const expected = { size: null, sha256: args.manifestSha256, max: caps.manifestV3Bytes };
  try {
    await downloadChecked(args.storage, manifestKey, manifestPath, expected, args.signal);
  } catch (error) {
    // A resume committed its manifest's SHA-256 but died before publishing it: the staged copy, by content.
    if (!(error instanceof DopplerFigureRejection) && !isMissingObjectError(error)) throw error;
    await rm(manifestPath, { force: true });
    try {
      await downloadChecked(args.storage, dopplerStagedManifestKey(args.document, args.runId, args.manifestSha256), manifestPath, expected, args.signal);
    } catch {
      // No usable staged copy either: the stored manifest's own failure is the answer (`manifest-changed`, or missing).
      throw error;
    }
  }
  const validator = new DopplerManifestV3Validator({
    maxLines: caps.entries, maxPage: args.pageCount, ...(args.shard ? { range: [args.shard.first, args.shard.last] as const } : {}),
  });
  const root = await openRoot(args.dir);
  const files: Array<{ id: string; path: string; format: DopplerFigureFormat; bytes: number; sha256: string }> = [];
  await readManifestLines(root, validator, async ({ file }) => { if (file) files.push(file); }, args.signal, DOPPLER_MANIFEST_V3_FILE, caps.manifestV3Bytes);
  if (args.manifestOnly !== false) return { files: 0, bytes: 0 };
  let bytes = 0;
  for (const file of files) {
    args.signal?.throwIfAborted();
    const relative = dopplerAssetPath(file.id, file.format);
    if (!relative || relative !== file.path) throw new DopplerFigureRejection("manifest-invalid");
    await mkdir(path.join(args.dir, path.dirname(relative)), { recursive: true, mode: 0o700 });
    await downloadChecked(args.storage, dopplerFolderKey(args.document, args.runId, { id: file.id, format: file.format }), path.join(args.dir, relative), { size: file.bytes, sha256: file.sha256 }, args.signal);
    bytes += file.bytes;
  }
  return { files: files.length, bytes };
}

/** The `source.json` pointer for a document: its source object, never a copy (sources are deduplicated across documents). */
export function dopplerSourcePointer(document: { sourceKey: string; sourceSha256?: string | null; pageCount: number; mimeType: string }): DopplerSourcePointer {
  return { sourceKey: document.sourceKey, sha256: document.sourceSha256 ?? null, pageCount: document.pageCount, mimeType: document.mimeType };
}

/** Where a manifest waits before its ledger write commits: `images/.staging/<sha256>.jsonl` (never served, never collected as a figure). */
export function dopplerStagedManifestKey(document: { id: string; userId: string; runId: string; artifactRoot?: string | null }, runId: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new DopplerFigureRejection("manifest-changed");
  return `${dopplerDocumentPrefix(documentArtifactRoot(document, runId), document.id)}${DOPPLER_STORE_LAYOUT.imagesFolder}.staging/${sha256}.jsonl`;
}

/**
 * A resume's manifests, written around its ledger write so storage and the ledger never disagree: `phase: "stage"` before
 * the write (to the staging key, by content: a later download falls back to it by the committed SHA-256), `phase:
 * "publish"` after it commits (to the manifest's own key). A crash between the two leaves the committed SHA-256 reachable.
 */
export async function storeDopplerFolderManifests(args: {
  storage: DopplerFigureStorage; set: DopplerFigureSet; document: { id: string; userId: string; runId: string; artifactRoot?: string | null };
  runId: string; phase: "stage" | "publish"; budgets?: DopplerStoreBudgets; signal?: AbortSignal;
}): Promise<{ bytes: number }> {
  const budgets = args.budgets ?? dopplerStoreBudgets();
  const root = await openRoot(args.set.dir);
  let bytes = 0;
  for (const manifest of args.set.manifests) {
    const finalKey = dopplerFolderKey(args.document, args.runId, manifest.range ? { shard: manifest.range } : args.set.version === 3 ? "manifestV3" : "manifest");
    const target = args.phase === "stage" ? dopplerStagedManifestKey(args.document, args.runId, manifest.sha256) : finalKey;
    await uploadChecked({
      storage: args.storage, budgets, key: target, contentType: args.set.version === 3 ? "text/plain; charset=utf-8" : "application/json",
      size: manifest.size, signal: args.signal,
      open: async () => (await openFolderFile(root, manifest.relative, manifest.size, Number.MAX_SAFE_INTEGER)).handle,
      check: { expectedSize: manifest.size, sha256: manifest.sha256, magic: null },
    });
    bytes += manifest.size;
  }
  return { bytes };
}

/**
 * Every URI a store of `set` can make reachable (figure files, manifests, the index, `document.md`), derived from the
 * layout before anything is uploaded: what a PII withholding adds to the document's withheld list first.
 */
export function dopplerFigureUris(
  storage: Pick<DopplerFigureStorage, "uri">, document: { id: string; userId: string; runId: string; artifactRoot?: string | null }, runId: string,
  set: Pick<DopplerFigureSet, "files" | "manifests" | "version">,
): string[] {
  const key = (object: Parameters<typeof dopplerFolderKey>[2]) => storage.uri(dopplerFolderKey(document, runId, object));
  return [
    ...set.files.map((file) => key({ id: file.id, format: file.format })),
    ...set.manifests.map((manifest) => key(manifest.range ? { shard: manifest.range } : set.version === 3 ? "manifestV3" : "manifest")),
    key("index"), key("markdown"),
  ];
}
