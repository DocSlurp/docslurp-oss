import path from "node:path";

import type { Config } from "../config.js";
import { DocumentStageError } from "../pipeline/checkpoints.js";
import type { MalwareScanResult } from "../tools/runner.js";
import type { CommandRunner } from "../tools/runner.js";

export interface QuarantineReason {
  code: string;
  severity: "error" | "warning";
  message: string;
  details?: Record<string, unknown>;
}

export interface ArchiveInspection {
  kind: "zip";
  entryCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  maxEntryUncompressedBytes: number;
  maxPathDepth: number;
  compressionRatio: number | null;
  suspicious: boolean;
  inspectable: boolean;
  issues: string[];
}

export interface QuarantineArtifact {
  documentId: string;
  filename: string;
  declaredMimeType: string;
  sniffedMimeType: string | null;
  mimeMismatch: boolean;
  archive: ArchiveInspection | null;
  malwareScan: MalwareScanResult;
  decision: "accepted" | "quarantined";
  reasons: QuarantineReason[];
}

type ZipEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  flags: number;
  unixMode: number;
};

type QuarantinePolicy = Pick<
  Config,
  | "quarantineFailOpenOnToolMissing"
  | "quarantineMaxArchiveEntries"
  | "quarantineMaxArchiveDepth"
  | "quarantineMaxTotalUncompressedBytes"
  | "quarantineMaxSingleEntryBytes"
  | "quarantineMaxExpansionRatio"
>;

export async function scanDocumentForQuarantine(args: {
  documentId: string;
  filename: string;
  declaredMimeType: string;
  bytes: Buffer;
  tempFile: string;
  runner: CommandRunner;
  policy: QuarantinePolicy;
  signal?: AbortSignal;
}): Promise<QuarantineArtifact> {
  const reasons: QuarantineReason[] = [];
  const sniffedMimeType = sniffMimeType(args.bytes, args.filename);
  const mimeMismatch = isUnsafeMimeMismatch(args.declaredMimeType, sniffedMimeType);
  if (mimeMismatch) {
    reasons.push({
      code: "mime-mismatch",
      severity: "error",
      message: `declared ${args.declaredMimeType} but sniffed ${sniffedMimeType ?? "unknown"}`,
      details: {
        declaredMimeType: args.declaredMimeType,
        sniffedMimeType
      }
    });
  }

  const archive = inspectArchive(args.bytes, args.filename, args.policy);
  if (archive) {
    for (const issue of archive.issues) {
      reasons.push({
        code: issue,
        severity: "error",
        message: describeArchiveIssue(issue, archive),
        details: {
          entryCount: archive.entryCount,
          totalCompressedBytes: archive.totalCompressedBytes,
          totalUncompressedBytes: archive.totalUncompressedBytes,
          maxEntryUncompressedBytes: archive.maxEntryUncompressedBytes,
          maxPathDepth: archive.maxPathDepth,
          compressionRatio: archive.compressionRatio
        }
      });
    }
  }

  const malwareScan = await args.runner.scanForMalware(args.tempFile, args.signal);
  if (malwareScan.status === "infected") {
    reasons.push({
      code: "malware-detected",
      severity: "error",
      message: `malware signature ${malwareScan.signature ?? "unknown"} detected`,
      details: {
        engine: malwareScan.engine,
        signature: malwareScan.signature
      }
    });
  } else if (malwareScan.status === "skipped-unavailable" || malwareScan.status === "error") {
    const failClosed = !args.policy.quarantineFailOpenOnToolMissing;
    reasons.push({
      code: malwareScan.status === "error" ? "malware-scan-error" : "malware-scan-unavailable",
      severity: failClosed ? "error" : "warning",
      message:
        malwareScan.status === "error"
          ? `malware scan failed${malwareScan.stderr ? `: ${malwareScan.stderr.trim()}` : ""}`
          : "malware scanner unavailable",
      details: {
        engine: malwareScan.engine,
        stderr: malwareScan.stderr || null,
        exitCode: malwareScan.exitCode
      }
    });
  }

  if (malwareScan.databaseStatus === "stale" || malwareScan.databaseStatus === "missing") {
    reasons.push({
      code: malwareScan.databaseStatus === "stale" ? "malware-definitions-stale" : "malware-definitions-missing",
      severity: malwareScan.status === "error" ? "error" : "warning",
      message:
        malwareScan.databaseStatus === "stale"
          ? `malware definitions are stale (${malwareScan.databaseAgeHours ?? "unknown"} hours old)`
          : "malware definitions are missing",
      details: {
        databaseStatus: malwareScan.databaseStatus,
        databaseUpdatedAt: malwareScan.databaseUpdatedAt,
        databaseAgeHours: malwareScan.databaseAgeHours,
        databaseSource: malwareScan.databaseSource
      }
    });
  }

  for (const warning of malwareScan.healthWarnings ?? []) {
    reasons.push({
      code: "malware-scan-health-warning",
      severity: "warning",
      message: warning,
      details: {
        engine: malwareScan.engine,
        databaseStatus: malwareScan.databaseStatus
      }
    });
  }

  return {
    documentId: args.documentId,
    filename: args.filename,
    declaredMimeType: args.declaredMimeType,
    sniffedMimeType,
    mimeMismatch,
    archive,
    malwareScan,
    decision: reasons.some((reason) => reason.severity === "error") ? "quarantined" : "accepted",
    reasons
  };
}

export function assertAcceptedQuarantine(artifact: QuarantineArtifact, artifactUri?: string): void {
  if (artifact.decision === "accepted") {
    return;
  }

  const summary = artifact.reasons
    .filter((reason) => reason.severity === "error")
    .map((reason) => reason.message)
    .join("; ");
  throw new DocumentStageError(`quarantined: ${summary}`, {
    artifactUri,
    stats: buildQuarantineStats(artifact)
  });
}

export function buildQuarantineStats(artifact: QuarantineArtifact): Record<string, unknown> {
  return {
    decision: artifact.decision,
    declaredMimeType: artifact.declaredMimeType,
    sniffedMimeType: artifact.sniffedMimeType,
    mimeMismatch: artifact.mimeMismatch,
    reasonCodes: artifact.reasons.map((reason) => reason.code),
    archiveEntryCount: artifact.archive?.entryCount ?? null,
    archiveExpandedBytes: artifact.archive?.totalUncompressedBytes ?? null,
    archiveCompressionRatio: artifact.archive?.compressionRatio ?? null,
    malwareStatus: artifact.malwareScan.status,
    malwareEngine: artifact.malwareScan.engine,
    malwareSignature: artifact.malwareScan.signature,
    malwareDatabaseStatus: artifact.malwareScan.databaseStatus,
    malwareDatabaseUpdatedAt: artifact.malwareScan.databaseUpdatedAt,
    malwareDatabaseAgeHours: artifact.malwareScan.databaseAgeHours
  };
}

export function sniffMimeType(bytes: Buffer, filename: string): string | null {
  if (bytes.length === 0) {
    return null;
  }

  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) || hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06]) || hasPrefix(bytes, [0x50, 0x4b, 0x07, 0x08])) {
    return inferZipMimeType(bytes, filename);
  }
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (hasPrefix(bytes, [0x49, 0x49, 0x2a, 0x00]) || hasPrefix(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return "image/tiff";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") {
    return "audio/wav";
  }
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii").trim().toLowerCase();
    if (brand.startsWith("mp4") || brand.startsWith("isom") || brand.startsWith("m4a")) {
      return brand.startsWith("m4a") ? "audio/mp4" : "video/mp4";
    }
  }
  if (hasPrefix(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    const lowered = path.extname(filename).toLowerCase();
    return lowered === ".weba" ? "audio/webm" : "video/webm";
  }
  if (bytes.subarray(0, 3).toString("ascii") === "ID3" || isLikelyMp3Frame(bytes)) {
    return "audio/mpeg";
  }
  if (hasPrefix(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return inferLegacyOfficeMimeType(filename);
  }

  if (looksLikeUtf8Text(bytes)) {
    const text = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("utf8").trimStart();
    if (text.startsWith("{\\rtf")) {
      return "application/rtf";
    }
    if (text.startsWith("{") || text.startsWith("[")) {
      return "application/json";
    }
    if (/^<!doctype html|^<html|^<body|^<head/i.test(text)) {
      return "text/html";
    }
    if (looksLikeDelimitedText(text, "\t")) {
      return "text/tab-separated-values";
    }
    if (looksLikeDelimitedText(text, ",")) {
      return "text/csv";
    }
    return "text/plain";
  }

  return null;
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

function describeArchiveIssue(issue: string, archive: ArchiveInspection): string {
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

function inferZipMimeType(bytes: Buffer, filename: string): string {
  const entries = parseZipEntries(bytes);
  if (entries) {
    const names = new Set(entries.map((entry) => entry.name));
    if ([...names].some((name) => name.startsWith("word/"))) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if ([...names].some((name) => name.startsWith("xl/"))) {
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
    if ([...names].some((name) => name.startsWith("ppt/"))) {
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }
    if (path.extname(filename).toLowerCase() === ".epub" || names.has("mimetype")) {
      return "application/epub+zip";
    }
  }

  return "application/zip";
}

function inferLegacyOfficeMimeType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case ".doc":
      return "application/msword";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    default:
      return "application/x-ole-storage";
  }
}

function isUnsafeMimeMismatch(declaredMimeType: string, sniffedMimeType: string | null): boolean {
  if (!sniffedMimeType) {
    return false;
  }

  const declared = normalizeMimeType(declaredMimeType);
  const sniffed = normalizeMimeType(sniffedMimeType);
  if (declared === sniffed) {
    return false;
  }

  const compatibleGroups = [
    new Set(["text/plain", "text/markdown", "text/html", "application/json", "application/x-ndjson", "text/csv", "text/tab-separated-values", "application/x-latex", "text/x-tex", "application/rtf"]),
    new Set(["audio/webm", "video/webm"]),
    new Set(["application/msword", "application/x-ole-storage"]),
    new Set(["application/vnd.ms-excel", "application/x-ole-storage"]),
    new Set(["application/vnd.ms-powerpoint", "application/x-ole-storage"])
  ];

  return !compatibleGroups.some((group) => group.has(declared) && group.has(sniffed));
}

function normalizeMimeType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? value.toLowerCase();
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

function isLikelyMp3Frame(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

function looksLikeUtf8Text(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let printable = 0;
  let zeroBytes = 0;

  for (const byte of sample) {
    if (byte === 0) {
      zeroBytes += 1;
      continue;
    }
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)) {
      printable += 1;
    }
  }

  return zeroBytes === 0 && printable / Math.max(1, sample.length) > 0.75;
}

function looksLikeDelimitedText(text: string, delimiter: string): boolean {
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 5);
  if (lines.length < 2) {
    return false;
  }

  const counts = lines.map((line) => line.split(delimiter).length);
  return counts.every((count) => count > 1) && new Set(counts).size === 1;
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
