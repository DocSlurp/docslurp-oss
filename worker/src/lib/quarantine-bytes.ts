import path from "node:path";

import { sniffFileBytes, type SniffedBytes } from "@docslurp/shared/file-sniff";

import { CLAM_SCAN_LIMITS } from "../tools/clam-limits.js";
import { findEmbeddedContainer, inspectNestedArchives, parseZip } from "./archive-nesting.js";
import { pdfEncryptionStructure } from "./pdf-encryption-structure.js";
import type { ArchiveInspection, QuarantinePolicy } from "./quarantine.js";

/*
 * Byte inspection for quarantine: MIME sniffing, the file facts and ZIP central-directory checks. They read hostile bytes,
 * so production runs them in the parser VM (scripts/quarantine-inspect.mjs, through the runner); elsewhere in-process.
 */


/** What quarantine reads from the bytes: the sniff (shared sniffFileBytes) and the ZIP inspection. Facts follow from the sniff. */
export interface QuarantineInspection {
  sniffed: SniffedBytes;
  archive: ArchiveInspection | null;
  /**
   * PDFs (by libclamav's own test): whether an /Encrypt name appears, which sends the file to the in-VM decryption check,
   * and whether its readers could disagree on the encryption (pdf-encryption-structure.ts, council N-H1): refused.
   */
  pdf: { encryptName: boolean; encryptConflict: boolean } | null;
}

export function inspectQuarantineBytes(bytes: Buffer, filename: string, policy: QuarantinePolicy): QuarantineInspection {
  const encryptName = pdfHasEncryptName(bytes);
  const sniffed = sniffFileBytes(bytes, filename);
  const archive = inspectArchive(bytes, filename, policy)
    ?? (sniffed.container === null ? embeddedContainerInspection(bytes, embeddedDocumentAllowed(sniffed, encryptName !== null)) : null);
  return { sniffed, archive, pdf: encryptName === null ? null : { encryptName, encryptConflict: encryptName && pdfEncryptionStructure(bytes).conflict !== null } };
}

/**
 * A file that is not a ZIP or OLE2 container at offset 0 but holds one where a tolerant reader would find it (a ZIP end
 * record in its last 64 KiB, or a container's magic in its first few KB: archive-nesting.ts findEmbeddedContainer): a
 * PDF+ZIP polyglot or a self-extractor. Refused as `archive-embedded-container`; null when there is none. OLE2 files are
 * left to ClamAV's own OLE2 parser, since Office embeds packages (a DOCX inside a .doc) at offsets inside its streams.
 */
function embeddedContainerInspection(bytes: Buffer, documentAllowed = true): ArchiveInspection | null {
  if (!findEmbeddedContainer(bytes) && (documentAllowed || !findEmbeddedDocument(bytes))) return null;
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
    issues: ["archive-embedded-container"],
    chartParts: 0
  };
}

/**
 * Council N-L2: a binary file that is neither a PDF nor a container by its leading bytes (MPEG audio, AAC, QuickTime and
 * HEIC are accepted without a magic number: file-sniff.ts MAGIC_BOUND_MIMES; images and other media by theirs) must not
 * carry a PDF or an OLE2 compound file where a reader finds one. pdf.js and poppler open a PDF whatever precedes `%PDF-`,
 * and locate it from `startxref` at the end; ClamAV, typing the file by its first bytes, never parses it as a PDF. Text
 * files are exempt (a note may quote `%PDF-`), and so is a file the PDF check already covers.
 */
function embeddedDocumentAllowed(sniffed: SniffedBytes, pdfHeader: boolean): boolean {
  return pdfHeader || sniffed.encoding !== null || sniffed.mimeType === "application/pdf";
}

const PDF_HEADER = Buffer.from("%PDF-", "latin1");
const PDF_STARTXREF = Buffer.from("startxref", "latin1");
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const RAR_MAGIC = Buffer.from("Rar!\x1a\x07", "latin1");
/** ZIP compression methods a reader may open (APPNOTE 4.4.5): a local header with any other is not taken as one. */
const ZIP_METHODS = new Set([0, 1, 6, 8, 9, 12, 14, 18, 19, 93, 94, 95, 96, 97, 98, 99]);

/** Whether the four bytes at `offset` start a ZIP local header a streaming reader would extract (a plausible method and name). */
function plausibleZipLocalHeader(bytes: Buffer, offset: number): boolean {
  if (offset + 30 > bytes.length) return false;
  const nameLength = bytes.readUInt16LE(offset + 26);
  if (!ZIP_METHODS.has(bytes.readUInt16LE(offset + 8)) || (bytes[offset + 4]! > 63) || nameLength === 0 || nameLength > 1024 || offset + 30 + nameLength > bytes.length) return false;
  for (let index = offset + 30; index < offset + 30 + nameLength; index += 1) if (bytes[index]! < 0x20 || bytes[index] === 0x7f) return false;
  return true;
}

/**
 * Council N-L2 and R6-L3: a PDF, an OLE2 compound file, a ZIP or a RAR anywhere in a binary file that is none of these by
 * its leading bytes. pdf.js opens a PDF found anywhere (it rebuilds the cross-reference table from the objects), and
 * ClamAV, typing the file by its first bytes (an MP3 by its frames), never parses it as one; a PDF 71 KiB into an MP3
 * passed the old 64 KiB head window. So the whole object is searched, one linear pass per magic: `%PDF-` followed by a
 * version digit, `startxref`, the OLE2 header, a RAR signature, and a ZIP local header with a plausible method and name.
 * Bounded by the object's size (no parse); the magics are long enough that ordinary media do not carry them by chance
 * (3,290 local media files: none).
 */
export function findEmbeddedDocument(bytes: Buffer): { format: "pdf" | "ole2" | "zip" | "rar"; offset: number } | null {
  for (let pdf = bytes.indexOf(PDF_HEADER); pdf >= 0; pdf = bytes.indexOf(PDF_HEADER, pdf + 1)) {
    const version = bytes[pdf + PDF_HEADER.length];
    if (version !== undefined && version >= 0x30 && version <= 0x39) return { format: "pdf", offset: pdf };
  }
  const startxref = bytes.indexOf(PDF_STARTXREF);
  if (startxref >= 0) return { format: "pdf", offset: startxref };
  const ole = bytes.indexOf(OLE2_MAGIC, 1);
  if (ole > 0) return { format: "ole2", offset: ole };
  const rar = bytes.indexOf(RAR_MAGIC, 1);
  if (rar > 0) return { format: "rar", offset: rar };
  for (let zip = bytes.indexOf(ZIP_LOCAL_MAGIC, 1); zip > 0; zip = bytes.indexOf(ZIP_LOCAL_MAGIC, zip + 1)) {
    if (plausibleZipLocalHeader(bytes, zip)) return { format: "zip", offset: zip };
  }
  return null;
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
    if (zip.error === "hidden-entry") {
      return { kind: "zip", entryCount: 0, totalCompressedBytes: 0, totalUncompressedBytes: 0, maxEntryUncompressedBytes: 0, maxPathDepth: 0, compressionRatio: null, suspicious: true, inspectable: false, issues: ["archive-hidden-entry"], chartParts: 0 };
    }
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
    : { issues: [], notices: [], nestedContainers: 0, maxNestingDepth: 1 };
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
    ...(nesting.notices.length ? { notices: nesting.notices } : {}),
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
    case "archive-nested-encrypted-pdf": return "an encrypted PDF inside this file cannot be scanned for malware; remove its encryption and upload again";
    case "archive-nested-unsupported-format": return "a nested archive is in a format that cannot be inspected (such as RAR, 7z, bzip2 or xz)";
    case "archive-nested-uninspectable": return "a nested archive is in a format only the malware scanner opens (such as CAB)";
    case "archive-nested-depth-limit": return "archives are nested deeper than the malware scanner's recursion limit";
    case "archive-nested-inspection-failed": return "a nested archive could not be inspected safely";
    case "archive-nested-expanded-bytes-limit": return "nested archives expand past the total size limit";
    case "archive-nested-object-count-limit": return "nested archives hold more objects than the malware scanner's file limit";
    case "archive-nested-embedded-container": return "an archive member hides another archive or container behind leading bytes";
    case "archive-nested-ole-shared-sectors": return "an embedded Office (OLE2) file has streams that share or loop through the same sectors";
    case "archive-embedded-container": return "file holds an archive or container that does not start at its first byte (a polyglot or self-extractor)";
    case "archive-hidden-entry": return "archive holds an entry its central directory does not list";
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
