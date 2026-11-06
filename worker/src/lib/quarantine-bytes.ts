import path from "node:path";

import { sniffFileBytes, type SniffedBytes } from "@docslurp/shared";

import type { ArchiveInspection, QuarantinePolicy } from "./quarantine.js";

/*
 * Byte inspection for quarantine: MIME sniffing, the file facts and ZIP central-directory checks. They read hostile bytes,
 * so production runs them in the parser VM (scripts/quarantine-inspect.mjs, through the runner); elsewhere in-process.
 */

type ZipEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  flags: number;
  unixMode: number;
};

/** What quarantine reads from the bytes: the sniff (shared sniffFileBytes) and the ZIP inspection. Facts follow from the sniff. */
export interface QuarantineInspection { sniffed: SniffedBytes; archive: ArchiveInspection | null }

export function inspectQuarantineBytes(bytes: Buffer, filename: string, policy: QuarantinePolicy): QuarantineInspection {
  return { sniffed: sniffFileBytes(bytes, filename), archive: inspectArchive(bytes, filename, policy) };
}

export function sniffMimeType(bytes: Buffer, filename: string): string | null {
  return sniffFileBytes(bytes, filename).mimeType;
}

export function inspectArchive(bytes: Buffer, filename: string, policy: QuarantinePolicy): ArchiveInspection | null {
  if (!isZipBytes(bytes)) {
    return null;
  }

  const parsed = parseZipEntries(bytes);
  if (!parsed) {
    return {
      kind: "zip",
      entryCount: 0,
      totalCompressedBytes: 0,
      totalUncompressedBytes: 0,
      maxEntryUncompressedBytes: 0,
      maxPathDepth: 0,
      compressionRatio: null,
      suspicious: true,
      inspectable: false,
      issues: ["archive-inspection-failed"]
    };
  }

  const entryCount = parsed.length;
  const totalCompressedBytes = parsed.reduce((sum, entry) => sum + entry.compressedSize, 0);
  const totalUncompressedBytes = parsed.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  const maxEntryUncompressedBytes = parsed.reduce((max, entry) => Math.max(max, entry.uncompressedSize), 0);
  const maxPathDepth = parsed.reduce((max, entry) => Math.max(max, entry.name.split("/").filter(Boolean).length), 0);
  const compressionRatio =
    totalCompressedBytes > 0 ? Number((totalUncompressedBytes / totalCompressedBytes).toFixed(2)) : null;
  const issues: string[] = [];
  const names = new Set<string>();
  for (const entry of parsed) {
    const normalized = entry.name.replace(/\\/g, "/");
    if (!normalized || /[\x00-\x1f:]/.test(normalized) || normalized.startsWith("/") || normalized.split("/").includes("..")) {
      issues.push("archive-unsafe-path");
    }
    const canonical = path.posix.normalize(normalized).replace(/\/$/, "");
    if (names.has(canonical)) issues.push("archive-duplicate-path");
    names.add(canonical);
    const fileType = entry.unixMode & 0xf000;
    if (fileType && fileType !== 0x8000 && fileType !== 0x4000) issues.push("archive-special-file");
    if (entry.flags & 0x41) issues.push("archive-encrypted-entry");
    if (entry.compressedSize === 0 && entry.uncompressedSize > 0) issues.push("archive-expansion-ratio-limit");
  }

  if (entryCount > policy.quarantineMaxArchiveEntries) {
    issues.push("archive-entry-count-limit");
  }
  if (maxPathDepth > policy.quarantineMaxArchiveDepth) {
    issues.push("archive-depth-limit");
  }
  if (totalUncompressedBytes > policy.quarantineMaxTotalUncompressedBytes) {
    issues.push("archive-expanded-bytes-limit");
  }
  if (maxEntryUncompressedBytes > policy.quarantineMaxSingleEntryBytes) {
    issues.push("archive-entry-size-limit");
  }
  if ((compressionRatio ?? 0) > policy.quarantineMaxExpansionRatio) {
    issues.push("archive-expansion-ratio-limit");
  }

  return {
    kind: "zip",
    entryCount,
    totalCompressedBytes,
    totalUncompressedBytes,
    maxEntryUncompressedBytes,
    maxPathDepth,
    compressionRatio,
    suspicious: issues.length > 0,
    inspectable: true,
    issues: [...new Set(issues)]
  };
}

export function describeArchiveIssue(issue: string, archive: ArchiveInspection): string {
  switch (issue) {
    case "archive-unsafe-path": return "archive contains a path outside its extraction directory";
    case "archive-duplicate-path": return "archive contains ambiguous duplicate paths";
    case "archive-special-file": return "archive contains a link or special filesystem entry";
    case "archive-encrypted-entry": return "encrypted archive entries cannot be scanned safely";
    case "archive-entry-count-limit":
      return `archive entry count ${archive.entryCount} exceeds limit`;
    case "archive-depth-limit":
      return `archive path depth ${archive.maxPathDepth} exceeds limit`;
    case "archive-expanded-bytes-limit":
      return `archive expanded size ${archive.totalUncompressedBytes} exceeds limit`;
    case "archive-entry-size-limit":
      return `archive entry size ${archive.maxEntryUncompressedBytes} exceeds limit`;
    case "archive-expansion-ratio-limit":
      return `archive expansion ratio ${archive.compressionRatio ?? "n/a"} exceeds limit`;
    default:
      return "archive could not be inspected safely";
  }
}

function hasPrefix(bytes: Buffer, expected: number[]): boolean {
  if (bytes.length < expected.length) {
    return false;
  }
  return expected.every((value, index) => bytes[index] === value);
}

function isZipBytes(bytes: Buffer): boolean {
  return hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) || hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06]) || hasPrefix(bytes, [0x50, 0x4b, 0x07, 0x08]);
}

function parseZipEntries(bytes: Buffer): ZipEntry[] | null {
  const endOffset = findEndOfCentralDirectory(bytes);
  if (endOffset < 0 || endOffset + 22 > bytes.length) {
    return null;
  }

  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralDirectoryOffset = bytes.readUInt32LE(endOffset + 16);
  const centralDirectorySize = bytes.readUInt32LE(endOffset + 12);
  if (bytes.readUInt16LE(endOffset + 4) !== 0 || bytes.readUInt16LE(endOffset + 6) !== 0 ||
      bytes.readUInt16LE(endOffset + 8) !== entryCount ||
      endOffset + 22 + bytes.readUInt16LE(endOffset + 20) !== bytes.length ||
      centralDirectoryOffset + centralDirectorySize !== endOffset) return null;
  if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
    return null;
  }

  const entries: ZipEntry[] = [];
  const ranges: Array<[number, number]> = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || bytes.readUInt32LE(offset) !== 0x02014b50) {
      return null;
    }

    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const fileNameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd + extraLength + commentLength > endOffset || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      return null;
    }

    // Reject conflicting alternate path encodings and ZIP64 metadata. Parsers
    // must not interpret a different extraction path from the one we inspect.
    for (const [extraStart, extraEnd] of [[nameEnd, nameEnd + extraLength]]) {
      let extraOffset = extraStart;
      while (extraOffset < extraEnd) {
        if (extraOffset + 4 > extraEnd) return null;
        const tag = bytes.readUInt16LE(extraOffset);
        const length = bytes.readUInt16LE(extraOffset + 2);
        if (extraOffset + 4 + length > extraEnd || tag === 1) return null;
        if (tag === 0x7075 && (length < 5 || !bytes.subarray(extraOffset + 9, extraOffset + 4 + length).equals(bytes.subarray(nameStart, nameEnd)))) return null;
        extraOffset += 4 + length;
      }
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const localOffset = bytes.readUInt32LE(offset + 42);
    if (bytes.readUInt16LE(offset + 34) !== 0 || localOffset + 30 > centralDirectoryOffset ||
        bytes.readUInt32LE(localOffset) !== 0x04034b50) return null;
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralDirectoryOffset ||
        bytes.readUInt16LE(localOffset + 6) !== flags ||
        bytes.readUInt16LE(localOffset + 8) !== bytes.readUInt16LE(offset + 10) ||
        !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(bytes.subarray(nameStart, nameEnd))) return null;
    for (const [localField, centralField] of [[14, 16], [18, 20], [22, 24]]) {
      const value = bytes.readUInt32LE(localOffset + localField);
      if (value !== bytes.readUInt32LE(offset + centralField) && (!(flags & 8) || value !== 0)) return null;
    }
    ranges.push([localOffset, dataOffset + compressedSize]);
    entries.push({
      flags,
      unixMode: bytes.readUInt32LE(offset + 38) >>> 16,
      name: bytes.subarray(nameStart, nameEnd).toString("utf8"),
      compressedSize,
      uncompressedSize
    });
    offset = nameEnd + extraLength + commentLength;
  }

  if (offset !== endOffset) return null;
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) return null;
  return entries;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}
