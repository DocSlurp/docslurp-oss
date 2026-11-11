import { inflateRawSync } from "node:zlib";

import { inspectArchive } from "../../lib/quarantine-bytes.js";
import { CHART_EXTRACT_LIMITS, ExtractLimitError } from "./limits.js";

/*
 * Bounded reader for OOXML / EPUB packages. The central directory is first checked by quarantine's `inspectArchive`
 * (entry count, path depth, declared sizes, expansion ratio, encrypted/special/duplicate/unsafe entries, ZIP64 and
 * local/central header mismatches); any issue refuses the whole package. Only the entries the caller asks for are then
 * inflated, each capped at its declared size with zlib's `maxOutputLength`, so a lying header cannot expand further.
 */

export interface ZipPackage {
  names: string[];
  read(name: string): Buffer;
  readText(name: string): string;
}

interface CdEntry { method: number; compressedSize: number; uncompressedSize: number; dataOffset: number }

export function openZipPackage(bytes: Uint8Array): ZipPackage {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length > CHART_EXTRACT_LIMITS.maxPackageBytes) throw new ExtractLimitError("package-too-large");
  const inspection = inspectArchive(buf, "package.zip", {
    quarantineFailOpenOnToolMissing: false,
    quarantineMaxArchiveEntries: CHART_EXTRACT_LIMITS.maxZipEntries,
    quarantineMaxArchiveDepth: CHART_EXTRACT_LIMITS.maxZipDepth,
    quarantineMaxTotalUncompressedBytes: CHART_EXTRACT_LIMITS.maxZipTotalBytes,
    quarantineMaxSingleEntryBytes: CHART_EXTRACT_LIMITS.maxZipEntryBytes,
    quarantineMaxExpansionRatio: CHART_EXTRACT_LIMITS.maxZipRatio,
  });
  if (!inspection) throw new ExtractLimitError("package-not-zip");
  if (!inspection.inspectable || inspection.suspicious) throw new ExtractLimitError(`package-${inspection.issues[0] ?? "uninspectable"}`);
  const entries = readCentralDirectory(buf);
  let inflatedTotal = 0;
  const read = (name: string): Buffer => {
    const e = entries.get(name);
    if (!e) throw new ExtractLimitError("package-missing-entry");
    const data = buf.subarray(e.dataOffset, e.dataOffset + e.compressedSize);
    let out: Buffer;
    if (e.method === 0) {
      if (e.compressedSize !== e.uncompressedSize) throw new ExtractLimitError("package-bad-stored-entry");
      out = Buffer.from(data);
    } else if (e.method === 8) {
      try {
        out = inflateRawSync(data, { maxOutputLength: Math.max(1, e.uncompressedSize) });
      } catch {
        throw new ExtractLimitError("package-inflate-failed");
      }
    } else {
      throw new ExtractLimitError("package-unsupported-compression");
    }
    if (out.length !== e.uncompressedSize) throw new ExtractLimitError("package-size-mismatch");
    inflatedTotal += out.length;
    if (inflatedTotal > CHART_EXTRACT_LIMITS.maxZipTotalBytes) throw new ExtractLimitError("package-inflated-total-limit");
    return out;
  };
  return {
    names: [...entries.keys()],
    read,
    readText: (name) => read(name).toString("utf8"),
  };
}

/** Central directory after `inspectArchive` accepted it (so offsets and sizes are already cross-checked). */
function readCentralDirectory(buf: Buffer): Map<string, CdEntry> {
  let eocd = -1;
  for (let o = buf.length - 22; o >= Math.max(0, buf.length - 65_557); o--) {
    if (buf.readUInt32LE(o) === 0x06054b50) { eocd = o; break; }
  }
  if (eocd < 0) throw new ExtractLimitError("package-no-directory");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, CdEntry>();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new ExtractLimitError("package-bad-directory");
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    const dataOffset = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (!name.endsWith("/")) out.set(name, { method, compressedSize, uncompressedSize, dataOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Resolve an OOXML relationship target against the part that owns the .rels file. */
export function resolvePartPath(fromPart: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // external (http:, file:, ...): never followed
  const base = target.startsWith("/") ? [] : fromPart.split("/").slice(0, -1);
  for (const seg of target.replace(/^\//, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!base.length) return null; base.pop(); } else base.push(seg);
  }
  return base.join("/");
}
