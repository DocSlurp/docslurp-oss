import { gunzipSync, inflateRawSync } from "node:zlib";

import { pdfEncryptionStructure } from "./pdf-encryption-structure.js";

/*
 * Nested-archive inspection for quarantine (parser VM only in production: it inflates hostile bytes).
 *
 * libclamav 1.4.3 leaves three holes inside archives that it reports clean with no alert (clam-hostile-matrix.docker.test.ts):
 * a ZIP64 member is skipped, a member over MaxFileSize is truncated and only the head is scanned, and the image has no RAR
 * engine. The top-level ZIP inspection already refuses a ZIP64 container and members over the entry limit; this walk applies
 * the same rules to every container nested in an accepted ZIP, at any depth up to ClamAV's recursion limit, and refuses
 * what it cannot inspect. It reads members whole (bounded by the entry and total limits), so a size the headers understate
 * is caught too.
 *
 * Walked: ZIP (stored and Deflate members), gzip, POSIX tar, and OLE2 compound files (Office embeddings, `\x01Ole10Native`
 * packages). Every refused condition (ZIP64, encrypted or oversized members, unsupported formats, depth) applies wherever
 * it appears inside any of them. Refused when nested: RAR, ACE, zstd, LZ4, lzip and WIM (ClamAV here cannot open them),
 * and 7z, bzip2 and xz (council N-M1: ClamAV opens them but this walk cannot decode them, so a ZIP64 member inside one
 * would be the scanner's alone to judge, and it skips ZIP64 members without an alert; Office files never embed them).
 * ZIP members compressed with anything but Stored or Deflate are refused too. CAB, ARJ, cpio, XAR, ALZ, ISO 9660 and
 * SZDD/KWAJ are left to ClamAV, which opens them: they are reported as a warning notice (archive-nested-uninspectable),
 * not refused (correctness council M3: Office printer settings carry CAB cabinets).
 * Containers are walked from their leading magic; a member that is not one but holds a ZIP or RAR a little way in (an archive behind a few junk bytes, a polyglot or self-extractor) is refused:
 * findEmbeddedContainer looks for the strong magic numbers in a member's first EMBEDDED_HEAD_BYTES and for a ZIP end
 * record in its last 64 KiB, which is where ZIP readers look. A container deeper inside a member, with no end record near
 * its end, is not found (docs/self-host/security.md); no extractor opens one there.
 */

export interface NestingLimits {
  /** Containers enclosing an object, the top-level ZIP being 1; deeper is refused (ClamAV MaxRecursion). */
  maxDepth: number;
  /** Largest member, stream or decompressed payload. */
  maxEntryBytes: number;
  /** Bytes inflated across the whole walk. */
  maxTotalBytes: number;
  /** Entries in one nested ZIP. */
  maxEntriesPerArchive: number;
  /** Objects visited across the whole walk (ClamAV MaxFiles). */
  maxObjects: number;
}

export interface NestingResult {
  issues: string[];
  /** Warning-only findings: `archive-nested-uninspectable`. */
  notices: string[];
  /** Nested containers walked (ZIP, gzip, OLE2). */
  nestedContainers: number;
  /** Deepest container reached, the top-level ZIP being 1. */
  maxNestingDepth: number;
}

export type ZipEntryLocation = {
  name: string;
  flags: number;
  /** Unix mode from the external attributes (high 16 bits). */
  unixMode: number;
  method: number;
  dataOffset: number;
  compressedSize: number;
  uncompressedSize: number;
};

export type ContainerKind =
  | { kind: "zip" | "gzip" | "ole" | "tar" }
  | { kind: "unsupported"; format: string }
  | { kind: "uninspectable"; format: string }
  | null;

const at = (bytes: Buffer, offset: number, magic: number[]) => bytes.length >= offset + magic.length && magic.every((value, index) => bytes[offset + index] === value);
const ascii = (text: string) => [...Buffer.from(text, "latin1")];

/** A nested object's container format, from its leading bytes. */
export function classifyContainer(bytes: Buffer): ContainerKind {
  if (at(bytes, 0, [0x50, 0x4b, 0x03, 0x04]) || at(bytes, 0, [0x50, 0x4b, 0x05, 0x06]) || at(bytes, 0, [0x50, 0x4b, 0x07, 0x08]) || at(bytes, 0, [0x50, 0x4b, 0x30, 0x30])) return { kind: "zip" };
  if (at(bytes, 0, [0x1f, 0x8b])) return { kind: "gzip" };
  if (at(bytes, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { kind: "ole" };
  // ClamAV in the worker image cannot open these (no libclamunrar; no ACE, zstd, LZ4, lzip or WIM support).
  if (at(bytes, 0, ascii("Rar!\x1a\x07"))) return { kind: "unsupported", format: "rar" };
  if (at(bytes, 7, ascii("**ACE**"))) return { kind: "unsupported", format: "ace" };
  if (at(bytes, 0, [0x28, 0xb5, 0x2f, 0xfd])) return { kind: "unsupported", format: "zstd" };
  if (at(bytes, 0, [0x04, 0x22, 0x4d, 0x18])) return { kind: "unsupported", format: "lz4" };
  if (at(bytes, 0, ascii("LZIP"))) return { kind: "unsupported", format: "lzip" };
  if (at(bytes, 0, ascii("MSWIM\0\0\0"))) return { kind: "unsupported", format: "wim" };
  // ClamAV opens these but this walk cannot decode them (council N-M1): refused, so nothing inside is left unchecked.
  if (at(bytes, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { kind: "unsupported", format: "7z" };
  if (at(bytes, 0, ascii("BZh")) && bytes.length > 3 && bytes[3]! >= 0x31 && bytes[3]! <= 0x39) return { kind: "unsupported", format: "bzip2" };
  if (at(bytes, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return { kind: "unsupported", format: "xz" };
  // ustar and GNU tar by magic; V7 and other pre-POSIX tar by a header checksum that adds up (council R6-M2).
  if (at(bytes, 257, ascii("ustar")) || isTarHeader(bytes)) return { kind: "tar" };
  // ClamAV opens these; this walk does not, so their members are unchecked (a warning).
  if (at(bytes, 0, ascii("MSCF\0\0\0\0"))) return { kind: "uninspectable", format: "cab" };
  if (at(bytes, 0, [0x60, 0xea])) return { kind: "uninspectable", format: "arj" };
  if (at(bytes, 0, ascii("07070")) || at(bytes, 0, [0xc7, 0x71]) || at(bytes, 0, [0x71, 0xc7])) return { kind: "uninspectable", format: "cpio" };
  if (at(bytes, 0, ascii("xar!"))) return { kind: "uninspectable", format: "xar" };
  if (at(bytes, 0, ascii("ALZ\x01"))) return { kind: "uninspectable", format: "alz" };
  if (at(bytes, 0x8001, ascii("CD001"))) return { kind: "uninspectable", format: "iso9660" };
  if (at(bytes, 0, ascii("SZDD")) || at(bytes, 0, ascii("KWAJ"))) return { kind: "uninspectable", format: "ms-compress" };
  return null;
}

/** The stored and computed checksums of the 512-byte tar header at `offset` (the checksum field counted as spaces). */
function tarChecksum(bytes: Buffer, offset: number): { stored: number; sum: number } {
  const field = bytes.subarray(offset + 148, offset + 156).toString("latin1").replace(/[\0 ]+$/, "").trim();
  const stored = /^[0-7]{1,8}$/.test(field) ? parseInt(field, 8) : NaN;
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : bytes[offset + index]!;
  return { stored, sum };
}

/**
 * A tar header without the ustar magic (V7, early GNU): a 512-byte block whose octal checksum adds up, with a name and an
 * octal size field. A checksum that matches by chance in an ordinary file is about as likely as any 6-digit coincidence;
 * a false match only makes the walk read the object as tar and refuse what does not parse.
 */
function isTarHeader(bytes: Buffer): boolean {
  if (bytes.length < 512 || bytes[0] === 0) return false;
  const { stored, sum } = tarChecksum(bytes, 0);
  if (!Number.isSafeInteger(stored) || stored !== sum || sum === 8 * 0x20) return false;
  return /^[0-7 \0]{11,12}$/.test(bytes.subarray(124, 136).toString("latin1"));
}

/** How far into a non-container object findEmbeddedContainer looks for a container's leading magic. */
export const EMBEDDED_HEAD_BYTES = 4096;
/** The ZIP end record sits in the last 22 + 65,535 (comment) bytes, which is all a ZIP reader searches. */
const ZIP_END_SEARCH_BYTES = 65_557;

/**
 * The containers searched for at an offset: the two whose contents ClamAV 1.4.3 leaves unscanned without an alert (a ZIP,
 * whose ZIP64 members it skips, and RAR, which this image cannot open) and that readers find behind leading bytes (ZIP and
 * RAR self-extractors). Containers ClamAV opens are not: Office printer settings (DEVMODE driver data) carry CAB
 * cabinets a little way in (2 of 1,112 local Office files, correctness council M3).
 */
const EMBEDDED_MAGICS: ReadonlyArray<readonly [string, Buffer]> = [
  ["zip", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ["rar", Buffer.from("Rar!\x1a\x07", "latin1")],
];

/**
 * A ZIP or RAR that does not start at offset 0 of `bytes` but that a tolerant reader would still find: a ZIP local header
 * or RAR signature in the first EMBEDDED_HEAD_BYTES past offset 0, or a ZIP end-of-central-directory record in the last 64 KiB (Python's zipfile,
 * openpyxl and most ZIP readers locate an archive from that record, wherever it starts). Null when there is none.
 * Bounded: at most EMBEDDED_HEAD_BYTES + 64 KiB are searched, whatever the object's size.
 */
export function findEmbeddedContainer(bytes: Buffer, options: { tailZip?: boolean } = {}): { format: string; offset: number } | null {
  const head = bytes.subarray(0, EMBEDDED_HEAD_BYTES + 16);
  for (const [format, magic] of EMBEDDED_MAGICS) {
    const offset = head.indexOf(magic, 1);
    if (offset > 0 && offset < EMBEDDED_HEAD_BYTES) return { format, offset };
  }
  if (options.tailZip !== false) {
    const tailStart = Math.max(0, bytes.length - ZIP_END_SEARCH_BYTES);
    const end = bytes.subarray(tailStart).lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end >= 0 && tailStart + end > 0) return { format: "zip-end-record", offset: tailStart + end };
  }
  return null;
}

type ZipParse = { entries: ZipEntryLocation[] } | { error: "zip64" | "malformed" | "hidden-entry" };

/**
 * The ZIP's entries from its central directory, cross-checked against each local header; `zip64` when any header uses
 * ZIP64 sizes or offsets (libclamav does not follow them), `malformed` for anything else this parser will not trust.
 */
export function parseZip(bytes: Buffer): ZipParse {
  const endOffset = findEndOfCentralDirectory(bytes);
  if (endOffset < 0 || endOffset + 22 > bytes.length) return { error: hasZip64Record(bytes) ? "zip64" : "malformed" };
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralDirectoryOffset = bytes.readUInt32LE(endOffset + 16);
  const centralDirectorySize = bytes.readUInt32LE(endOffset + 12);
  if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff || centralDirectorySize === 0xffffffff || hasZip64Record(bytes, endOffset)) return { error: "zip64" };
  if (bytes.readUInt16LE(endOffset + 4) !== 0 || bytes.readUInt16LE(endOffset + 6) !== 0 ||
      bytes.readUInt16LE(endOffset + 8) !== entryCount ||
      endOffset + 22 + bytes.readUInt16LE(endOffset + 20) !== bytes.length ||
      centralDirectoryOffset + centralDirectorySize !== endOffset) return { error: "malformed" };

  const entries: ZipEntryLocation[] = [];
  const ranges: Array<[number, number]> = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || bytes.readUInt32LE(offset) !== 0x02014b50) return { error: "malformed" };
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const fileNameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd + extraLength + commentLength > endOffset) return { error: "malformed" };
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || bytes.readUInt32LE(offset + 42) === 0xffffffff || bytes.readUInt16LE(offset + 34) === 0xffff) return { error: "zip64" };
    // Reject conflicting alternate path encodings and ZIP64 metadata. Parsers must not interpret a different extraction
    // path from the one we inspect.
    const extra = checkExtraFields(bytes, nameEnd, nameEnd + extraLength, bytes.subarray(nameStart, nameEnd));
    if (extra) return { error: extra };
    const flags = bytes.readUInt16LE(offset + 8);
    const localOffset = bytes.readUInt32LE(offset + 42);
    if (bytes.readUInt16LE(offset + 34) !== 0 || localOffset + 30 > centralDirectoryOffset ||
        bytes.readUInt32LE(localOffset) !== 0x04034b50) return { error: "malformed" };
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localNameEnd = localOffset + 30 + localNameLength;
    const dataOffset = localNameEnd + localExtraLength;
    if (dataOffset > centralDirectoryOffset) return { error: "malformed" };
    // A local header deferring its sizes to a ZIP64 extra field: libclamav 1.4.3 does not follow it and skips the member.
    if (bytes.readUInt32LE(localOffset + 18) === 0xffffffff || bytes.readUInt32LE(localOffset + 22) === 0xffffffff) return { error: "zip64" };
    // Local extra fields: only a ZIP64 field matters (some writers pad this area without a valid layout; the sizes used
    // are the central directory's, checked against the local header below).
    if (checkExtraFields(bytes, localNameEnd, dataOffset, null) === "zip64") return { error: "zip64" };
    if (dataOffset + compressedSize > centralDirectoryOffset ||
        bytes.readUInt16LE(localOffset + 6) !== flags ||
        bytes.readUInt16LE(localOffset + 8) !== bytes.readUInt16LE(offset + 10) ||
        !bytes.subarray(localOffset + 30, localNameEnd).equals(bytes.subarray(nameStart, nameEnd))) return { error: "malformed" };
    for (const [localField, centralField] of [[14, 16], [18, 20], [22, 24]] as const) {
      const value = bytes.readUInt32LE(localOffset + localField);
      if (value !== bytes.readUInt32LE(offset + centralField) && (!(flags & 8) || value !== 0)) return { error: "malformed" };
    }
    ranges.push([localOffset, dataOffset + compressedSize]);
    entries.push({
      name: bytes.subarray(nameStart, nameEnd).toString("utf8"),
      flags,
      unixMode: bytes.readUInt32LE(offset + 38) >>> 16,
      method: bytes.readUInt16LE(offset + 10),
      dataOffset,
      compressedSize,
      uncompressedSize,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  if (offset !== endOffset) return { error: "malformed" };
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1]![1])) return { error: "malformed" };
  // Bytes no central-directory entry covers (before the first entry, between entries, before the directory) may hold only
  // data descriptors and padding: a local header there is an entry the directory hides from this walk and from ClamAV,
  // which streaming (local-header) readers would still extract.
  const localHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let covered = 0;
  for (const [start, end] of [...ranges, [centralDirectoryOffset, centralDirectoryOffset] as [number, number]]) {
    if (start > covered && bytes.subarray(covered, start).indexOf(localHeader) >= 0) return { error: "hidden-entry" };
    covered = Math.max(covered, end);
  }
  return { entries };
}

/** The extra fields of one header: `zip64` for a ZIP64 field (id 1), `malformed` for a bad layout or a conflicting Unicode path. */
function checkExtraFields(bytes: Buffer, start: number, end: number, name: Buffer | null): "zip64" | "malformed" | null {
  let offset = start;
  while (offset < end) {
    if (offset + 4 > end) return "malformed";
    const tag = bytes.readUInt16LE(offset);
    const length = bytes.readUInt16LE(offset + 2);
    if (offset + 4 + length > end) return "malformed";
    if (tag === 1) return "zip64";
    if (name && tag === 0x7075 && (length < 5 || !bytes.subarray(offset + 9, offset + 4 + length).equals(name))) return "malformed";
    offset += 4 + length;
  }
  return null;
}

/** A ZIP64 end-of-central-directory record or locator just before the classic end record (or anywhere, with none). */
function hasZip64Record(bytes: Buffer, endOffset?: number): boolean {
  if (endOffset !== undefined) return endOffset >= 20 && bytes.readUInt32LE(endOffset - 20) === 0x07064b50;
  return bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])) || bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

class WalkState {
  readonly issues = new Set<string>();
  /** Warning-only findings (a nested format ClamAV opens but this walk does not). */
  readonly notices = new Set<string>();
  inflated = 0;
  objects = 0;
  nestedContainers = 0;
  maxNestingDepth = 1;
  constructor(readonly limits: NestingLimits) {}
  /** False once a walk-wide limit is hit: the walk stops (the issue already refuses the file). */
  get going(): boolean {
    return !this.issues.has("archive-nested-expanded-bytes-limit") && !this.issues.has("archive-nested-object-count-limit");
  }
  visit(): boolean {
    this.objects += 1;
    if (this.objects > this.limits.maxObjects) this.issues.add("archive-nested-object-count-limit");
    return this.going;
  }
  charge(bytes: number): boolean {
    this.inflated += bytes;
    if (this.inflated > this.limits.maxTotalBytes) this.issues.add("archive-nested-expanded-bytes-limit");
    return this.going;
  }
}

/**
 * Walk every member of a top-level ZIP that passed its own checks (the members' sizes are within the entry limit), and
 * every container nested in it. Issues are quarantine reason codes.
 */
export function inspectNestedArchives(bytes: Buffer, entries: ZipEntryLocation[], limits: NestingLimits): NestingResult {
  const state = new WalkState(limits);
  walkZipEntries(bytes, entries, 1, state);
  return { issues: [...state.issues], notices: [...state.notices], nestedContainers: state.nestedContainers, maxNestingDepth: state.maxNestingDepth };
}

/** Members of a ZIP at `depth` (1 = top level): each is read whole and, when it is a container, walked at depth + 1. */
function walkZipEntries(bytes: Buffer, entries: ZipEntryLocation[], depth: number, state: WalkState): void {
  const nested = depth > 1;
  for (const entry of entries) {
    if (!state.visit()) return;
    // Encrypted members are refused by ClamAV (AlertEncryptedArchive) and, top level, by the inspection.
    if (entry.flags & 0x41) {
      if (nested) state.issues.add("archive-nested-encrypted-entry");
      continue;
    }
    if (entry.uncompressedSize > state.limits.maxEntryBytes) {
      if (nested) state.issues.add("archive-nested-entry-size-limit");
      continue;
    }
    const data = readZipMember(bytes, entry, state, nested);
    if (!data) {
      if (!state.going) return;
      continue;
    }
    walkObject(data, depth + 1, state);
    if (!state.going) return;
  }
}

/** One member's bytes, verified against the size its headers declare; null (with an issue) when it cannot be read. */
function readZipMember(bytes: Buffer, entry: ZipEntryLocation, state: WalkState, nested: boolean): Buffer | null {
  const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      state.issues.add("archive-entry-size-mismatch");
      return null;
    }
    return compressed;
  }
  if (entry.method !== 8) {
    // Deflate64, BZip2, LZMA, PPMd, Zstandard...: what the member holds cannot be checked here.
    state.issues.add("archive-compression-unsupported");
    return null;
  }
  if (!state.charge(entry.uncompressedSize)) return null;
  let data: Buffer;
  try {
    // One byte of headroom: a member that inflates past its declared size throws instead of being cut to it.
    data = inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize + 1 });
  } catch (error) {
    state.issues.add((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "archive-entry-size-mismatch" : nested ? "archive-nested-inspection-failed" : "archive-entry-corrupt");
    return null;
  }
  if (data.length !== entry.uncompressedSize) {
    state.issues.add("archive-entry-size-mismatch");
    return null;
  }
  return data;
}

/** A member, stream or payload at `depth` containers deep: walked when it is a container, refused when it cannot be. */
function walkObject(data: Buffer, depth: number, state: WalkState, options: { embedded?: boolean } = {}): void {
  const container = classifyContainer(data);
  // Council R6-L2: an encrypted PDF inside a container is never decrypted for the scan (only a top-level PDF is), so the
  // scanner reads its streams as ciphertext. No extractor opens it, but a downloader does: refused as unscannable.
  if (!container && nestedPdfNamesEncrypt(data)) {
    state.issues.add("archive-nested-encrypted-pdf");
    return;
  }
  if (!container) {
    if (options.embedded !== false && findEmbeddedContainer(data)) state.issues.add("archive-nested-embedded-container");
    return;
  }
  if (container.kind === "unsupported") {
    state.issues.add("archive-nested-unsupported-format");
    return;
  }
  if (container.kind === "uninspectable") {
    state.notices.add("archive-nested-uninspectable");
    return;
  }
  if (depth > state.limits.maxDepth) {
    state.issues.add("archive-nested-depth-limit");
    return;
  }
  state.nestedContainers += 1;
  state.maxNestingDepth = Math.max(state.maxNestingDepth, depth);
  if (container.kind === "zip") {
    const parsed = parseZip(data);
    if ("error" in parsed) {
      state.issues.add(parsed.error === "zip64" ? "archive-nested-zip64" : parsed.error === "hidden-entry" ? "archive-hidden-entry" : "archive-nested-inspection-failed");
      return;
    }
    if (parsed.entries.length > state.limits.maxEntriesPerArchive) {
      state.issues.add("archive-nested-entry-count-limit");
      return;
    }
    walkZipEntries(data, parsed.entries, depth, state);
    return;
  }
  if (container.kind === "tar") {
    walkTar(data, depth, state);
    return;
  }
  if (container.kind === "gzip") {
    let inner: Buffer;
    try {
      inner = gunzipSync(data, { maxOutputLength: state.limits.maxEntryBytes });
    } catch (error) {
      state.issues.add((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "archive-nested-entry-size-limit" : "archive-nested-inspection-failed");
      return;
    }
    if (!state.charge(inner.length) || !state.visit()) return;
    walkObject(inner, depth + 1, state);
    return;
  }
  // Every stream is charged to the walk's byte budget and counted as an object before it is read (council M1: 2,000
  // directory entries sharing one 64 MiB chain must not be materialised 2,000 times).
  const streams = readCompoundFileStreams(data, state.limits.maxEntryBytes, (size) => state.visit() && state.charge(size));
  if ("error" in streams) {
    if (streams.error === "budget") return; // the walk-wide limit already refuses the file
    state.issues.add(streams.error === "size" ? "archive-nested-entry-size-limit" : streams.error === "shared" ? "archive-nested-ole-shared-sectors" : "archive-nested-inspection-failed");
    return;
  }
  for (const stream of streams.streams) {
    // An OLE Package object holds its file after a header (MS-OLEDS 2.3.6, as libclamav's cli_ole10native reads it): its
    // payload is walked where the header puts it, so the stream itself is not refused for holding it at that offset.
    const ole10Native = stream.name === "\x01Ole10Native";
    const payload = ole10Native ? ole10NativePayload(stream.data) : null;
    walkObject(stream.data, depth + 1, state, { embedded: !payload });
    if (!state.going) return;
    if (ole10Native) {
      walkObject(stream.data.subarray(4), depth + 1, state, { embedded: !payload });
      if (!state.going) return;
      if (payload) {
        if (!state.visit() || !state.charge(payload.length)) return;
        walkObject(payload, depth + 1, state);
        if (!state.going) return;
      }
    }
  }
}

/**
 * Members of a tar (ustar, GNU, pax or V7) at `depth`: every record's data is walked at depth + 1. Headers are 512-byte
 * blocks with an octal size; GNU base-256 sizes, a header checksum that does not add up, or a member running past the end
 * are refused as `archive-nested-inspection-failed`.
 *
 * Council R6-M2: a member's size is what tar readers use, so pax `size=` records (`x` for the next member, `g` for every
 * later one) override the header's octal size, as Python's tarfile, bsdtar and GNU tar do. An all-zero block does not end
 * the walk while non-zero bytes follow it (`tar --ignore-zeros` and tolerant readers go on reading): later headers are
 * walked too, and trailing bytes that are not a valid header are refused.
 */
function walkTar(data: Buffer, depth: number, state: WalkState): void {
  let offset = 0;
  let entries = 0;
  let globalSize: number | null = null;
  let nextSize: number | null = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      // An end-of-archive block: only zeros may follow, or the rest is walked as more members.
      const rest = data.subarray(offset + 512);
      const next = rest.findIndex((byte) => byte !== 0);
      if (next < 0) return;
      offset += 512 + Math.floor(next / 512) * 512;
      continue;
    }
    const { stored, sum } = tarChecksum(data, offset);
    const sizeField = header.subarray(124, 136);
    if (!Number.isSafeInteger(stored) || stored !== sum || sizeField[0]! & 0x80) {
      state.issues.add("archive-nested-inspection-failed");
      return;
    }
    const octal = parseInt(sizeField.toString("latin1").replace(/[\0 ]+$/, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156]!);
    // pax and GNU extension records describe the next member; their own size is the octal one.
    const extension = type === "x" || type === "g" || type === "X" || type === "L" || type === "K";
    const size = extension ? octal : nextSize ?? globalSize ?? octal;
    const start = offset + 512;
    if (!Number.isSafeInteger(size) || size < 0 || start + size > data.length) {
      state.issues.add("archive-nested-inspection-failed");
      return;
    }
    if (++entries > state.limits.maxEntriesPerArchive) {
      state.issues.add("archive-nested-entry-count-limit");
      return;
    }
    if (!state.visit()) return;
    const payload = data.subarray(start, start + size);
    if (type === "x" || type === "g" || type === "X") {
      const paxSize = paxRecordSize(payload);
      if (paxSize === "malformed") {
        state.issues.add("archive-nested-inspection-failed");
        return;
      }
      if (type === "g") globalSize = paxSize ?? globalSize;
      else nextSize = paxSize;
    } else if (!extension) {
      nextSize = null;
    }
    // Every record's data is walked whatever its type flag: tar readers (Python's tarfile among them) extract unknown types
    // as regular files, and pax or long-name records are short text that walks as nothing.
    if (size > state.limits.maxEntryBytes) state.issues.add("archive-nested-entry-size-limit");
    else if (size > 0) walkObject(payload, depth + 1, state);
    if (!state.going) return;
    offset = start + Math.ceil(size / 512) * 512;
  }
  // Bytes after the last whole block: tar pads to 512, so a partial block that is not zeros is not a tar this walk read.
  if (data.subarray(offset).some((byte) => byte !== 0)) state.issues.add("archive-nested-inspection-failed");
}

/** The `size` a pax extended header sets (null when it sets none); `malformed` when its records do not parse. */
function paxRecordSize(records: Buffer): number | null | "malformed" {
  let size: number | null = null;
  let offset = 0;
  while (offset < records.length) {
    if (records[offset] === 0) break;
    const space = records.indexOf(0x20, offset);
    if (space < 0 || space - offset > 20) return "malformed";
    const length = Number(records.subarray(offset, space).toString("latin1"));
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > records.length || records[offset + length - 1] !== 0x0a) return "malformed";
    const record = records.subarray(space + 1, offset + length - 1).toString("latin1");
    const equals = record.indexOf("=");
    if (equals < 0) return "malformed";
    if (record.slice(0, equals) === "size") {
      const value = record.slice(equals + 1);
      if (!/^\d{1,15}$/.test(value)) return "malformed";
      size = Number(value);
    }
    offset += length;
  }
  return size;
}

const PDF_HEADER = Buffer.from("%PDF-", "latin1");
const ENCRYPT_NAME = Buffer.from("/Encrypt", "latin1");
/** Whether a nested object is a PDF (libclamav's test: `%PDF-` in its first 1 KiB) naming /Encrypt, escaped names included. */
function nestedPdfNamesEncrypt(data: Buffer): boolean {
  if (data.subarray(0, 1024).indexOf(PDF_HEADER) < 0) return false;
  return data.includes(ENCRYPT_NAME) || pdfEncryptionStructure(data).encrypted;
}

/** The embedded file of an `\x01Ole10Native` Package stream, or null when the stream is not one. */
function ole10NativePayload(stream: Buffer): Buffer | null {
  let offset = 4 + 2;
  const cstring = () => {
    const end = stream.indexOf(0, offset);
    if (end < 0) return false;
    offset = end + 1;
    return true;
  };
  if (stream.length < offset || !cstring() || !cstring()) return null;
  offset += 4;
  if (offset + 4 > stream.length) return null;
  offset += 4 + stream.readUInt32LE(offset);
  if (offset + 4 > stream.length) return null;
  const size = stream.readUInt32LE(offset);
  offset += 4;
  if (offset + size > stream.length) return null;
  return stream.subarray(offset, offset + size);
}

const FREE = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;

/**
 * Every stream of an OLE2 compound file (MS-CFB): directory entries of type stream, read through the FAT or, below the
 * mini-stream cutoff, the mini FAT. Any structural inconsistency (a chain that loops, leaves the file or is shorter than
 * the stream) is an error: what this cannot read is refused, not skipped.
 */
export function readCompoundFileStreams(
  bytes: Buffer,
  maxStreamBytes: number,
  /** Called with each stream's size before it is read; false stops the read (`budget`). */
  admit: (size: number) => boolean = () => true,
): { streams: Array<{ name: string; data: Buffer }> } | { error: "malformed" | "size" | "shared" | "budget" } {
  if (bytes.length < 512) return { error: "malformed" };
  const sectorShift = bytes.readUInt16LE(0x1e);
  const miniShift = bytes.readUInt16LE(0x20);
  if ((sectorShift !== 9 && sectorShift !== 12) || miniShift !== 6 || bytes.readUInt16LE(0x1c) !== 0xfffe) return { error: "malformed" };
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const sectorCount = Math.floor((bytes.length - sectorSize) / sectorSize) + (((bytes.length - sectorSize) % sectorSize) > 0 ? 1 : 0);
  const sector = (index: number): Buffer | null => {
    if (index >= sectorCount) return null;
    const start = (index + 1) * sectorSize;
    const out = Buffer.alloc(sectorSize);
    bytes.copy(out, 0, start, Math.min(bytes.length, start + sectorSize));
    return out;
  };

  // FAT sectors: 109 in the header, then the DIFAT chain.
  const fatSectors: number[] = [];
  for (let index = 0; index < 109; index += 1) {
    const value = bytes.readUInt32LE(0x4c + index * 4);
    if (value !== FREE) fatSectors.push(value);
  }
  let difat = bytes.readUInt32LE(0x44);
  for (let hops = 0; difat !== END_OF_CHAIN && difat !== FREE; hops += 1) {
    if (hops > sectorCount) return { error: "malformed" };
    const block = sector(difat);
    if (!block) return { error: "malformed" };
    for (let index = 0; index < sectorSize / 4 - 1; index += 1) {
      const value = block.readUInt32LE(index * 4);
      if (value !== FREE) fatSectors.push(value);
    }
    difat = block.readUInt32LE(sectorSize - 4);
  }
  if (fatSectors.length > sectorCount) return { error: "malformed" };
  const fat: number[] = [];
  for (const index of fatSectors) {
    const block = sector(index);
    if (!block) return { error: "malformed" };
    for (let offset = 0; offset < sectorSize; offset += 4) fat.push(block.readUInt32LE(offset));
  }

  // Every sector (and mini sector) belongs to at most one chain: a chain that loops, or two directory entries, the
  // directory, the mini FAT or the mini stream sharing sectors, is refused (`shared`). That bounds the bytes read to the
  // file's own size, however many entries point at the same data.
  const usedSectors = new Set<number>();
  const usedMiniSectors = new Set<number>();
  let shared = false;
  const chain = (start: number, table: number[], limit: number, used?: Set<number>): number[] | null => {
    const out: number[] = [];
    for (let at = start; at !== END_OF_CHAIN; at = table[at]!) {
      if (at >= table.length || out.length > limit) return null;
      if (used) {
        if (used.has(at)) { shared = true; return null; }
        used.add(at);
      }
      out.push(at);
    }
    return out;
  };
  const readChain = (start: number, size: number): Buffer | null => {
    if (size === 0) return Buffer.alloc(0);
    const sectors = chain(start, fat, sectorCount, usedSectors);
    if (!sectors || sectors.length * sectorSize < size) return null;
    const parts: Buffer[] = [];
    for (const index of sectors) {
      const block = sector(index);
      if (!block) return null;
      parts.push(block);
    }
    return Buffer.concat(parts).subarray(0, size);
  };

  const directorySectors = chain(bytes.readUInt32LE(0x30), fat, sectorCount, usedSectors);
  if (!directorySectors) return { error: shared ? "shared" : "malformed" };
  const directoryBlocks = directorySectors.map(sector);
  if (directoryBlocks.some((block) => !block)) return { error: "malformed" };
  const dir = Buffer.concat(directoryBlocks as Buffer[]);
  const entries: Array<{ name: string; type: number; start: number; size: number }> = [];
  for (let offset = 0; offset + 128 <= dir.length; offset += 128) {
    const type = dir[offset + 0x42]!;
    if (type === 0) continue;
    const nameLength = Math.min(64, dir.readUInt16LE(offset + 0x40));
    const name = dir.subarray(offset, offset + Math.max(0, nameLength - 2)).toString("utf16le");
    const high = dir.readUInt32LE(offset + 0x7c);
    // Version 3 files leave the high size word undefined; version 4 sizes above 4 GiB are out of reach anyway.
    if (sectorShift === 12 && high !== 0) return { error: "size" };
    entries.push({ name, type, start: dir.readUInt32LE(offset + 0x74), size: dir.readUInt32LE(offset + 0x78) });
  }
  const root = entries.find((entry) => entry.type === 5);
  if (!root) return { error: "malformed" };

  const cutoff = bytes.readUInt32LE(0x38);
  let miniStream: Buffer | null = null;
  let miniFat: number[] | null = null;
  const streams: Array<{ name: string; data: Buffer }> = [];
  for (const entry of entries) {
    if (entry.type !== 2) continue;
    if (entry.size > maxStreamBytes) return { error: "size" };
    if (!admit(entry.size)) return { error: "budget" };
    if (entry.size < cutoff) {
      if (!miniStream) {
        miniStream = readChain(root.start, root.size);
        const miniFatBytes = readChain(bytes.readUInt32LE(0x3c), bytes.readUInt32LE(0x40) * sectorSize);
        if (!miniStream || !miniFatBytes) return { error: shared ? "shared" : "malformed" };
        miniFat = [];
        for (let offset = 0; offset + 4 <= miniFatBytes.length; offset += 4) miniFat.push(miniFatBytes.readUInt32LE(offset));
      }
      if (entry.size === 0) {
        streams.push({ name: entry.name, data: Buffer.alloc(0) });
        continue;
      }
      const sectors = chain(entry.start, miniFat!, miniStream.length / miniSize, usedMiniSectors);
      if (!sectors || sectors.length * miniSize < entry.size) return { error: shared ? "shared" : "malformed" };
      const parts: Buffer[] = [];
      for (const index of sectors) {
        if ((index + 1) * miniSize > miniStream.length) return { error: "malformed" };
        parts.push(miniStream.subarray(index * miniSize, (index + 1) * miniSize));
      }
      streams.push({ name: entry.name, data: Buffer.concat(parts).subarray(0, entry.size) });
    } else {
      const data = readChain(entry.start, entry.size);
      if (!data) return { error: shared ? "shared" : "malformed" };
      streams.push({ name: entry.name, data });
    }
  }
  return { streams };
}
