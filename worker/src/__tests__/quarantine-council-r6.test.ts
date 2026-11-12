import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { inspectArchive } from "../lib/quarantine-bytes.js";
import { inspectQuarantineBytes } from "../lib/quarantine-bytes.js";
import { applyParseSource, bindDocumentUpload, hasScannedParseCopy, originalSourceForQuarantine, PARSE_SOURCE_SCAN_VERSION, pdfBytesForParsing, resolveDocumentSource, type ParseSourceRow, type SourcedDocument } from "../lib/parse-source.js";
import { pdfEncryptionStructure } from "../lib/pdf-encryption-structure.js";
import { ParseSourceError, readSourceBytes, resetStagedSourcesForTests, SourceIntegrityError, sha256Bytes, stagedSourceSha256, stageSourceFile, verifyStagedSource } from "../sandbox/source-integrity.js";

/**
 * PR #339 council round 6 (adversarial re-check 3): R6-H1 (scan what we parse), R6-M1 (linearized encrypted PDFs), R6-M2
 * (tar shapes), R6-L1 (quadratic /XRef scan), R6-L2 (encrypted PDFs nested in Office) and R6-L3 (a PDF far into media).
 * The reviewer's reproducers are committed as testdata/clam-encrypted/r6-*.
 */
const fixtures = fileURLToPath(new URL("../../testdata/clam-encrypted/", import.meta.url));
const fixture = (name: string) => readFileSync(path.join(fixtures, name));
const policy = {
  quarantineFailOpenOnToolMissing: false,
  quarantineMaxArchiveEntries: 2_000,
  quarantineMaxArchiveDepth: 12,
  quarantineMaxTotalUncompressedBytes: 512 * 1024 * 1024,
  quarantineMaxSingleEntryBytes: 128 * 1024 * 1024,
  quarantineMaxExpansionRatio: 250,
} as const;

describe("R6-H1: every parser reads the scanned copy of an encrypted PDF (lib/parse-source.ts)", () => {
  const original = "a".repeat(64);
  const copy = "b".repeat(64);
  const row = { id: "d1", source_key: "u1/uploads/board-pack.pdf", source_sha256: original, parse_source_key: "u1/run/quarantine/d1.scanned.pdf", parse_source_sha256: copy, parse_source_scan_version: PARSE_SOURCE_SCAN_VERSION };
  const loaded = (source: ParseSourceRow) => {
    const document = { id: source.id, ...resolveDocumentSource(source) };
    bindDocumentUpload(document, source);
    return document;
  };

  it("the loader resolves the document to the scanned copy; the upload's key is reachable only through quarantine", () => {
    expect(resolveDocumentSource(row)).toEqual({ sourceKey: row.parse_source_key, sourceSha256: copy, originalSourceSha256: original, parseSourceDecision: "scanned-copy" });
    expect(resolveDocumentSource({ id: "d1", source_key: "k", source_sha256: original, parse_source_scan_version: PARSE_SOURCE_SCAN_VERSION })).toEqual({ sourceKey: "k", sourceSha256: original, parseSourceDecision: "original" });
    const document = loaded(row);
    expect(pdfBytesForParsing(document)).toEqual({ key: row.parse_source_key, sha256: copy });
    expect(originalSourceForQuarantine(document)).toEqual({ id: "d1", sourceKey: row.source_key, sourceSha256: original });
    expect(JSON.stringify(document)).not.toContain(row.source_key);
  });

  it("a half-recorded copy fails loudly instead of falling back to the original", () => {
    expect(() => resolveDocumentSource({ ...row, parse_source_sha256: null })).toThrow(/incomplete scanned parse copy/);
    expect(() => resolveDocumentSource({ ...row, parse_source_key: null })).toThrow(/incomplete scanned parse copy/);
    expect(() => resolveDocumentSource({ ...row, parse_source_sha256: "not-a-hash" })).toThrow(/incomplete scanned parse copy/);
    expect(() => resolveDocumentSource({ ...row, parse_source_scan_version: null })).toThrow(/incomplete scanned parse copy/);
  });

  it("applyParseSource points a document at its copy and back to the upload it scanned", () => {
    const document: SourcedDocument = { id: "d1", sourceKey: row.source_key, sourceSha256: original };
    applyParseSource(document, { key: row.parse_source_key, sha256: copy });
    expect(document).toEqual({ id: "d1", sourceKey: row.parse_source_key, sourceSha256: copy, originalSourceSha256: original, parseSourceDecision: "scanned-copy" });
    expect(hasScannedParseCopy(document)).toBe(true);
    // A retried quarantine re-points from the original, not from the copy.
    applyParseSource(document, { key: "u1/run/quarantine/d1.scanned.pdf", sha256: "c".repeat(64) });
    expect(originalSourceForQuarantine(document).sourceKey).toBe(row.source_key);
    applyParseSource(document, null);
    expect(document).toEqual({ id: "d1", sourceKey: row.source_key, sourceSha256: original, parseSourceDecision: "original" });
  });

  describe("staging: a reader that fetched the original of a document with a scanned copy is refused", () => {
    let dir: string;
    const originalBytes = Buffer.from("%PDF-1.7 encrypted original");
    const copyBytes = Buffer.from("%PDF-1.7 scanned copy");
    const document = loaded({ id: "d2", source_key: "u1/uploads/x.pdf", source_sha256: sha256Bytes(originalBytes), parse_source_key: "u1/run/quarantine/d2.scanned.pdf", parse_source_sha256: sha256Bytes(copyBytes), parse_source_scan_version: PARSE_SOURCE_SCAN_VERSION });
    const storage = (objects: Record<string, Buffer>) => ({
      downloadToTempFile: async (key: string) => {
        const file = path.join(dir, `${Math.random().toString(36).slice(2)}`, "f.pdf");
        await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(file), { recursive: true }));
        await writeFile(file, objects[key] ?? Buffer.alloc(0));
        return file;
      },
      getBytes: async (key: string) => objects[key] ?? Buffer.alloc(0),
    });
    beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), "r6-parse-source-")); resetStagedSourcesForTests(); });
    afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

    it("stageSourceFile and readSourceBytes read the copy by its key", async () => {
      const store = storage({ [document.sourceKey]: copyBytes, "u1/uploads/x.pdf": originalBytes });
      const staged = await stageSourceFile(store, document, "x");
      expect(await readFile(staged)).toEqual(copyBytes);
      expect(await readSourceBytes(store, document)).toEqual(copyBytes);
    });

    it("the original's bytes, however they were fetched, are refused with ParseSourceError, never parsed", async () => {
      const swapped = storage({ [document.sourceKey]: originalBytes });
      await expect(stageSourceFile(swapped, document, "x")).rejects.toBeInstanceOf(ParseSourceError);
      await expect(readSourceBytes(swapped, document)).rejects.toBeInstanceOf(ParseSourceError);
      expect(() => verifyStagedSource(document, sha256Bytes(originalBytes))).toThrow(ParseSourceError);
      // Any other bytes are an ordinary integrity failure.
      expect(() => verifyStagedSource(document, sha256Bytes(Buffer.from("other")))).toThrow(SourceIntegrityError);
      // The fleet source quarantine keys the document by its upload's hash, not the copy's (copies differ run to run).
      verifyStagedSource(document, sha256Bytes(copyBytes));
      expect(stagedSourceSha256(document.id)).toBe(sha256Bytes(originalBytes));
      // The quarantine stage's own view of the original verifies.
      expect(() => verifyStagedSource(originalSourceForQuarantine(document), sha256Bytes(originalBytes))).not.toThrow();
    });
  });

  it("tripwire: only the quarantine stage reads the upload; no other worker module names the original source", async () => {
    // A tripwire only (council R7-L2: a name built at runtime passes it). The runtime guards are the loader keeping the
    // upload's key off the document (parse-source-council-r7.test.ts) and hash-bound staging.
    const root = fileURLToPath(new URL("../", import.meta.url));
    const allowed: Record<string, RegExp> = {
      "lib/parse-source.ts": /originalSource|source_key/,
      "stages/quarantine.ts": /originalSourceForQuarantine/,
      // Log field names only.
      "sandbox/source-integrity.ts": /source_key/,
      // Raw document rows: the loader, cleanup, retention, exports (download original) and vector relocation metadata.
      "db/store.ts": /source_key/,
      "db/superseded-purge.ts": /source_key/,
      "exports/build-document-export.ts": /source_key/,
      "stages/lancedb-relocate.ts": /source_key/,
    };
    const offenders: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "__tests__" && entry.name !== "test") await walk(full); continue; }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        const relative = path.relative(root, full).split(path.sep).join("/");
        const text = await readFile(full, "utf8");
        if (/originalSourceKey|originalSourceForQuarantine|bindDocumentUpload|\bsource_key\b/.test(text) && !allowed[relative]) offenders.push(relative);
      }
    };
    await walk(root);
    expect(offenders).toEqual([]);
  });
});

describe("R6-M1: ordinary linearized encrypted PDFs are accepted", () => {
  it.each(["r6-linearized-rc4.pdf", "r6-linearized-aes256.pdf"])("%s: no conflict (main trailer without /Encrypt)", (name) => {
    expect(pdfEncryptionStructure(fixture(name))).toEqual({ encrypted: true, conflict: null });
    expect(inspectQuarantineBytes(fixture(name), name, policy).pdf).toEqual({ encryptName: true, encryptConflict: false });
  });

  it("the same trailers without a linearization dictionary stay refused (round-5 trailer-enc-first)", () => {
    const bytes = Buffer.from(fixture("r6-linearized-rc4.pdf").toString("latin1").replace("/Linearized", "/Linearizex"), "latin1");
    expect(pdfEncryptionStructure(bytes).conflict).toBe("trailers disagree on /Encrypt");
  });

  it("a linearized file with a second trailer lacking /Encrypt (not the first-page /Prev target) stays refused", () => {
    const text = fixture("r6-linearized-rc4.pdf").toString("latin1");
    // Append an incremental update whose trailer drops /Encrypt.
    const update = `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 12 /Prev 1858 /ID [<00><00>] >>\nstartxref\n${text.length}\n%%EOF\n`;
    expect(pdfEncryptionStructure(Buffer.from(text + update, "latin1")).conflict).not.toBeNull();
  });
});

describe("R6-L1: the encryption-structure check is linear in /XRef names", () => {
  it("7.7 MB of `/XRef ` tokens is refused as inconsistent in well under a second (was 93 s)", () => {
    const bytes = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Encrypt 5 0 R >>\n" + "/XRef ".repeat(1_280_000) + "\ntrailer\n<< /Encrypt 5 0 R /ID [<00><00>] >>\nstartxref\n0\n%%EOF\n", "latin1");
    const started = performance.now();
    const result = pdfEncryptionStructure(bytes);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.conflict).toBe("too many cross-reference stream names");
  });

  it("`obj` keywords far before an /XRef name are not searched for (bounded window)", () => {
    const bytes = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Encrypt 5 0 R >>\n" + " ".repeat(64 * 1024) + "/XRef ".repeat(10_000) + "\ntrailer\n<< /Encrypt 5 0 R /ID [<00><00>] >>\nstartxref\n0\n%%EOF\n", "latin1");
    const started = performance.now();
    expect(pdfEncryptionStructure(bytes).conflict).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("R6-M2: tar shapes tar readers extract are walked", () => {
  const issuesOf = (name: string) => inspectArchive(fixture(name), name, policy)?.issues ?? [];

  it.each([
    ["r6-tar-control.xlsx", "ustar"],
    ["r6-tar-v7.xlsx", "V7 tar without ustar magic, the ZIP past the 4 KiB head"],
  ])("%s (%s): the nested ZIP64 is found and refused", (name) => {
    expect(issuesOf(name)).toEqual(["archive-nested-zip64"]);
  });

  it("r6-tar-pax-size.xlsx (pax size=696 over a zero ustar size): the 696-byte member is read, and the ZIP behind its leading zero block is refused", () => {
    // Before the fix the walk stopped at that zero block, taking it for the end of the archive, and accepted the file.
    expect(issuesOf("r6-tar-pax-size.xlsx")).toEqual(["archive-nested-embedded-container"]);
  });

  it("a member after a lone zero block is walked too (tolerant readers go on reading)", () => {
    expect(issuesOf("r6-tar-lone-zero.xlsx")).toEqual(["archive-nested-zip64"]);
  });
});

describe("R6-L2: an encrypted PDF nested in Office or an archive is refused as unscannable", () => {
  it("xlsx-member-encpdf.xlsx: archive-nested-encrypted-pdf", () => {
    expect(inspectArchive(fixture("r6-xlsx-member-encpdf.xlsx"), "q3.xlsx", policy)?.issues).toEqual(["archive-nested-encrypted-pdf"]);
  });
});

describe("R6-L3: a PDF anywhere in a magic-less media file is refused", () => {
  it.each(["r6-far-enc-raw.mp3", "r6-far-base-raw.mp3"])("%s (71 KiB of MPEG frames, the PDF, 8 KiB of frames): archive-embedded-container", (name) => {
    expect(inspectQuarantineBytes(fixture(name), name, policy).archive?.issues).toEqual(["archive-embedded-container"]);
  });

  it("ordinary-looking MPEG frames without a document are accepted", () => {
    const frame = Buffer.alloc(417, 0x55);
    frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x64;
    const mp3 = Buffer.concat(Array.from({ length: 400 }, () => frame));
    expect(inspectQuarantineBytes(mp3, "song.mp3", policy).archive).toBeNull();
  });
});
