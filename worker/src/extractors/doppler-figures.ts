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
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  DOPPLER_FIGURE_FILE_NAME, DOPPLER_FIGURE_LIMITS, DOPPLER_FIGURE_MEDIA_TYPES, DOPPLER_FIGURES_INDEX_SLOT, DOPPLER_FIGURES_INDEX_VERSION,
  DOPPLER_FIGURES_MANIFEST, DOPPLER_MANIFEST_V3_FILE, DOPPLER_MANIFEST_V3_LINE_BYTES, DOPPLER_MANIFEST_V2_LIMITS, DOPPLER_STORE_LAYOUT,
  DopplerManifestV3Error, DopplerManifestV3Validator, addDocumentAssetCount, dopplerAssetCaps, dopplerAssetPath, dopplerAssetStorageKey,
  dopplerDocumentPrefix, dopplerEntryFileCap, dopplerFigureSlot, dopplerImageExtractEnabled, dopplerImageMarkerIds, dopplerLedgerAssets,
  dopplerManifestRunFacts, dopplerManifestV3RunFacts, emptyDocumentAssetCounts, parseDopplerFigureId, parseDopplerManifest,
  checkedDopplerFigureGaps, dopplerManifestV3HeaderSchema, dopplerRangeManifestKey,
  type DocumentAsset, type DocumentAssetCounts, type DopplerAssetCaps, type DopplerFigureFormat, type DopplerFigureRecord,
  type DopplerManifest, type DopplerManifestRunFacts,
} from "@docslurp/shared";

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

/** One spilled ledger row (JSON line) with the index record fields only the index needs. */
interface SpillLine { r: DocumentAsset; x?: DopplerFigureRecord }

export interface DopplerFigureSet {
  /** The folder the set was read from (quiescent: the provider's VM has exited). */
  dir: string;
  version: 1 | 2 | 3;
  /** The manifest's name in the folder (`manifest.jsonl` for version 3), its size and SHA-256 (stored unchanged). */
  manifestFile: string;
  manifestSize: number;
  manifestSha256: string;
  /** Version 2 and 3 run facts (null for version 1). */
  run: DopplerManifestRunFacts | null;
  complete: boolean;
  /** The files to store; no bytes are held: each is streamed, checked and uploaded by storeDopplerFigures. */
  files: DopplerFigureFile[];
  /** The ledger rows, one JSON line each in id order, spilled to a private temporary file (see disposeDopplerFigureSet). */
  ledger: { spill: string; rows: number; counts: DocumentAssetCounts };
  /** `page-facts.jsonl` beside the manifest (version 2 and 3), when the provider returned it. */
  pageFacts: { size: number } | null;
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
 * Read a version 3 `manifest.jsonl` line by line: at most 64 KiB per line, ASCII only, `\n`-terminated, hashed as it is
 * read (the end line carries the hash of every byte before it). Holds one line and one read buffer at a time.
 */
async function readManifestLines(
  root: FolderRoot, validator: DopplerManifestV3Validator, onImage: (accepted: NonNullable<ReturnType<DopplerManifestV3Validator["accept"]>>) => Promise<void>,
  signal?: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  const { handle, size } = await openFolderFile(root, DOPPLER_MANIFEST_V3_FILE, null, Number.MAX_SAFE_INTEGER);
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
 * `page-facts.jsonl`, and `page-NNNN` real directories holding only `(image|figure)-NNN.<format>` regular files.
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
    /**
     * A resume's folder (`--images-resume` given the stored manifest only): images the ledger already holds a stored file
     * for (id → SHA-256) must come back with that same digest and without a file; a file or another digest for one of
     * them is `resume-rewrite`. Only new files are stored.
     */
    resume?: { stored: ReadonlyMap<string, string> };
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
  for (const dirent of listed) {
    if (dirent.isDirectory && PAGE_DIR.test(dirent.name)) { pageDirs.push(dirent.name); continue; }
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
  if (!manifestFile) throw new DopplerFigureRejection("missing-manifest");
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
  const kept = new Set<string>();
  let fileBytes = 0;
  const addFile = (relative: string, id: string, format: DopplerFigureFormat, size: number, sha256: string, cap: number) => {
    const storedSha = args.resume?.stored.get(id);
    if (storedSha !== undefined) {
      // Already stored: the delivery must report the same file; it may hand it back (a retry that redid it) or not (a
      // manifest-only resume), and it is never uploaded again.
      if (storedSha !== sha256) throw new DopplerFigureRejection("resume-rewrite");
      kept.add(relative);
      return;
    }
    if (size > cap) throw new DopplerFigureRejection("oversized-file");
    expected.set(relative, { id, format, mediaType: DOPPLER_FIGURE_MEDIA_TYPES[format], relative, size, sha256, cap });
    fileBytes += size;
    if (expected.size > caps.files) throw new DopplerFigureRejection("too-many-files");
    if (fileBytes > caps.totalBytes) throw new DopplerFigureRejection("total-bytes");
  };
  const spill = await SpillWriter.create();
  let version: 1 | 2 | 3;
  let manifestSize: number;
  let manifestSha256: string;
  let run: DopplerManifestRunFacts | null;
  let complete: boolean;
  try {
    if (manifestFile === DOPPLER_MANIFEST_V3_FILE) {
      version = 3;
      if (flat.size > 0) throw new DopplerFigureRejection("unexpected-file");
      const validator = new DopplerManifestV3Validator({ maxLines: caps.entries, maxPage: pageCount });
      let header: { link_prefix: string; source_sha256: string } | null = null;
      const read = await readManifestLines(root, validator, async ({ row, file, error }) => {
        if (!header) {
          header = validator.headerLine!;
          if (header.link_prefix !== DOPPLER_STORE_LAYOUT.imagesFolder) throw new DopplerFigureRejection("link-prefix");
          if (args.sourceSha256 && header.source_sha256 !== args.sourceSha256) throw new DopplerFigureRejection("source-mismatch");
        }
        if (file) addFile(file.path, file.id, file.format, file.bytes, file.sha256, dopplerEntryFileCap(file, caps));
        await spill.add({ r: row, x: recordOf(row, error) });
      }, args.signal);
      const summary = validator.finish();
      // A manifest with no image never reached the header checks above.
      if (summary.header.link_prefix !== DOPPLER_STORE_LAYOUT.imagesFolder) throw new DopplerFigureRejection("link-prefix");
      if (args.sourceSha256 && summary.header.source_sha256 !== args.sourceSha256) throw new DopplerFigureRejection("source-mismatch");
      manifestSize = read.size;
      manifestSha256 = read.sha256;
      run = dopplerManifestV3RunFacts(summary);
      complete = summary.complete;
    } else {
      const cap = Math.min(caps.manifestBytes, DOPPLER_MANIFEST_V2_LIMITS.maxManifestBytes);
      const raw = await readFolderFile(root, manifestFile, null, cap);
      let json: unknown;
      try { json = JSON.parse(raw.toString("utf8")); } catch { throw new DopplerFigureRejection("manifest-not-json"); }
      const manifest = parseDopplerManifest(json);
      json = undefined;
      if (!manifest) throw new DopplerFigureRejection("manifest-invalid");
      if (manifest.version === 1 && raw.length > DOPPLER_FIGURE_LIMITS.maxManifestBytes) throw new DopplerFigureRejection("oversized-file");
      if (manifest.manifest.images.some((entry) => entry.page > pageCount)) throw new DopplerFigureRejection("page-outside-document");
      version = manifest.version;
      manifestSize = raw.length;
      manifestSha256 = createHash("sha256").update(raw).digest("hex");
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
      // Spill in id order, with each entry's index record.
      const rows = dopplerLedgerAssets(manifest);
      const records = dopplerFigureRecords(manifest);
      const order = rows.map((_, i) => i).sort((a, b) => idOrder(rows[a]!.assetId, rows[b]!.assetId));
      for (const i of order) await spill.add({ r: rows[i]!, x: records[i]! });
    }
    if ((args.expect === "partial" && complete) || (args.expect === "complete" && !complete)) throw new DopplerFigureRejection("outcome-mismatch");

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
    const keptPresent = [...present].filter((name) => kept.has(name));
    for (const name of keptPresent) present.delete(name);
    if (expected.size !== present.size || [...present].some((name) => !expected.has(name))) throw new DopplerFigureRejection("files-do-not-match-manifest");
    for (const entry of expected.values()) {
      args.signal?.throwIfAborted();
      // `relative` comes from the validated manifest (a fixed pattern derived from ids), never from the listing.
      const { handle } = await openFolderFile(root, entry.relative, entry.size, entry.cap);
      await handle.close();
    }
    let pageFacts: DopplerFigureSet["pageFacts"] = null;
    if (hasPageFacts) {
      const { handle, size } = await openFolderFile(root, DOPPLER_STORE_LAYOUT.pageFacts, null, caps.pageFactsBytes);
      await handle.close();
      pageFacts = { size };
    }
    await spill.close();
    return {
      dir, version, manifestFile, manifestSize, manifestSha256, run, complete, files: [...expected.values()],
      ledger: { spill: spill.path, rows: spill.rows, counts: spill.counts }, pageFacts, caps,
    };
  } catch (error) {
    await spill.discard();
    throw error;
  }
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
  object: "markdown" | "source" | "index" | "manifest" | "manifestV3" | "pageFacts" | { id: string; format: DopplerFigureFormat; sha256: string },
): string {
  const root = documentArtifactRoot(document, runId);
  if (typeof object === "object") return dopplerAssetStorageKey(root, document.id, object.id, object.format, object.sha256);
  const prefix = dopplerDocumentPrefix(root, document.id);
  const images = `${prefix}${DOPPLER_STORE_LAYOUT.imagesFolder}`;
  switch (object) {
    case "markdown": return `${prefix}${DOPPLER_STORE_LAYOUT.markdown}`;
    case "source": return `${prefix}${DOPPLER_STORE_LAYOUT.source}`;
    case "index": return `${prefix}${DOPPLER_STORE_LAYOUT.index}`;
    case "manifest": return `${images}${DOPPLER_STORE_LAYOUT.manifest}`;
    case "manifestV3": return `${images}${DOPPLER_MANIFEST_V3_FILE}`;
    case "pageFacts": return `${images}${DOPPLER_STORE_LAYOUT.pageFacts}`;
  }
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
  /**
   * One streaming PUT of exactly `size` bytes (ArtifactStore.putSizedStream). Without it every file is read whole, one
   * at a time per upload slot, within the same budget.
   */
  putStream?(key: string, body: Readable, size: number, contentType: string): Promise<void>;
  /** Removes an upload whose bytes did not match the manifest (never a verified file: those stay for the next attempt). */
  deleteKeys?(keys: string[]): Promise<void>;
}

/**
 * The ledger beside an upload: `pending` records the next files before their upload, `stored` (a resume's only) flips
 * them once they landed and checked out. Called once per FIGURE_LEDGER_BATCH files, in order. A fresh pass has no
 * `stored`: its final ledger write commits every file as stored together with the slots that serve them, so a file is
 * never billed before it can be served.
 */
export interface DopplerFigureLedgerHooks {
  pending(rows: Array<DocumentAsset & { storageKey: string }>): Promise<void>;
  stored?(files: Array<{ id: string; key: string }>): Promise<void>;
}

/** Files recorded pending, uploaded and flipped to stored per step. */
export const FIGURE_LEDGER_BATCH = 64;

/** Why storing a validated figure set failed: a fixed slug for stage stats and telemetry, never the storage error text. */
export type DopplerFigureStoreFailure = "store-object-failed" | "store-index-failed";

/**
 * Storing figures failed part way. No slot was recorded, so no figure (and no index) is reachable for the document.
 * Verified uploads are kept (`cleanup: "kept"`): their pending (or stored) ledger rows let the next attempt adopt them
 * without a VM; anything no row vouches for is an unbilled orphan the audit removes.
 */
export class DopplerFigureStoreError extends Error {
  constructor(
    readonly reason: DopplerFigureStoreFailure,
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
export const DOPPLER_PAGE_FACTS_SLOT = "doppler-page-facts";
export const DOPPLER_MARKDOWN_SLOT = "doppler-markdown";

export interface StoredDopplerFigures {
  indexUri: string;
  /**
   * Artifact slots to record for the document: the index, the manifest, the page facts, the Markdown and one per stored
   * file. `source.json` has none: it names the source object, which is never served through an artifact.
   */
  slots: Array<{ slot: string; uri: string }>;
  /** Storage key of each stored file, by the id that owns it. */
  keys: Map<string, string>;
  /** The stored canonical manifest's key and SHA-256 (for the extraction level: what a resume downloads). */
  manifest: { key: string; sha256: string };
  /** Bytes of the stored canonical manifest and index (billed with the files). */
  storedBytes: { manifest: number; index: number };
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
}): Promise<void> {
  const streaming = !!args.storage.putStream && args.size > DOPPLER_UPLOAD_SMALL_FILE_BYTES;
  const release = await reserve(args.budgets, streaming ? Math.min(args.size, 2 * DOPPLER_UPLOAD_CHUNK_BYTES) : args.size, args.signal);
  let handle: FileHandle | null = null;
  try {
    args.signal?.throwIfAborted();
    handle = await args.open();
    if (streaming) {
      try {
        await args.storage.putStream!(args.key, checkedFileStream(handle, args.check), args.size, args.contentType);
      } catch (error) {
        const check = error instanceof StreamCheckError ? error : (error as { cause?: unknown })?.cause instanceof StreamCheckError ? (error as { cause: StreamCheckError }).cause : null;
        if (check) {
          await args.storage.deleteKeys?.([args.key]).catch(() => undefined);
          throw new DopplerFigureRejection(check.rule);
        }
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
    await args.storage.putBytes(args.key, data, args.contentType);
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
 * streams; then, once every file has landed and checked out, the manifest bytes unchanged, the page facts, the Markdown
 * as Doppler wrote it and `source.json`; DocSlurp's index last. Until the caller records the slots nothing is reachable;
 * any failure removes what this call wrote, best effort.
 */
export async function storeDopplerFigures(args: {
  storage: DopplerFigureStorage;
  document: { id: string; userId: string; runId: string; artifactRoot?: string | null };
  runId: string;
  figures: DopplerFigureSet;
  /** The stored Markdown: which markers it holds, and whether each names a stored figure. */
  markdown: string;
  /** The Markdown file exactly as Doppler wrote it (stored as `document.md`); the folder has none when absent. */
  dopplerMarkdownPath?: string | null;
  /** `source.json`; the folder has none when absent. */
  source?: DopplerSourcePointer | null;
  budgets?: DopplerStoreBudgets;
  /** The ledger rows beside the upload (pending before, stored after, per FIGURE_LEDGER_BATCH files). */
  ledger?: DopplerFigureLedgerHooks;
  signal?: AbortSignal;
}): Promise<StoredDopplerFigures> {
  const started = Date.now();
  const budgets = args.budgets ?? dopplerStoreBudgets();
  const set = args.figures;
  const key = (object: Parameters<typeof dopplerFolderKey>[2]) => dopplerFolderKey(args.document, args.runId, object);
  const indexKey = key("index");
  const manifestKey = key(set.version === 3 ? "manifestV3" : "manifest");
  const root = await openRoot(set.dir);
  const slots: StoredDopplerFigures["slots"] = [];
  const keys = new Map<string, string>();
  const written: string[] = [];
  let phase: DopplerFigureStoreFailure = "store-object-failed";
  let work: string | null = null;
  try {
    work = await mkdtemp(path.join(tmpdir(), "doppler-index-"));
    // 1. Every image file under its content-addressed key, concurrently, each verified as it streams; with the ledger, in
    //    steps of FIGURE_LEDGER_BATCH: recorded pending, uploaded, flipped to stored.
    for (const file of set.files) keys.set(file.id, key({ id: file.id, format: file.format, sha256: file.sha256 }));
    const rows = args.ledger ? await extractedRows(set, keys) : null;
    for (let start = 0; start < set.files.length; start += FIGURE_LEDGER_BATCH) {
      const step = set.files.slice(start, start + FIGURE_LEDGER_BATCH);
      if (args.ledger) await args.ledger.pending(step.map((file) => rows!.get(file.id)!));
      written.push(...step.map((file) => keys.get(file.id)!));
      await boundedPool(step, budgets.concurrency, (file) => uploadChecked({
        storage: args.storage, budgets, key: keys.get(file.id)!, contentType: file.mediaType, size: file.size, signal: args.signal,
        open: async () => (await openFolderFile(root, file.relative, file.size, file.cap)).handle,
        check: { expectedSize: file.size, sha256: file.sha256, magic: magicCheck(file.format) },
      }), args.signal);
      args.signal?.throwIfAborted();
      if (args.ledger?.stored) await args.ledger.stored(step.map((file) => ({ id: file.id, key: keys.get(file.id)! })));
    }
    for (const file of set.files) slots.push({ slot: dopplerFigureSlot(file.id), uri: args.storage.uri(keys.get(file.id)!) });
    args.signal?.throwIfAborted();

    // 2. Only now the canonical manifest (re-serialised from the validated lines, never Doppler's bytes; not served: it
    //    has no slot), the page facts, the Markdown and the source pointer.
    const canonical = await writeCanonicalManifest(root, set, work, args.signal);
    const tail: Array<() => Promise<void>> = [];
    written.push(manifestKey);
    const canonicalHost = await openHostFile(canonical.path);
    tail.push(() => uploadChecked({
      storage: args.storage, budgets, key: manifestKey, contentType: set.version === 3 ? "application/x-ndjson" : "application/json",
      size: canonical.size, signal: args.signal, open: canonicalHost.open,
      check: { expectedSize: canonical.size, sha256: canonical.sha256, magic: null },
    }));
    if (set.pageFacts) {
      const factsKey = key("pageFacts");
      const facts = set.pageFacts;
      written.push(factsKey);
      tail.push(() => uploadChecked({
        storage: args.storage, budgets, key: factsKey, contentType: "text/plain; charset=utf-8", size: facts.size, signal: args.signal,
        open: async () => (await openFolderFile(root, DOPPLER_STORE_LAYOUT.pageFacts, facts.size, set.caps.pageFactsBytes)).handle,
        check: { expectedSize: facts.size, sha256: null, magic: null },
      }));
      slots.push({ slot: DOPPLER_PAGE_FACTS_SLOT, uri: args.storage.uri(factsKey) });
    }
    if (args.dopplerMarkdownPath) {
      const markdownKey = key("markdown");
      const host = await openHostFile(args.dopplerMarkdownPath);
      written.push(markdownKey);
      tail.push(() => uploadChecked({
        storage: args.storage, budgets, key: markdownKey, contentType: "text/markdown; charset=utf-8", size: host.size, signal: args.signal,
        open: host.open, check: { expectedSize: host.size, sha256: null, magic: null },
      }));
      slots.push({ slot: DOPPLER_MARKDOWN_SLOT, uri: args.storage.uri(markdownKey) });
    }
    if (args.source) {
      const sourceKey = key("source");
      const source = args.source;
      written.push(sourceKey);
      tail.push(() => args.storage.putJson(sourceKey, { sourceKey: source.sourceKey, sha256: source.sha256, pageCount: source.pageCount, mimeType: source.mimeType }));
    }
    await boundedPool(tail, budgets.concurrency, (task) => task(), args.signal);
    args.signal?.throwIfAborted();

    // 3. DocSlurp's index, built from the spilled rows into a file and uploaded last.
    phase = "store-index-failed";
    const built = await writeIndexFile(path.join(work, "index.json"), set, args.document.id, args.markdown);
    written.push(indexKey);
    const host = await openHostFile(built.path);
    await uploadChecked({
      storage: args.storage, budgets, key: indexKey, contentType: "application/json", size: host.size, signal: args.signal,
      open: host.open, check: { expectedSize: host.size, sha256: null, magic: null },
    });
    // A cancellation that arrived during the final write still cancels: nothing is recorded and what was written is removed.
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
    return {
      indexUri: args.storage.uri(indexKey), slots, keys, manifest: { key: manifestKey, sha256: canonical.sha256 },
      storedBytes: { manifest: canonical.size, index: host.size }, stats,
    };
  } catch (error) {
    // Nothing is deleted: verified uploads stay under their content-addressed keys for the next attempt to adopt.
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

/** The extracted rows of the set's files (from the spill), each with its content-addressed key: what `pending` records. */
async function extractedRows(set: DopplerFigureSet, keys: ReadonlyMap<string, string>): Promise<Map<string, DocumentAsset & { storageKey: string }>> {
  const rows = new Map<string, DocumentAsset & { storageKey: string }>();
  for await (const line of spillLines(set.ledger.spill)) {
    const storageKey = keys.get(line.r.assetId);
    if (line.r.status === "extracted" && storageKey) rows.set(line.r.assetId, { ...line.r, storageKey });
  }
  if (rows.size !== set.files.length) throw new DopplerFigureRejection("files-do-not-match-manifest");
  return rows;
}

/** JSON with every non-ASCII character escaped (a version 3 line is ASCII only). */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The manifest DocSlurp stores: re-serialised from the provider's validated manifest, never its raw bytes. Version 3:
 * every line parsed and written again as compact ASCII JSON, the end line's hash recomputed over the new bytes, then the
 * whole file validated again from scratch (and it must describe the same number of images). Versions 1 and 2: the parsed
 * JSON written compactly. Returns the file in `work`, its size and SHA-256.
 */
async function writeCanonicalManifest(root: FolderRoot, set: DopplerFigureSet, work: string, signal?: AbortSignal): Promise<{ path: string; size: number; sha256: string }> {
  const out = path.join(work, set.version === 3 ? DOPPLER_MANIFEST_V3_FILE : DOPPLER_FIGURES_MANIFEST);
  if (set.version !== 3) {
    const raw = await readFolderFile(root, set.manifestFile, set.manifestSize, Math.max(set.manifestSize, 1));
    let json: unknown;
    try { json = JSON.parse(raw.toString("utf8")); } catch { throw new DopplerFigureRejection("manifest-not-json"); }
    const text = Buffer.from(asciiJson(json), "latin1");
    const handle = await open(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.write(text); } finally { await handle.close(); }
    return { path: out, size: text.length, sha256: createHash("sha256").update(text).digest("hex") };
  }
  const { handle: input, size } = await openFolderFile(root, set.manifestFile, set.manifestSize, Number.MAX_SAFE_INTEGER);
  const output = await open(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const preceding = createHash("sha256");
  let written = 0;
  try {
    const buffer = Buffer.allocUnsafe(DOPPLER_MANIFEST_V3_LINE_BYTES);
    let carry = "";
    for (let position = 0; position < size;) {
      signal?.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new DopplerFigureRejection("file-changed");
      position += bytesRead;
      const lines = (carry + buffer.toString("latin1", 0, bytesRead)).split("\n");
      carry = lines.pop()!;
      let chunk = "";
      for (const line of lines) {
        let value: Record<string, unknown>;
        try { value = JSON.parse(line) as Record<string, unknown>; } catch { throw new DopplerFigureRejection("manifest-not-json"); }
        if (value && typeof value === "object" && value.type === "end") value = { ...value, sha256: preceding.copy().update(chunk).digest("hex") };
        const text = `${asciiJson(value)}\n`;
        if (text.length > DOPPLER_MANIFEST_V3_LINE_BYTES) throw new DopplerFigureRejection("manifest-line-too-long");
        chunk += text;
      }
      preceding.update(chunk);
      written += chunk.length;
      await output.write(chunk);
    }
    if (carry !== "") throw new DopplerFigureRejection("manifest-unterminated-line");
  } finally {
    await input.close();
    await output.close();
  }
  // From scratch: the canonical bytes are a valid manifest of the same images.
  const validator = new DopplerManifestV3Validator({ maxLines: set.caps.entries, maxPage: Number.MAX_SAFE_INTEGER });
  let images = 0;
  const check = await readManifestLines(await openRoot(work), validator, async () => { images += 1; }, signal);
  if (images !== set.ledger.rows || check.size !== written) throw new DopplerFigureRejection("manifest-invalid");
  return { path: out, size: check.size, sha256: check.sha256 };
}

/** Write the index JSON from the spilled rows, streaming: `{version, documentId, markers, figures: [...]}`. */
async function writeIndexFile(file: string, set: Pick<DopplerFigureSet, "ledger">, documentId: string, markdown: string): Promise<{
  path: string; byKind: Record<string, number>; markers: number; markersResolved: number;
}> {
  return await writeIndexRecords(file, spillLines(set.ledger.spill), documentId, markdown);
}

async function writeIndexRecords(file: string, lines: AsyncIterable<SpillLine>, documentId: string, markdown: string): Promise<{
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
    for await (const line of lines) {
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
async function downloadChecked(reader: DopplerFolderReader, key: string, file: string, expected: { size: number | null; sha256: string }, signal?: AbortSignal): Promise<void> {
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
 * Rebuild `pdftomarkdown --images-resume`'s DIR from stored state, for a resume worker: the document's
 * `images/manifest.jsonl` (its SHA-256 must be the one the extraction level recorded) and every file it lists as
 * extracted, each downloaded from the key derived from its id (never a listing) to its page path and checked against the
 * manifest's size and SHA-256. Streamed throughout. `page-facts.jsonl` stays out: Doppler's DIR holds only the manifest
 * and page folders. `dir` must be empty or absent.
 */
export async function downloadDopplerImagesDir(args: {
  storage: DopplerFolderReader;
  document: { id: string; userId: string; runId: string; artifactRoot?: string | null };
  runId: string;
  manifestSha256: string;
  pageCount: number;
  dir: string;
  signal?: AbortSignal;
}): Promise<{ files: number; bytes: number }> {
  await mkdir(args.dir, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(args.dir, DOPPLER_MANIFEST_V3_FILE);
  await downloadChecked(args.storage, dopplerFolderKey(args.document, args.runId, "manifestV3"), manifestPath, { size: null, sha256: args.manifestSha256 }, args.signal);
  const caps = dopplerAssetCaps(args.pageCount);
  const validator = new DopplerManifestV3Validator({ maxLines: caps.entries, maxPage: args.pageCount });
  const root = await openRoot(args.dir);
  const files: Array<{ id: string; path: string; format: DopplerFigureFormat; bytes: number; sha256: string }> = [];
  await readManifestLines(root, validator, async ({ file }) => { if (file) files.push(file); }, args.signal);
  let bytes = 0;
  for (const file of files) {
    args.signal?.throwIfAborted();
    const relative = dopplerAssetPath(file.id, file.format);
    if (!relative || relative !== file.path) throw new DopplerFigureRejection("manifest-invalid");
    await mkdir(path.join(args.dir, path.dirname(relative)), { recursive: true, mode: 0o700 });
    await downloadChecked(args.storage, dopplerFolderKey(args.document, args.runId, { id: file.id, format: file.format, sha256: file.sha256 }), path.join(args.dir, relative), { size: file.bytes, sha256: file.sha256 }, args.signal);
    bytes += file.bytes;
  }
  return { files: files.length, bytes };
}

/**
 * A resume's input from stored state: only the document's canonical `images/manifest.jsonl` (its SHA-256 must be the one
 * the extraction level recorded), into an empty `dir`. Figure files never go back into the VM: `--images-resume` with a
 * manifest-only folder writes only the images still to do.
 */
export async function downloadDopplerResumeManifest(args: {
  storage: DopplerFolderReader;
  document: { id: string; userId: string; runId: string; artifactRoot?: string | null };
  runId: string;
  manifestSha256: string;
  dir: string;
  signal?: AbortSignal;
}): Promise<{ path: string }> {
  if (!/^[0-9a-f]{64}$/.test(args.manifestSha256)) throw new DopplerFigureRejection("manifest-changed");
  await mkdir(args.dir, { recursive: true, mode: 0o700 });
  const file = path.join(args.dir, DOPPLER_MANIFEST_V3_FILE);
  await downloadChecked(args.storage, dopplerFolderKey(args.document, args.runId, "manifestV3"), file, { size: null, sha256: args.manifestSha256 }, args.signal);
  return { path: file };
}

/** The `source.json` pointer for a document: its source object, never a copy (sources are deduplicated across documents). */
export function dopplerSourcePointer(document: { sourceKey: string; sourceSha256?: string | null; pageCount: number; mimeType: string }): DopplerSourcePointer {
  return { sourceKey: document.sourceKey, sha256: document.sourceSha256 ?? null, pageCount: document.pageCount, mimeType: document.mimeType };
}

// ---- Per-range deliveries: stored and committed as soon as each validates ----

/** One validated-on-arrival folder for a page range (a shard, or batches a VM streamed out before it finished). */
export interface DopplerFigureDelivery {
  dir: string;
  /** What the provider reported for it: exit 0 (`extracted`) or exit 5 (`partial`). */
  status: "extracted" | "partial";
  exitCode?: number;
  build?: string;
  /** Page ranges inside this delivery a shard returned nothing for (untrusted; checked against the page count). */
  gaps?: unknown;
}

/** The ledger operations a delivery needs (db/document-asset-ledger.ts through the worker's store). */
export interface DopplerFigureDeliveryLedger {
  beginFigureDelivery(args: { scope: import("../db/document-asset-ledger.js").DocumentAssetLedgerScope; sourceSha256: string; settingsSha256: string; fence?: { generation: number } }): Promise<{ generation: number; mode: "fresh" | "merge"; stored: Map<string, string> }>;
  markAssetsPending(args: { scope: import("../db/document-asset-ledger.js").DocumentAssetLedgerScope; rows: Array<DocumentAsset & { storageKey: string }>; fence?: { generation: number } }): Promise<unknown>;
  markAssetsStored(args: { scope: import("../db/document-asset-ledger.js").DocumentAssetLedgerScope; files: Array<{ id: string; key: string }>; fence?: { generation: number } }): Promise<unknown>;
  commitFigureDelivery(commit: import("../db/document-asset-ledger.js").FigureDeliveryCommit): Promise<{ upserted: number; kept: number; status: string }>;
}

export interface StoredFigureDelivery {
  generation: number;
  mode: "fresh" | "merge";
  range: { first: number; last: number };
  status: string;
  /** Files uploaded by this delivery, and images it repeated that were already stored (not uploaded again). */
  files: number;
  bytes: number;
  kept: number;
  manifest: { key: string; sha256: string; bytes: number };
}

/** The header of a version 3 manifest (first line), for its digests and page range before the folder is read whole. */
async function peekV3Header(dir: string): Promise<{ source_sha256: string; settings_sha256: string; pages: [number, number] | null }> {
  const root = await openRoot(dir);
  const { handle } = await openFolderFile(root, DOPPLER_MANIFEST_V3_FILE, null, Number.MAX_SAFE_INTEGER).catch(() => {
    throw new DopplerFigureRejection("delivery-needs-manifest-v3");
  });
  try {
    const buffer = Buffer.alloc(DOPPLER_MANIFEST_V3_LINE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (end < 0) throw new DopplerFigureRejection("manifest-line-too-long");
    let value: unknown;
    try { value = JSON.parse(buffer.toString("latin1", 0, end)); } catch { throw new DopplerFigureRejection("manifest-not-json"); }
    const parsed = dopplerManifestV3HeaderSchema.safeParse(value);
    if (!parsed.success) throw new DopplerFigureRejection("manifest-header-invalid");
    return parsed.data;
  } finally {
    await handle.close();
  }
}

/**
 * Store one delivery the moment it arrives, whatever later happens to the Markdown, the run or the worker:
 * 1. its digests (manifest header) start or continue the document's figure generation (`merge` when the PDF and settings
 *    are the ledger's: a retry, a resume or another batch of the same pass; images already stored are never uploaded
 *    or changed again);
 * 2. the folder is validated whole (readDopplerFigureDir), each new file recorded `pending`, uploaded under its
 *    content-addressed key while it is verified, and flipped to `stored`, FIGURE_LEDGER_BATCH files at a time;
 * 3. the range's canonical manifest is stored under its content-addressed key (never served);
 * 4. the rows, the range and its gaps are committed in one transaction fenced by the generation.
 * Deliveries are idempotent: the same range again (a VM that streamed it twice, a retry) writes the same keys and rows.
 * Nothing is ever deleted here; a failure part way leaves pending rows the next attempt adopts and unrecorded objects the
 * orphan GC removes. A resume passes its `fence` (claimed generation) and `resume: true`.
 */
export async function storeFigureDelivery(args: {
  storage: DopplerFigureStorage;
  ledger: DopplerFigureDeliveryLedger;
  scope: import("../db/document-asset-ledger.js").DocumentAssetLedgerScope;
  document: { id: string; userId: string; runId: string; artifactRoot?: string | null; pageCount: number; sourceSha256?: string | null };
  delivery: DopplerFigureDelivery;
  fence?: { generation: number };
  resume?: boolean;
  budgets?: DopplerStoreBudgets;
  signal?: AbortSignal;
}): Promise<StoredFigureDelivery> {
  if (args.scope.documentId !== args.document.id || args.scope.runId !== args.document.runId) throw new DopplerFigureRejection("delivery-scope");
  const header = await peekV3Header(args.delivery.dir);
  if (args.document.sourceSha256 && header.source_sha256 !== args.document.sourceSha256) throw new DopplerFigureRejection("source-mismatch");
  const pageCount = Math.max(1, Math.trunc(args.document.pageCount) || 1);
  const range = header.pages ? { first: header.pages[0], last: header.pages[1] } : { first: 1, last: pageCount };
  if (range.last > pageCount) throw new DopplerFigureRejection("page-outside-document");
  const start = await args.ledger.beginFigureDelivery({
    scope: args.scope, sourceSha256: header.source_sha256, settingsSha256: header.settings_sha256, ...(args.fence ? { fence: args.fence } : {}),
  });
  const fence = { generation: start.generation };
  const set = await readDopplerFigureDir(args.delivery.dir, {
    pageCount, signal: args.signal, expect: args.delivery.status === "partial" ? "partial" : "complete",
    sourceSha256: args.document.sourceSha256 ?? null, ...(start.mode === "merge" ? { resume: { stored: start.stored } } : {}),
  });
  let work: string | null = null;
  try {
    const budgets = args.budgets ?? dopplerStoreBudgets();
    const root = await openRoot(set.dir);
    const keys = new Map<string, string>();
    for (const file of set.files) keys.set(file.id, dopplerFolderKey(args.document, args.document.runId, { id: file.id, format: file.format, sha256: file.sha256 }));
    const rows = await extractedRows(set, keys);
    for (let at = 0; at < set.files.length; at += FIGURE_LEDGER_BATCH) {
      const step = set.files.slice(at, at + FIGURE_LEDGER_BATCH);
      await args.ledger.markAssetsPending({ scope: args.scope, rows: step.map((file) => rows.get(file.id)!), fence });
      await boundedPool(step, budgets.concurrency, (file) => uploadChecked({
        storage: args.storage, budgets, key: keys.get(file.id)!, contentType: file.mediaType, size: file.size, signal: args.signal,
        open: async () => (await openFolderFile(root, file.relative, file.size, file.cap)).handle,
        check: { expectedSize: file.size, sha256: file.sha256, magic: magicCheck(file.format) },
      }), args.signal);
      args.signal?.throwIfAborted();
      await args.ledger.markAssetsStored({ scope: args.scope, files: step.map((file) => ({ id: file.id, key: keys.get(file.id)! })), fence });
    }
    work = await mkdtemp(path.join(tmpdir(), "doppler-delivery-"));
    const canonical = await writeCanonicalManifest(root, set, work, args.signal);
    const manifestKey = dopplerRangeManifestKey(documentArtifactRoot(args.document, args.document.runId), args.document.id, range, canonical.sha256, true);
    const host = await openHostFile(canonical.path);
    await uploadChecked({
      storage: args.storage, budgets, key: manifestKey, contentType: "application/x-ndjson", size: canonical.size, signal: args.signal,
      open: host.open, check: { expectedSize: canonical.size, sha256: canonical.sha256, magic: null },
    });
    args.signal?.throwIfAborted();
    const committed = await args.ledger.commitFigureDelivery({
      scope: args.scope, generation: start.generation, range, assets: { spill: set.ledger.spill, rows: set.ledger.rows },
      manifest: { key: manifestKey, sha256: canonical.sha256, bytes: canonical.size, version: 3 }, run: set.run, complete: set.complete,
      exitCode: args.delivery.exitCode ?? null, build: args.delivery.build ?? null,
      ...(args.delivery.gaps !== undefined ? { gaps: (checkedDopplerFigureGaps(args.delivery.gaps, pageCount) ?? []).filter((gap) => gap.first >= range.first && gap.last <= range.last) } : {}),
      ...(args.resume ? { resume: true } : {}),
    });
    console.log(`[doppler-figures] delivery doc=${args.document.id} gen=${start.generation} mode=${start.mode} pages=${range.first}-${range.last} files=${set.files.length} kept=${committed.kept} status=${committed.status}`);
    return {
      generation: start.generation, mode: start.mode, range, status: committed.status, files: set.files.length,
      bytes: set.files.reduce((sum, file) => sum + file.size, 0), kept: committed.kept,
      manifest: { key: manifestKey, sha256: canonical.sha256, bytes: canonical.size },
    };
  } finally {
    await disposeDopplerFigureSet(set);
    if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Range manifest keys as the ledger records them (derived at commit): `.../images/manifests/<a>-<b>.<sha16>.jsonl`. */
const RANGE_MANIFEST_KEY = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/doppler\/[A-Za-z0-9-]{1,64}\/images\/manifests\/[1-9][0-9]{0,8}-[1-9][0-9]{0,8}\.[0-9a-f]{16}\.jsonl$/;

/** Download one stored range manifest to a new host file, checking its size and SHA-256 against the ledger. */
export async function downloadRangeManifest(
  storage: DopplerFolderReader, range: { key: string; sha256: string; bytes: number }, file: string, signal?: AbortSignal,
): Promise<void> {
  if (typeof range.key !== "string" || !RANGE_MANIFEST_KEY.test(range.key) || range.key.includes("..") ||
      !/^[0-9a-f]{64}$/.test(range.sha256) || range.key.split("/").at(-1)!.split(".")[1] !== range.sha256.slice(0, 16)) {
    throw new DopplerFigureRejection("manifest-key");
  }
  await downloadChecked(storage, range.key, file, { size: range.bytes, sha256: range.sha256 }, signal);
}

/**
 * After per-range deliveries, once the winning Markdown is known: the folder's `document.md` (as Doppler wrote it),
 * `source.json`, and DocSlurp's index built from the committed ledger rows of every range (an image whose owner has no
 * stored file resolves to nothing). Returns the slots to record (index, each stored file, the Markdown) and the index's
 * size (billed with the files). Nothing is deleted on failure.
 */
export async function finishDopplerFolder(args: {
  storage: DopplerFigureStorage;
  document: { id: string; userId: string; runId: string; artifactRoot?: string | null };
  runId: string;
  rows: readonly DocumentAsset[];
  files: ReadonlyArray<{ id: string; key: string }>;
  markdown: string;
  dopplerMarkdownPath?: string | null;
  source?: DopplerSourcePointer | null;
  budgets?: DopplerStoreBudgets;
  signal?: AbortSignal;
}): Promise<{ slots: Array<{ slot: string; uri: string }>; indexBytes: number; stats: { markers: number; markersResolved: number; byKind: Record<string, number> } }> {
  const budgets = args.budgets ?? dopplerStoreBudgets();
  const key = (object: Parameters<typeof dopplerFolderKey>[2]) => dopplerFolderKey(args.document, args.runId, object);
  const prefix = dopplerDocumentPrefix(documentArtifactRoot(args.document, args.runId), args.document.id);
  const slots: Array<{ slot: string; uri: string }> = [];
  const stored = new Set<string>();
  for (const file of args.files) {
    // Only keys under this document's own folder are ever recorded.
    if (!file.key.startsWith(`${prefix}${DOPPLER_STORE_LAYOUT.imagesFolder}`) || file.key.includes("..")) throw new DopplerFigureRejection("key-outside-folder");
    stored.add(file.id);
    slots.push({ slot: dopplerFigureSlot(file.id), uri: args.storage.uri(file.key) });
  }
  if (args.dopplerMarkdownPath) {
    const markdownKey = key("markdown");
    const host = await openHostFile(args.dopplerMarkdownPath);
    await uploadChecked({ storage: args.storage, budgets, key: markdownKey, contentType: "text/markdown; charset=utf-8", size: host.size, signal: args.signal,
      open: host.open, check: { expectedSize: host.size, sha256: null, magic: null } });
    slots.push({ slot: DOPPLER_MARKDOWN_SLOT, uri: args.storage.uri(markdownKey) });
  }
  if (args.source) await args.storage.putJson(key("source"), { sourceKey: args.source.sourceKey, sha256: args.source.sha256, pageCount: args.source.pageCount, mimeType: args.source.mimeType });
  const work = await mkdtemp(path.join(tmpdir(), "doppler-index-"));
  try {
    async function* lines(): AsyncGenerator<SpillLine> {
      for (const row of args.rows) {
        const owner = row.fileOf && stored.has(row.fileOf) ? row.fileOf : null;
        yield { r: { ...row, fileOf: owner } };
      }
    }
    const built = await writeIndexRecords(path.join(work, "index.json"), lines(), args.document.id, args.markdown);
    const indexKey = key("index");
    const host = await openHostFile(built.path);
    await uploadChecked({ storage: args.storage, budgets, key: indexKey, contentType: "application/json", size: host.size, signal: args.signal,
      open: host.open, check: { expectedSize: host.size, sha256: null, magic: null } });
    args.signal?.throwIfAborted();
    slots.unshift({ slot: DOPPLER_FIGURES_INDEX_SLOT, uri: args.storage.uri(indexKey) });
    return { slots, indexBytes: host.size, stats: { markers: built.markers, markersResolved: built.markersResolved, byKind: built.byKind } };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
