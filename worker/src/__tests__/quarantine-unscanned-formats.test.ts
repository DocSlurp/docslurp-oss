import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fileFactsFromSniff, isSupportedFileType, sniffFileBytes } from "@docslurp/shared";
import { unsupportedSourceReason } from "../extractors/registry.js";
import { inspectArchive } from "../lib/quarantine.js";
import { crc32 } from "../tools/clamd-policy.js";

/**
 * Council re-check 2: the hostile-matrix cases ClamAV reports clean although they are encrypted
 * (clam-hostile-matrix.docker.test.ts). Each is a documented decision only because DocSlurp refuses the format before any
 * extractor reads it; these tests hold that, on the committed fixtures.
 */
const fixture = (name: string) => fileURLToPath(new URL(`../../testdata/clam-encrypted/${name}`, import.meta.url));
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("encrypted formats ClamAV cannot read are refused before extraction", () => {
  it.each(["rar5-password.rar", "rar5-encrypted-headers.rar"])("%s: RAR is not an accepted upload type, and RAR bytes under an accepted type are a MIME mismatch (quarantine error)", (name) => {
    // The image's ClamAV has no RAR engine (libclamunrar is not installed): RAR content is never scanned.
    expect(isSupportedFileType("application/vnd.rar", name)).toBe(false);
    expect(isSupportedFileType("application/x-rar-compressed", name)).toBe(false);
    const bytes = readFileSync(fixture(name));
    for (const [filename, declared] of [["report.pdf", "application/pdf"], ["report.docx", DOCX], ["notes.txt", "text/plain"], ["photo.png", "image/png"]] as const) {
      const facts = fileFactsFromSniff(sniffFileBytes(bytes, filename), { filename, declaredMimeType: declared });
      // quarantine.ts refuses an "unresolved" mismatch as mime-mismatch (severity error), whatever the scan says.
      expect(facts.sniffedMimeType, `${name} as ${declared}`).toBe("application/vnd.rar");
      expect(facts.mismatch, `${name} as ${declared}`).toBe("unresolved");
    }
  });

  it.each([
    ["ooxml-encrypted.docx", "office-word", DOCX, "quarterly.docx"],
    ["ooxml-encrypted.xlsx", "office-excel", XLSX, "revenue.xlsx"],
  ] as const)("%s: a password-protected Office file (CFB EncryptedPackage) is refused by extraction", async (name, format, mimeType, filename) => {
    expect(await unsupportedSourceReason(fixture(name), { format, mimeType, filename })).toMatch(/encrypted or password-protected Office file/);
  });
});

/**
 * A one-entry stored ZIP whose local header defers its sizes to a ZIP64 extra field (0xFFFFFFFF), as zipfile's
 * force_zip64 and streaming writers produce. libclamav 1.4.3 does not follow it and skips the member: an EICAR in it scans
 * OK (clam-hostile-matrix.docker.test.ts). `centralZip64` puts the ZIP64 form in the central directory too.
 */
function zip64Member(name: string, data: Buffer, centralZip64: boolean): Buffer {
  const fileName = Buffer.from(name);
  const crc = crc32(data);
  const zip64Extra = Buffer.alloc(20);
  zip64Extra.writeUInt16LE(1, 0);
  zip64Extra.writeUInt16LE(16, 2);
  zip64Extra.writeBigUInt64LE(BigInt(data.length), 4);
  zip64Extra.writeBigUInt64LE(BigInt(data.length), 12);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(0xffffffff, 18);
  local.writeUInt32LE(0xffffffff, 22);
  local.writeUInt16LE(fileName.length, 26);
  local.writeUInt16LE(zip64Extra.length, 28);
  const centralExtra = centralZip64 ? zip64Extra : Buffer.alloc(0);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(45, 4);
  central.writeUInt16LE(45, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(centralZip64 ? 0xffffffff : data.length, 20);
  central.writeUInt32LE(centralZip64 ? 0xffffffff : data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt16LE(centralExtra.length, 30);
  const body = Buffer.concat([local, fileName, zip64Extra, data]);
  const directory = Buffer.concat([central, fileName, centralExtra]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end]);
}

describe("ZIP64 members, which ClamAV skips, are refused by the archive inspection (council re-check 2 matrix)", () => {
  const policy = {
    quarantineFailOpenOnToolMissing: false,
    quarantineMaxArchiveEntries: 10_000,
    quarantineMaxArchiveDepth: 12,
    quarantineMaxTotalUncompressedBytes: 1 << 30,
    quarantineMaxSingleEntryBytes: 1 << 30,
    quarantineMaxExpansionRatio: 1_000,
  } as const;
  const part = Buffer.from("<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"/>");

  it.each([["ZIP64 local header only", false], ["ZIP64 local and central", true]] as const)("%s: archive-inspection-failed (quarantine error)", (_label, centralZip64) => {
    const inspection = inspectArchive(zip64Member("word/document.xml", part, centralZip64), "quarterly.docx", policy);
    expect(inspection).toMatchObject({ inspectable: false, issues: ["archive-inspection-failed"] });
  });
});
