import { describe, expect, it } from "vitest";

import { buildQuarantineStats, inspectArchive, scanDocumentForQuarantine, sniffMimeType } from "../lib/quarantine.js";

function buildZipBuffer(entries: Array<{ name: string; compressedSize: number; uncompressedSize: number }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(entry.compressedSize, 18);
    localHeader.writeUInt32LE(entry.uncompressedSize, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const fileData = Buffer.alloc(entry.compressedSize, 0x20);
    localParts.push(localHeader, name, fileData);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(entry.compressedSize, 20);
    centralHeader.writeUInt32LE(entry.uncompressedSize, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + fileData.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

const basePolicy = {
  quarantineFailOpenOnToolMissing: true,
  quarantineMaxArchiveEntries: 5,
  quarantineMaxArchiveDepth: 3,
  quarantineMaxTotalUncompressedBytes: 10_000,
  quarantineMaxSingleEntryBytes: 5_000,
  quarantineMaxExpansionRatio: 10
} as const;

describe("sniffMimeType", () => {
  it("detects PDFs from magic bytes", () => {
    expect(sniffMimeType(Buffer.from("%PDF-1.7\nhello"), "sample.pdf")).toBe("application/pdf");
  });

  it("infers docx from zip container entries", () => {
    const zip = buildZipBuffer([{ name: "word/document.xml", compressedSize: 12, uncompressedSize: 64 }]);
    expect(sniffMimeType(zip, "sample.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });
});

describe("inspectArchive", () => {
  it.each(["../escape", "/absolute", "C:\\escape", "dir/../../escape", "dir\\..\\escape", "file:stream", "bad\u0000name"])("rejects unsafe archive path %s", (name) => {
    const zip = buildZipBuffer([{ name, compressedSize: 1, uncompressedSize: 1 }]);
    expect(inspectArchive(zip, "unsafe.zip", basePolicy)?.issues).toContain("archive-unsafe-path");
  });

  it("rejects symlinks and encrypted entries", () => {
    const zip = buildZipBuffer([{ name: "link", compressedSize: 1, uncompressedSize: 1 }]);
    const central = zip.readUInt32LE(zip.length - 6);
    zip.writeUInt32LE(0xa1ff0000, central + 38);
    zip.writeUInt16LE(1, central + 8);
    zip.writeUInt16LE(1, 6);
    expect(inspectArchive(zip, "unsafe.zip", basePolicy)?.issues).toEqual(expect.arrayContaining(["archive-special-file", "archive-encrypted-entry"]));
  });

  it("rejects local/central filename disagreement and truncated archives", () => {
    const zip = buildZipBuffer([{ name: "safe", compressedSize: 1, uncompressedSize: 1 }]);
    zip[30] = 0x78;
    expect(inspectArchive(zip, "unsafe.zip", basePolicy)?.inspectable).toBe(false);
    expect(inspectArchive(zip.subarray(0, -1), "unsafe.zip", basePolicy)?.inspectable).toBe(false);
  });

  it("rejects duplicate normalized paths and impossible expansion sizes", () => {
    const zip = buildZipBuffer([{ name: "dir/file", compressedSize: 0, uncompressedSize: 10 }, { name: "dir/./file", compressedSize: 1, uncompressedSize: 1 }]);
    expect(inspectArchive(zip, "unsafe.zip", basePolicy)?.issues).toEqual(expect.arrayContaining(["archive-duplicate-path", "archive-expansion-ratio-limit"]));
  });

  it("flags oversized archive expansion ratios", () => {
    const zip = buildZipBuffer([{ name: "word/document.xml", compressedSize: 1, uncompressedSize: 50_000 }]);
    expect(inspectArchive(zip, "sample.docx", basePolicy)?.issues).toContain("archive-expanded-bytes-limit");
    expect(inspectArchive(zip, "sample.docx", basePolicy)?.issues).toContain("archive-entry-size-limit");
    expect(inspectArchive(zip, "sample.docx", basePolicy)?.issues).toContain("archive-expansion-ratio-limit");
  });
});

describe("scanDocumentForQuarantine", () => {
  it("accepts a clean PDF when scanner is unavailable but fail-open is enabled", async () => {
    const artifact = await scanDocumentForQuarantine({
      documentId: "doc-1",
      filename: "sample.pdf",
      declaredMimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7\nhello"),
      tempFile: "/tmp/sample.pdf",
      runner: {
        scanForMalware: async () => ({
          engine: null,
          available: false,
          status: "skipped-unavailable",
          signature: null,
          stdout: "",
          stderr: "",
          exitCode: null
        })
      } as any,
      policy: basePolicy
    });

    expect(artifact.decision).toBe("accepted");
    expect(artifact.reasons).toEqual([
      expect.objectContaining({
        code: "malware-scan-unavailable",
        severity: "warning"
      })
    ]);
  });

  it("quarantines unsafe MIME mismatches", async () => {
    const zip = buildZipBuffer([{ name: "word/document.xml", compressedSize: 12, uncompressedSize: 64 }]);
    const artifact = await scanDocumentForQuarantine({
      documentId: "doc-1",
      filename: "sample.pdf",
      declaredMimeType: "application/pdf",
      bytes: zip,
      tempFile: "/tmp/sample.pdf",
      runner: {
        scanForMalware: async () => ({
          engine: null,
          available: false,
          status: "skipped-unavailable",
          signature: null,
          stdout: "",
          stderr: "",
          exitCode: null
        })
      } as any,
      policy: basePolicy
    });

    expect(artifact.decision).toBe("quarantined");
    expect(artifact.reasons.map((reason) => reason.code)).toContain("mime-mismatch");
  });

  it("accepts JSON Lines declared as application/x-ndjson", async () => {
    const artifact = await scanDocumentForQuarantine({
      documentId: "doc-1",
      filename: "events.jsonl",
      declaredMimeType: "application/x-ndjson",
      bytes: Buffer.from('{"id":1}\n{"id":2}\n'),
      tempFile: "/tmp/events.jsonl",
      runner: {
        scanForMalware: async () => ({
          engine: null,
          available: false,
          status: "skipped-unavailable",
          signature: null,
          stdout: "",
          stderr: "",
          exitCode: null
        })
      } as any,
      policy: basePolicy
    });

    expect(artifact.reasons.map((reason) => reason.code)).not.toContain("mime-mismatch");
  });

  it("quarantines archive bombs before normalization", async () => {
    const zip = buildZipBuffer([{ name: "word/document.xml", compressedSize: 1, uncompressedSize: 50_000 }]);
    const artifact = await scanDocumentForQuarantine({
      documentId: "doc-1",
      filename: "sample.docx",
      declaredMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: zip,
      tempFile: "/tmp/sample.docx",
      runner: {
        scanForMalware: async () => ({
          engine: "clamscan",
          available: true,
          status: "clean",
          signature: null,
          stdout: "",
          stderr: "",
          exitCode: 0
        })
      } as any,
      policy: basePolicy
    });

    expect(artifact.decision).toBe("quarantined");
    expect(artifact.reasons.map((reason) => reason.code)).toContain("archive-expanded-bytes-limit");
  });

  it("quarantines when the scanner is unavailable in fail-closed mode", async () => {
    const artifact = await scanDocumentForQuarantine({
      documentId: "doc-1",
      filename: "sample.pdf",
      declaredMimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7\nhello"),
      tempFile: "/tmp/sample.pdf",
      runner: {
        scanForMalware: async () => ({
          engine: null,
          available: false,
          status: "skipped-unavailable",
          signature: null,
          stdout: "",
          stderr: "",
          exitCode: null
        })
      } as any,
      policy: {
        ...basePolicy,
        quarantineFailOpenOnToolMissing: false
      }
    });

    expect(artifact.decision).toBe("quarantined");
    expect(buildQuarantineStats(artifact)).toEqual(
      expect.objectContaining({
        decision: "quarantined",
        malwareStatus: "skipped-unavailable"
      })
    );
  });

  it("quarantines malware-positive files with an explicit signature", async () => {
    const artifact = await scanDocumentForQuarantine({
      documentId: "doc-1",
      filename: "sample.pdf",
      declaredMimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7\nhello"),
      tempFile: "/tmp/sample.pdf",
      runner: {
        scanForMalware: async () => ({
          engine: "clamscan",
          available: true,
          status: "infected",
          signature: "Win.Test.EICAR_HDB-1",
          stdout: "",
          stderr: "",
          exitCode: 1
        })
      } as any,
      policy: basePolicy
    });

    expect(artifact.decision).toBe("quarantined");
    expect(artifact.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "malware-detected",
          message: expect.stringContaining("Win.Test.EICAR_HDB-1")
        })
      ])
    );
  });
});
