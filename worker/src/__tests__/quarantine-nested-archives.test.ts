import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateRawSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { classifyContainer, readCompoundFileStreams } from "../lib/archive-nesting.js";
import { inspectArchive, scanDocumentForQuarantine } from "../lib/quarantine.js";
import { inspectQuarantineBytes, pdfHasEncryptName } from "../lib/quarantine-bytes.js";
import { crc32 } from "../tools/clamd-policy.js";
import type { MalwareScanResult, PdfDecryptOutcome } from "../tools/runner.js";

/**
 * Owner decision on PR #339 (nested archive gaps): libclamav 1.4.3 skips a ZIP64 member, truncates a member over
 * MaxFileSize without an alert, and has no RAR engine. The in-VM archive inspection walks every container nested in an
 * accepted ZIP up to ClamAV's recursion limit and refuses those cases (and any nested format it cannot inspect) by a typed
 * reason. Fixtures are built here; the RAR is the committed benign RAR5 fixture.
 */
const policy = {
  quarantineFailOpenOnToolMissing: false,
  quarantineMaxArchiveEntries: 2_000,
  quarantineMaxArchiveDepth: 12,
  quarantineMaxTotalUncompressedBytes: 512 * 1024 * 1024,
  quarantineMaxSingleEntryBytes: 128 * 1024 * 1024,
  quarantineMaxExpansionRatio: 250,
} as const;
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../../testdata/clam-encrypted/${name}`, import.meta.url)));
const DOC_XML = Buffer.from("<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body/></w:document>");

type Member = { name: string; data: Buffer; method?: 0 | 8; flags?: number; claimUncompressed?: number; zip64Local?: boolean };

/** A ZIP built entry by entry (Stored or Deflate), with optional lying sizes, flags or a ZIP64 local header. */
function zip(members: Member[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const method = member.method ?? 8;
    const name = Buffer.from(member.name);
    const body = method === 8 ? deflateRawSync(member.data) : member.data;
    const uncompressed = member.claimUncompressed ?? member.data.length;
    const extra = member.zip64Local ? Buffer.alloc(20) : Buffer.alloc(0);
    if (member.zip64Local) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(uncompressed), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(member.zip64Local ? 45 : 20, 4);
    local.writeUInt16LE(member.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(member.data), 14);
    local.writeUInt32LE(member.zip64Local ? 0xffffffff : body.length, 18);
    local.writeUInt32LE(member.zip64Local ? 0xffffffff : uncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(member.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(member.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(uncompressed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, extra, body);
    centrals.push(central, name);
    offset += local.length + name.length + extra.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A DOCX-shaped ZIP with `embedded` stored under word/embeddings/. */
const docxWith = (embedded: Buffer, name = "word/embeddings/object1.bin") => zip([{ name: "word/document.xml", data: DOC_XML }, { name, data: embedded }]);

/**
 * A version-3 OLE2 compound file with regular-sector streams only (each padded to the 4096-byte mini-stream cutoff):
 * sector 0 is the FAT, sector 1 the directory, then each stream's sectors in order.
 */
function compoundFile(streams: Array<{ name: string; data: Buffer }>): Buffer {
  const sector = 512;
  const padded = streams.map((stream) => ({ name: stream.name, data: stream.data.length >= 4096 ? stream.data : Buffer.concat([stream.data, Buffer.alloc(4096 - stream.data.length)]) }));
  const fat: number[] = [0xfffffffd, 0xfffffffe];
  const starts: number[] = [];
  for (const stream of padded) {
    const count = Math.ceil(stream.data.length / sector);
    starts.push(fat.length);
    for (let index = 0; index < count; index += 1) fat.push(index === count - 1 ? 0xfffffffe : fat.length + 1);
  }
  if (fat.length > 128 || padded.length > 3) throw new Error("test compound file too large");
  const header = Buffer.alloc(sector, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(1, 0x2c);
  header.writeUInt32LE(1, 0x30);
  header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(0xfffffffe, 0x3c);
  header.writeUInt32LE(0xfffffffe, 0x44);
  for (let index = 0; index < 109; index += 1) header.writeUInt32LE(index === 0 ? 0 : 0xffffffff, 0x4c + index * 4);
  const fatSector = Buffer.alloc(sector, 0xff);
  fat.forEach((value, index) => fatSector.writeUInt32LE(value, index * 4));
  const directory = Buffer.alloc(sector, 0);
  const entry = (slot: number, name: string, type: number, start: number, size: number) => {
    const base = slot * 128;
    const encoded = Buffer.from(`${name}\0`, "utf16le");
    encoded.copy(directory, base);
    directory.writeUInt16LE(encoded.length, base + 0x40);
    directory[base + 0x42] = type;
    directory.writeUInt32LE(0xffffffff, base + 0x44);
    directory.writeUInt32LE(0xffffffff, base + 0x48);
    directory.writeUInt32LE(slot === 0 && padded.length ? 1 : 0xffffffff, base + 0x4c);
    directory.writeUInt32LE(start, base + 0x74);
    directory.writeUInt32LE(size, base + 0x78);
  };
  entry(0, "Root Entry", 5, 0xfffffffe, 0);
  padded.forEach((stream, index) => entry(index + 1, stream.name, 2, starts[index]!, stream.data.length));
  const body = padded.map((stream) => Buffer.concat([stream.data, Buffer.alloc((sector - (stream.data.length % sector)) % sector)]));
  return Buffer.concat([header, fatSector, directory, ...body]);
}

/** An `\x01Ole10Native` Package stream around `file` (MS-OLEDS: size, flags, label, path, reserved, temp path, data). */
function ole10Native(file: Buffer): Buffer {
  const label = Buffer.from("payload.bin\0", "latin1");
  const temp = Buffer.from("C:\\Temp\\payload.bin\0", "latin1");
  const parts = [Buffer.from([2, 0]), label, label, Buffer.from([0, 0, 3, 0])];
  const tempLength = Buffer.alloc(4);
  tempLength.writeUInt32LE(temp.length);
  const dataLength = Buffer.alloc(4);
  dataLength.writeUInt32LE(file.length);
  const native = Buffer.concat([...parts, tempLength, temp, dataLength, file]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(native.length);
  return Buffer.concat([size, native]);
}

const issuesOf = (bytes: Buffer, override: Partial<typeof policy> = {}) => inspectArchive(bytes, "quarterly.docx", { ...policy, ...override })?.issues ?? [];

describe("nested archive walk: refused cases (owner decision, PR #339)", () => {
  it("a ZIP64 member nested in a plain ZIP: archive-nested-zip64", () => {
    const inner = zip([{ name: "eicar.txt", data: Buffer.from("benign note"), method: 0, zip64Local: true }]);
    expect(issuesOf(docxWith(inner))).toEqual(["archive-nested-zip64"]);
  });

  it("the same ZIP64 ZIP three levels down: archive-nested-zip64", () => {
    const inner = zip([{ name: "note.txt", data: Buffer.from("benign note"), method: 0, zip64Local: true }]);
    const nested = zip([{ name: "b.zip", data: zip([{ name: "a.zip", data: inner }]) }]);
    expect(issuesOf(docxWith(nested))).toEqual(["archive-nested-zip64"]);
  });

  it("a nested member over the 128 MiB entry limit (as its headers declare it): archive-nested-entry-size-limit", () => {
    const inner = zip([{ name: "big.bin", data: Buffer.alloc(16), method: 0, claimUncompressed: 16 }]);
    // Patch the inner central and local sizes to claim 129 MiB for a 16-byte stored member.
    const claimed = zip([{ name: "big.bin", data: Buffer.alloc(16), method: 8, claimUncompressed: 129 * 1024 * 1024 }]);
    expect(issuesOf(docxWith(inner))).toEqual([]);
    expect(issuesOf(docxWith(claimed))).toEqual(["archive-nested-entry-size-limit"]);
  });

  it("a nested member that inflates past what its headers declare: archive-entry-size-mismatch (the real size is checked)", () => {
    const lying = zip([{ name: "zeros.bin", data: Buffer.alloc(4 * 1024 * 1024), claimUncompressed: 1024 }]);
    expect(issuesOf(docxWith(lying))).toEqual(["archive-entry-size-mismatch"]);
  });

  it("a nested member over the limit after gzip: archive-nested-entry-size-limit", () => {
    const gz = gzipSync(Buffer.alloc(3 * 1024 * 1024));
    expect(issuesOf(docxWith(gz, "word/media/image1.emz"), { quarantineMaxSingleEntryBytes: 1024 * 1024 })).toEqual(["archive-nested-entry-size-limit"]);
  });

  it.each(["rar5-password.rar", "rar5-encrypted-headers.rar"])("a nested RAR (%s): archive-nested-unsupported-format", (name) => {
    expect(issuesOf(docxWith(fixture(name)))).toEqual(["archive-nested-unsupported-format"]);
    expect(issuesOf(docxWith(zip([{ name: "inner.rar", data: fixture(name) }])))).toEqual(["archive-nested-unsupported-format"]);
  });

  it.each([
    ["7z", fixture("7z-password.7z")],
    ["xz", Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 0])],
    ["bzip2", Buffer.from("BZh91AY&SY")],
    ["tar", Buffer.concat([Buffer.alloc(257), Buffer.from("ustar\0" + "00"), Buffer.alloc(247)])],
    ["cab", Buffer.from("MSCF\0\0\0\0rest")],
  ])("a nested %s, which this walk does not open: archive-nested-uninspectable", (_format, data) => {
    expect(issuesOf(docxWith(data))).toEqual(["archive-nested-uninspectable"]);
  });

  it.each([["zstd", [0x28, 0xb5, 0x2f, 0xfd, 0]], ["lz4", [0x04, 0x22, 0x4d, 0x18, 0]]] as const)("a nested %s: archive-nested-unsupported-format", (_format, magic) => {
    expect(issuesOf(docxWith(Buffer.from(magic)))).toEqual(["archive-nested-unsupported-format"]);
  });

  it("a RAR inside a gzip inside a ZIP: archive-nested-unsupported-format", () => {
    expect(issuesOf(docxWith(gzipSync(fixture("rar5-password.rar")), "word/media/image1.emz"))).toEqual(["archive-nested-unsupported-format"]);
  });

  it("a RAR in an OLE Package object (oleObject.bin \\x01Ole10Native): archive-nested-unsupported-format", () => {
    const ole = compoundFile([{ name: "\x01Ole10Native", data: ole10Native(fixture("rar5-password.rar")) }]);
    expect(readCompoundFileStreams(ole, 1 << 20)).toMatchObject({ streams: [{ name: "\x01Ole10Native" }] });
    expect(issuesOf(docxWith(ole, "word/embeddings/oleObject1.bin"))).toEqual(["archive-nested-unsupported-format"]);
  });

  it("a ZIP64 ZIP in an OLE stream: archive-nested-zip64", () => {
    const inner = zip([{ name: "note.txt", data: Buffer.from("benign note"), method: 0, zip64Local: true }]);
    const ole = compoundFile([{ name: "Package", data: Buffer.concat([inner, Buffer.alloc(0)]) }]);
    // Padding after the ZIP's end record makes it malformed rather than ZIP64: both are refused.
    expect(issuesOf(docxWith(ole, "word/embeddings/oleObject1.bin"))[0]).toMatch(/^archive-nested-(zip64|inspection-failed)$/);
  });

  it("an encrypted entry in a nested ZIP: archive-nested-encrypted-entry", () => {
    expect(issuesOf(docxWith(zip([{ name: "secret.txt", data: Buffer.from("x"), method: 0, flags: 1 }])))).toEqual(["archive-nested-encrypted-entry"]);
  });

  it("ZIPs nested past ClamAV's MaxRecursion (17): archive-nested-depth-limit", () => {
    let inner = zip([{ name: "note.txt", data: Buffer.from("benign note") }]);
    for (let level = 0; level < 18; level += 1) inner = zip([{ name: `level${level}.zip`, data: inner }]);
    expect(issuesOf(docxWith(inner))).toEqual(["archive-nested-depth-limit"]);
  });

  it("a malformed nested ZIP: archive-nested-inspection-failed", () => {
    const inner = zip([{ name: "note.txt", data: Buffer.from("benign note") }]);
    expect(issuesOf(docxWith(inner.subarray(0, inner.length - 3)))).toEqual(["archive-nested-inspection-failed"]);
  });

  it("a member compressed with a method this walk cannot read (BZip2, 12): archive-compression-unsupported", () => {
    const bytes = zip([{ name: "word/document.xml", data: DOC_XML, method: 0 }]);
    // Rewrite method 0 to 12 in both headers; sizes stay consistent.
    bytes.writeUInt16LE(12, 8);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt16LE(12, central + 10);
    expect(issuesOf(bytes)).toEqual(["archive-compression-unsupported"]);
  });

  it("nested archives that expand past the total limit: archive-nested-expanded-bytes-limit", () => {
    const inner = zip([{ name: "a.bin", data: Buffer.alloc(600 * 1024) }, { name: "b.bin", data: Buffer.alloc(600 * 1024) }]);
    expect(issuesOf(docxWith(inner), { quarantineMaxTotalUncompressedBytes: 1024 * 1024 })).toContain("archive-nested-expanded-bytes-limit");
  });
});

describe("nested archive walk: controls stay clean", () => {
  it("a DOCX with an embedded XLSX (a ZIP) and an EMZ (gzip of a non-archive) is walked and accepted", () => {
    const xlsx = zip([{ name: "xl/workbook.xml", data: Buffer.from("<workbook/>") }, { name: "xl/worksheets/sheet1.xml", data: Buffer.from("<worksheet/>") }]);
    const emz = gzipSync(Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.alloc(200)]));
    const docx = zip([{ name: "word/document.xml", data: DOC_XML }, { name: "word/embeddings/Microsoft_Excel_Worksheet.xlsx", data: xlsx }, { name: "word/media/image1.emz", data: emz }]);
    const inspection = inspectArchive(docx, "report.docx", policy);
    expect(inspection?.issues).toEqual([]);
    expect(inspection).toMatchObject({ nestedContainers: 2, maxNestingDepth: 2 });
  });

  it("an OLE object with a plain payload (a Package around a text file) is walked and accepted", () => {
    const ole = compoundFile([{ name: "\x01Ole10Native", data: ole10Native(Buffer.from("quarterly results")) }, { name: "\x01CompObj", data: Buffer.from("compobj") }]);
    const inspection = inspectArchive(docxWith(ole, "word/embeddings/oleObject1.bin"), "report.docx", policy);
    expect(inspection?.issues).toEqual([]);
    expect(inspection?.nestedContainers).toBe(1);
  });

  it("reads the committed encrypted OOXML (a real CFB) as a compound file", () => {
    const streams = readCompoundFileStreams(fixture("ooxml-encrypted.docx"), 1 << 24);
    expect("streams" in streams && streams.streams.map((stream) => stream.name)).toEqual(expect.arrayContaining(["EncryptedPackage"]));
  });

  it("classifies common non-archive members as leaves", () => {
    for (const leaf of [DOC_XML, Buffer.from("\x89PNG\r\n\x1a\n"), Buffer.from("%PDF-1.7"), Buffer.from([0xff, 0xd8, 0xff, 0xe0])]) expect(classifyContainer(leaf)).toBeNull();
  });

  it("a top-level ZIP that already fails its own checks is not opened (no nested walk)", () => {
    const inner = zip([{ name: "note.txt", data: Buffer.from("benign note"), method: 0, zip64Local: true }]);
    const bytes = zip([{ name: "../escape.xml", data: DOC_XML }, { name: "inner.zip", data: inner }]);
    expect(issuesOf(bytes)).toEqual(["archive-unsafe-path"]);
  });
});

describe("PDF /Encrypt detection (in the VM, by libclamav's PDF test)", () => {
  it.each([
    ["trailer reference", "%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<</Root 1 0 R/Encrypt 5 0 R>>", true],
    ["#-escaped name", "%PDF-1.7\ntrailer<</Encr#79pt 5 0 R>>", true],
    ["xref stream dictionary", "%PDF-1.7\n9 0 obj<</Type/XRef/Encrypt 5 0 R/Length 0>>stream\nendstream", true],
    ["longer name", "%PDF-1.7\n<</EncryptMetadata false>>", false],
    ["no encryption", "%PDF-1.7\ntrailer<</Root 1 0 R>>", false],
  ] as const)("%s → %s", (_label, text, expected) => {
    expect(pdfHasEncryptName(Buffer.from(text, "latin1"))).toBe(expected);
  });

  it("%PDF- anywhere in the first 1024 bytes counts; past them, or absent, the check does not apply", () => {
    expect(pdfHasEncryptName(Buffer.concat([Buffer.alloc(900, 0x20), Buffer.from("%PDF-1.4 trailer<</Encrypt 1 0 R>>")]))).toBe(true);
    expect(pdfHasEncryptName(Buffer.concat([Buffer.alloc(1100, 0x20), Buffer.from("%PDF-1.4 trailer<</Encrypt 1 0 R>>")]))).toBeNull();
    expect(inspectQuarantineBytes(Buffer.from("hello"), "a.txt", policy).pdf).toBeNull();
    expect(inspectQuarantineBytes(Buffer.from("%PDF-1.7\n<</Encrypt 1 0 R>>"), "a.pdf", policy).pdf).toEqual({ encryptName: true });
  });
});

describe("quarantine: an encrypted PDF's decrypted copy is scanned too (owner decision, PR #339)", () => {
  const scan = (status: MalwareScanResult["status"], signature: string | null = null): MalwareScanResult => ({
    engine: "clamscan", available: true, status, signature, stdout: "", stderr: "", exitCode: status === "clean" ? 0 : 1, databaseStatus: "fresh",
  } as MalwareScanResult);
  const run = async (bytes: string, outcome: PdfDecryptOutcome | null, original = scan("clean"), copy = scan("clean")) => {
    const calls: string[] = [];
    const runner = {
      scanForMalware: async (file: string) => {
        calls.push(`scan ${file.endsWith("decrypted.pdf") ? "copy" : "original"}`);
        return file.endsWith("decrypted.pdf") ? copy : original;
      },
      decryptPdfForScan: async (_source: string, dir: string) => {
        calls.push("decrypt");
        if (!outcome) throw new Error("not expected");
        return outcome.status === "decrypted" ? { ...outcome, path: `${dir}/decrypted.pdf` } : outcome;
      },
    };
    const artifact = await scanDocumentForQuarantine({
      documentId: "doc-1", filename: "report.pdf", declaredMimeType: "application/pdf", bytes: Buffer.from(bytes, "latin1"),
      tempFile: "/tmp/report.pdf", runner: runner as never, policy,
    });
    return { artifact, calls, codes: artifact.reasons.filter((reason) => reason.severity === "error").map((reason) => reason.code) };
  };
  const ENCRYPTED = "%PDF-1.7\ntrailer<</Root 1 0 R/Encrypt 5 0 R>>";

  it("an owner-password PDF whose plaintext copy is clean is accepted (permissions-restricted PDFs still upload)", async () => {
    const { artifact, calls, codes } = await run(ENCRYPTED, { status: "decrypted", path: "", bytes: 4495, ms: 40 });
    expect(calls).toEqual(["scan original", "decrypt", "scan copy"]);
    expect(codes).toEqual([]);
    expect(artifact.decision).toBe("accepted");
    expect(artifact.pdfDecryption).toMatchObject({ status: "decrypted", bytes: 4495, malwareScan: { status: "clean" } });
  });

  it("the plaintext copy infected (the hidden-stream case): refused as malware-detected", async () => {
    const { artifact, codes } = await run(ENCRYPTED, { status: "decrypted", path: "", bytes: 4495, ms: 40 }, scan("clean"), scan("infected", "Eicar-Test-Signature"));
    expect(codes).toEqual(["malware-detected"]);
    expect(artifact.reasons.find((reason) => reason.code === "malware-detected")?.details).toMatchObject({ scanned: "decrypted-copy" });
  });

  it.each([
    ["the copy hit a scan limit", scan("infected", "Heuristics.Limits.Exceeded.MaxScanSize"), "malware-scan-limit-exceeded"],
    ["the copy's scan errored", scan("error"), "malware-scan-error"],
  ] as const)("%s: refused (%s)", async (_label, copy, code) => {
    expect((await run(ENCRYPTED, { status: "decrypted", path: "", bytes: 1, ms: 1 }, scan("clean"), copy)).codes).toEqual([code]);
  });

  it("qpdf failed, timed out or hit its limits: refused as malware-scan-pdf-decrypt-failed, with qpdf's reason only in details", async () => {
    const { artifact, codes } = await run(ENCRYPTED, { status: "failed", reason: "qpdf could not settle the encryption (exit 2): WARNING: file is damaged", ms: 12 });
    expect(codes).toEqual(["malware-scan-pdf-decrypt-failed"]);
    const reason = artifact.reasons.find((item) => item.code === "malware-scan-pdf-decrypt-failed")!;
    expect(reason.message).not.toContain("qpdf");
    expect(reason.details).toMatchObject({ reason: expect.stringContaining("exit 2") });
  });

  it("a user password is required: refused as encrypted content even if the scanner did not flag it", async () => {
    expect((await run(ENCRYPTED, { status: "requires-password", ms: 5 })).codes).toEqual(["malware-scan-encrypted-content"]);
  });

  it("a PDF that does not name /Encrypt is never decrypted", async () => {
    const { calls, codes } = await run("%PDF-1.7\ntrailer<</Root 1 0 R>>", null);
    expect(calls).toEqual(["scan original"]);
    expect(codes).toEqual([]);
  });

  it("an original already refused by the scan is not decrypted (it is refused either way)", async () => {
    const { calls, codes } = await run(ENCRYPTED, null, scan("infected", "Eicar-Test-Signature"));
    expect(calls).toEqual(["scan original"]);
    expect(codes).toEqual(["malware-detected"]);
  });
});
