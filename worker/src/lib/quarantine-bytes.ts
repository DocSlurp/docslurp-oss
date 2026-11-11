import path from "node:path";

import { sniffFileBytes, type SniffedBytes } from "@docslurp/shared";

import { CLAM_SCAN_LIMITS } from "../tools/clam-limits.js";
import { inspectNestedArchives, parseZip } from "./archive-nesting.js";
import type { ArchiveInspection, QuarantinePolicy } from "./quarantine.js";

/*
 * Byte inspection for quarantine: MIME sniffing, the file facts and ZIP central-directory checks. They read hostile bytes,
 * so production runs them in the parser VM (scripts/quarantine-inspect.mjs, through the runner); elsewhere in-process.
 */


/** What quarantine reads from the bytes: the sniff (shared sniffFileBytes) and the ZIP inspection. Facts follow from the sniff. */
export interface QuarantineInspection {
  sniffed: SniffedBytes;
  archive: ArchiveInspection | null;
  /** PDFs (by libclamav's own test): whether an /Encrypt name appears, which sends the file to the in-VM decryption check. */
  pdf: { encryptName: boolean } | null;
}

export function inspectQuarantineBytes(bytes: Buffer, filename: string, policy: QuarantinePolicy): QuarantineInspection {
  const encryptName = pdfHasEncryptName(bytes);
  return { sniffed: sniffFileBytes(bytes, filename), archive: inspectArchive(bytes, filename, policy), pdf: encryptName === null ? null : { encryptName } };
}

export function sniffMimeType(bytes: Buffer, filename: string): string | null {
  return sniffFileBytes(bytes, filename).mimeType;
}

/** An OOXML chart part by its entry name (DOCX `word/`, PPTX `ppt/`, XLSX `xl/`). Names only: no part is read. */
const OFFICE_CHART_PART = /^(?:word|ppt|xl)\/charts\/chart\d+\.xml$/;

export function inspectArchive(bytes: Buffer, filename: string, policy: QuarantinePolicy): ArchiveInspection | null {
  if (!isZipBytes(bytes)) {
    return null;
  }

  const zip = parseZip(bytes);
  if ("error" in zip) {
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
      issues: ["archive-inspection-failed"],
      chartParts: 0
    };
  }
  const parsed = zip.entries;

  const entryCount = parsed.length;
  const totalCompressedBytes = parsed.reduce((sum, entry) => sum + entry.compressedSize, 0);
  const totalUncompressedBytes = parsed.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  const maxEntryUncompressedBytes = parsed.reduce((max, entry) => Math.max(max, entry.uncompressedSize), 0);
  const maxPathDepth = parsed.reduce((max, entry) => Math.max(max, entry.name.split("/").filter(Boolean).length), 0);
  const compressionRatio =
    totalCompressedBytes > 0 ? Number((totalUncompressedBytes / totalCompressedBytes).toFixed(2)) : null;
  const issues: string[] = [];
  const names = new Set<string>();
  let chartParts = 0;
  for (const entry of parsed) {
    const normalized = entry.name.replace(/\\/g, "/");
    if (OFFICE_CHART_PART.test(normalized)) chartParts += 1;
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

  // Only an archive that passed its own checks is opened: every member read whole, every nested container walked
  // (archive-nesting.ts), up to ClamAV's recursion limit.
  const nesting = issues.length === 0
    ? inspectNestedArchives(bytes, parsed, {
        maxDepth: CLAM_SCAN_LIMITS.maxRecursion,
        maxEntryBytes: policy.quarantineMaxSingleEntryBytes,
        maxTotalBytes: policy.quarantineMaxTotalUncompressedBytes,
        maxEntriesPerArchive: policy.quarantineMaxArchiveEntries,
        maxObjects: CLAM_SCAN_LIMITS.maxFiles,
      })
    : { issues: [], nestedContainers: 0, maxNestingDepth: 1 };
  issues.push(...nesting.issues);

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
    issues: [...new Set(issues)],
    chartParts,
    nestedContainers: nesting.nestedContainers,
    maxNestingDepth: nesting.maxNestingDepth
  };
}

export function describeArchiveIssue(issue: string, archive: ArchiveInspection): string {
  switch (issue) {
    case "archive-unsafe-path": return "archive contains a path outside its extraction directory";
    case "archive-duplicate-path": return "archive contains ambiguous duplicate paths";
    case "archive-special-file": return "archive contains a link or special filesystem entry";
    case "archive-encrypted-entry": return "encrypted archive entries cannot be scanned safely";
    case "archive-entry-size-mismatch": return "an archive entry's size does not match its headers";
    case "archive-entry-corrupt": return "an archive entry is corrupt and cannot be read";
    case "archive-compression-unsupported": return "an archive entry uses a compression method that cannot be inspected";
    case "archive-nested-zip64": return "a nested archive uses ZIP64, which the malware scanner skips";
    case "archive-nested-entry-size-limit": return "a nested archive entry exceeds the entry size limit";
    case "archive-nested-entry-count-limit": return "a nested archive has too many entries";
    case "archive-nested-encrypted-entry": return "a nested archive has encrypted entries, which cannot be scanned";
    case "archive-nested-unsupported-format": return "a nested archive is in a format the malware scanner cannot open (such as RAR)";
    case "archive-nested-uninspectable": return "a nested archive is in a format that cannot be inspected (such as 7z or tar)";
    case "archive-nested-depth-limit": return "archives are nested deeper than the malware scanner's recursion limit";
    case "archive-nested-inspection-failed": return "a nested archive could not be inspected safely";
    case "archive-nested-expanded-bytes-limit": return "nested archives expand past the total size limit";
    case "archive-nested-object-count-limit": return "nested archives hold more objects than the malware scanner's file limit";
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

/**
 * Whether a PDF names an encryption dictionary: an `/Encrypt` name token anywhere in the bytes, `#xx` escapes decoded (a
 * name may spell itself `/Encr#79pt`). libclamav treats a file as a PDF when `%PDF-` is in its first 1024 bytes, so that
 * is the test here too, whatever the sniff said. A literal `/Encrypt` elsewhere (in a string or an unused object) also
 * counts: the decryption check that follows (runner.pdfEncryptionPlan) then decides, and refuses what it cannot settle.
 */
/** Bytes that end a PDF name: whitespace, controls and the delimiters. */
const PDF_NAME_END = (() => {
  const table = new Uint8Array(256);
  for (let byte = 0; byte <= 0x20; byte += 1) table[byte] = 1;
  table[0x7f] = 1;
  for (const char of "()<>[]{}/%") table[char.charCodeAt(0)] = 1;
  return table;
})();

export function pdfHasEncryptName(bytes: Buffer): boolean | null {
  const head = bytes.subarray(0, 1024);
  if (head.indexOf("%PDF-", 0, "latin1") < 0) return null;
  for (let slash = bytes.indexOf(0x2f); slash >= 0; slash = bytes.indexOf(0x2f, slash + 1)) {
    let name = "";
    for (let index = slash + 1; index < bytes.length && name.length <= 8; index += 1) {
      const byte = bytes[index]!;
      if (PDF_NAME_END[byte]) break;
      if (byte === 0x23 && index + 2 < bytes.length) {
        const hex = bytes.subarray(index + 1, index + 3).toString("latin1");
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          name += String.fromCharCode(parseInt(hex, 16));
          index += 2;
          continue;
        }
      }
      name += String.fromCharCode(byte);
    }
    if (name === "Encrypt") return true;
  }
  return false;
}
