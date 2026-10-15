// Validating tar extractor for vendor bundles.
//
// Bundles are verified by sha256 before they reach this code, so a hostile
// archive needs a compromised build. Extraction still treats the archive as
// untrusted: only regular files, directories and contained relative symlinks
// are written, every path must stay under the destination, nothing is written
// through a symlink, modes lose setuid/setgid/sticky and group/world write,
// and total bytes and entry counts are capped.

import { createReadStream } from "node:fs";
import { mkdir, open, symlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createZstdDecompress, createGunzip } from "node:zlib";

const BLOCK = 512;

export interface SafeTarLimits {
  /** Maximum sum of regular-file sizes. */
  maxBytes: number;
  /** Maximum number of entries (files, directories, symlinks). */
  maxEntries: number;
}

export interface SafeTarResult {
  files: number;
  directories: number;
  symlinks: number;
  bytes: number;
}

export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(`unsafe archive: ${message}`);
    this.name = "UnsafeArchiveError";
  }
}

function readString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  // GNU base-256 encoding for large values: high bit of the first byte set.
  if (field[0]! & 0x80) {
    let value = field[0]! & 0x7f;
    for (let i = 1; i < field.length; i += 1) value = value * 256 + field[i]!;
    return value;
  }
  const text = readString(block, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new UnsafeArchiveError(`invalid numeric field "${text}"`);
  return Number.parseInt(text, 8);
}

function verifyChecksum(block: Buffer): void {
  const expected = readOctal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  if (sum !== expected) throw new UnsafeArchiveError("header checksum mismatch");
}

function parsePax(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) {
      throw new UnsafeArchiveError("malformed pax header");
    }
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

/** Normalize an archive member name to a safe relative path, or throw. */
export function safeMemberPath(name: string): string {
  if (name.includes("\0") || name.includes("\\")) throw new UnsafeArchiveError(`invalid characters in "${name}"`);
  if (name.startsWith("/")) throw new UnsafeArchiveError(`absolute path "${name}"`);
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) throw new UnsafeArchiveError(`parent traversal in "${name}"`);
  return parts.join("/");
}

/** A symlink target must be relative and resolve inside the extraction root. */
export function safeSymlinkTarget(memberPath: string, target: string): string {
  if (target === "" || target.includes("\0") || target.includes("\\")) throw new UnsafeArchiveError(`invalid symlink target for "${memberPath}"`);
  if (path.posix.isAbsolute(target)) throw new UnsafeArchiveError(`absolute symlink "${memberPath}" -> "${target}"`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(memberPath), target));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
    throw new UnsafeArchiveError(`symlink escapes the bundle "${memberPath}" -> "${target}"`);
  }
  return target;
}

type Pending =
  | { kind: "header" }
  | { kind: "file"; handle: FileHandle; remaining: number; padding: number }
  | { kind: "skip"; remaining: number; padding: number }
  | { kind: "meta"; type: string; remaining: number; padding: number; chunks: Buffer[] };

/**
 * Extract a (.tar, .tar.gz or .tar.zst) archive into an existing, empty
 * directory that the caller owns.
 */
export async function extractTarSafely(
  archivePath: string,
  destination: string,
  limits: SafeTarLimits,
  signal?: AbortSignal,
): Promise<SafeTarResult> {
  const root = path.resolve(destination);
  const result: SafeTarResult = { files: 0, directories: 0, symlinks: 0, bytes: 0 };
  const seen = new Set<string>();
  const symlinkPaths: string[] = [];
  let pending: Pending = { kind: "header" };
  let buffer: Buffer = Buffer.alloc(0);
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  let zeroBlocks = 0;
  let ended = false;

  const resolveInside = (relative: string): string => {
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new UnsafeArchiveError(`path escapes destination "${relative}"`);
    return target;
  };
  const assertNoSymlinkParent = (relative: string) => {
    for (const link of symlinkPaths) {
      if (relative === link || relative.startsWith(`${link}/`)) throw new UnsafeArchiveError(`entry "${relative}" is written through symlink "${link}"`);
    }
  };
  const register = (relative: string) => {
    if (seen.has(relative)) throw new UnsafeArchiveError(`duplicate entry "${relative}"`);
    seen.add(relative);
    if (seen.size > limits.maxEntries) throw new UnsafeArchiveError(`more than ${limits.maxEntries} entries`);
  };

  const handleHeader = async (block: Buffer) => {
    if (block.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) ended = true;
      return;
    }
    if (zeroBlocks > 0) throw new UnsafeArchiveError("data after end-of-archive marker");
    verifyChecksum(block);
    const type = String.fromCharCode(block[156]!) || "0";
    const size = readOctal(block, 124, 12);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;

    if (type === "x" || type === "L" || type === "K") {
      if (size > 1024 * 1024) throw new UnsafeArchiveError("oversized metadata header");
      pending = { kind: "meta", type, remaining: size, padding, chunks: [] };
      return;
    }
    if (type === "g") {
      pending = { kind: "skip", remaining: size, padding };
      return;
    }

    const prefix = readString(block, 345, 155);
    const rawName = longName ?? pax.path ?? (prefix ? `${prefix}/${readString(block, 0, 100)}` : readString(block, 0, 100));
    const rawLink = longLink ?? pax.linkpath ?? readString(block, 157, 100);
    const entrySize = pax.size !== undefined ? Number.parseInt(pax.size, 10) : size;
    const entryPadding = (BLOCK - (entrySize % BLOCK)) % BLOCK;
    const mode = readOctal(block, 100, 8);
    longName = null;
    longLink = null;
    pax = {};

    const relative = safeMemberPath(rawName);
    if (relative === "") {
      if (type !== "5") throw new UnsafeArchiveError("non-directory entry for the archive root");
      pending = { kind: "header" };
      return;
    }
    assertNoSymlinkParent(relative);
    const target = resolveInside(relative);

    if (type === "5") {
      register(relative);
      await mkdir(target, { recursive: true, mode: 0o755 });
      result.directories += 1;
      pending = entrySize > 0 ? { kind: "skip", remaining: entrySize, padding: entryPadding } : { kind: "header" };
      return;
    }
    if (type === "2") {
      register(relative);
      const linkTarget = safeSymlinkTarget(relative, rawLink);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await symlink(linkTarget, target);
      symlinkPaths.push(relative);
      result.symlinks += 1;
      pending = { kind: "header" };
      return;
    }
    if (type === "0" || type === "\0" || type === "7") {
      register(relative);
      if (!Number.isSafeInteger(entrySize) || entrySize < 0) throw new UnsafeArchiveError(`invalid size for "${relative}"`);
      result.bytes += entrySize;
      if (result.bytes > limits.maxBytes) throw new UnsafeArchiveError(`unpacked size exceeds ${limits.maxBytes} bytes`);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      // O_EXCL: never follow or replace an existing path.
      // Only the executable bit survives; setuid/setgid/sticky and group/world write never do.
      const handle = await open(target, "wx", mode & 0o111 ? 0o755 : 0o644);
      result.files += 1;
      if (entrySize === 0) {
        await handle.close();
        pending = { kind: "header" };
      } else {
        pending = { kind: "file", handle, remaining: entrySize, padding: entryPadding };
      }
      return;
    }
    // Hard links ("1"), devices ("3", "4"), FIFOs ("6") and vendor extensions are refused.
    throw new UnsafeArchiveError(`unsupported entry type "${type}" for "${relative}"`);
  };

  const consume = async () => {
    for (;;) {
      if (ended) {
        buffer = Buffer.alloc(0);
        return;
      }
      const state: Pending = pending;
      if (state.kind === "header") {
        if (buffer.length < BLOCK) return;
        const block = buffer.subarray(0, BLOCK);
        buffer = buffer.subarray(BLOCK);
        await handleHeader(block);
        continue;
      }
      if (state.remaining > 0) {
        if (buffer.length === 0) return;
        const take = Math.min(state.remaining, buffer.length);
        const chunk = buffer.subarray(0, take);
        buffer = buffer.subarray(take);
        state.remaining -= take;
        if (state.kind === "file") await state.handle.write(chunk);
        else if (state.kind === "meta") state.chunks.push(Buffer.from(chunk));
        if (state.remaining > 0) return;
      }
      if (buffer.length < state.padding) return;
      buffer = buffer.subarray(state.padding);
      if (state.kind === "file") await state.handle.close();
      if (state.kind === "meta") {
        const data = Buffer.concat(state.chunks);
        if (state.type === "x") pax = parsePax(data);
        else if (state.type === "L") longName = readString(data, 0, data.length);
        else longLink = readString(data, 0, data.length);
      }
      pending = { kind: "header" };
    }
  };

  const source = createReadStream(archivePath);
  const decoder = archivePath.endsWith(".zst") ? createZstdDecompress() : archivePath.endsWith(".gz") ? createGunzip() : null;
  const stream = decoder ? source.pipe(decoder) : source;
  if (decoder) source.on("error", (error) => decoder.destroy(error));
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("extraction aborted");
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      await consume();
    }
    if (!ended) throw new UnsafeArchiveError("truncated archive (no end-of-archive marker)");
    return result;
  } finally {
    const state = pending as Pending;
    if (state.kind === "file") await state.handle.close().catch(() => {});
    source.destroy();
  }
}
