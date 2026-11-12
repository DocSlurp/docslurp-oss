import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { QUARANTINE_PUBLIC_REASONS, quarantinePublicReason } from "@docslurp/shared";

import { readPdfStructure } from "../deferred/pdf-structure-guest.js";
import { pdfEncryptionStructure } from "../lib/pdf-encryption-structure.js";
import { buildQuarantineStats, quarantineTelemetryLine, scanDocumentForQuarantine } from "../lib/quarantine.js";
import { findEmbeddedDocument, inspectQuarantineBytes } from "../lib/quarantine-bytes.js";
import { localClamdSocketIdentity, type MalwareScanResult } from "../tools/runner.js";

/**
 * PR #339 council round 5 (adversarial re-check 2): N-H1 (encryption readers disagree on), N-L2 (a PDF behind an exempt
 * media type), N-L4 (signature names in public stage stats) and the prior L3 (TCP clamd identity).
 */
const policy = {
  quarantineFailOpenOnToolMissing: false,
  quarantineMaxArchiveEntries: 2_000,
  quarantineMaxArchiveDepth: 12,
  quarantineMaxTotalUncompressedBytes: 512 * 1024 * 1024,
  quarantineMaxSingleEntryBytes: 128 * 1024 * 1024,
  quarantineMaxExpansionRatio: 250,
} as const;

/** A PDF assembled from object bodies with a classic xref table and `trailerExtra` in its trailer. */
function pdf(objects: string[], trailerExtra: string, options: { startxref?: number; tail?: (xref: number) => string } = {}): { bytes: string; xref: number } {
  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${options.startxref ?? xref}\n%%EOF\n`;
  if (options.tail) out += options.tail(xref);
  return { bytes: out, xref };
}

const ID_A = "/ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>]";
/** The same first element as ID_A (upper case, a space inside the hex string), a new second element. */
const ID_A2 = "/ID [<0123456789ABCDEF 0123456789ABCDEF> <fedcba9876543210fedcba9876543210>]";
const ID_B = "/ID [<ffffffffffffffffffffffffffffffff> <ffffffffffffffffffffffffffffffff>]";
const ENC = "<< /Filter /Standard /V 2 /R 3 /Length 128 /P -4 /O <00> /U <00> >>";
const BASE = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>", ENC];

/** An incremental update appended to `base` with its own xref section, `objects` (numbered from `first`) and trailer. */
function update(base: { bytes: string; xref: number }, first: number, objects: string[], trailerExtra: string, prev = base.xref): { bytes: string; xref: number } {
  let out = base.bytes;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${first + index} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n${first} ${objects.length}\n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${first + objects.length} /Root 1 0 R /Prev ${prev} ${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return { bytes: out, xref };
}

/** The same document with a cross-reference stream (PDF 1.5 object streams) instead of a table. */
function xrefStreamPdf(trailerExtra: string, extra: Array<{ encrypt: string; id: string }> = []): string {
  let out = "%PDF-1.7\n";
  for (const [index, body] of BASE.entries()) out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  let last = 0;
  const sections = [{ encrypt: "/Encrypt 4 0 R", id: ID_A }, ...extra];
  sections.forEach((section, index) => {
    const prev = last;
    last = out.length;
    out += `${10 + index} 0 obj\n<< /Type /XRef /Size ${11 + index} /W [1 4 2] /Root 1 0 R ${section.encrypt} ${section.id} ${index ? `/Prev ${prev}` : ""} ${trailerExtra} /Length 0 >>\nstream\n\nendstream\nendobj\n`;
  });
  return `${out}startxref\n${last}\n%%EOF\n`;
}

const structure = (text: string) => pdfEncryptionStructure(Buffer.from(text, "latin1"));

describe("council N-H1: pdfEncryptionStructure (in the parser VM)", () => {
  it("an ordinary encrypted PDF, and one with incremental updates that keep its /Encrypt and first /ID: consistent", () => {
    const base = pdf(BASE, `/Encrypt 4 0 R ${ID_A}`);
    expect(structure(base.bytes)).toEqual({ encrypted: true, conflict: null });
    const once = update(base, 5, ["<< /Producer (Q3 board pack) >>"], `/Encrypt 4 0 R ${ID_A2.replace("fedcba9876543210fedcba9876543210", "00112233445566778899aabbccddeeff")}`);
    expect(structure(once.bytes)).toEqual({ encrypted: true, conflict: null });
    const twice = update(once, 6, ["<< /Producer (Q3 board pack, final) >>"], `/Encrypt 4 0 R ${ID_A2}`);
    expect(structure(twice.bytes)).toEqual({ encrypted: true, conflict: null });
  });

  it("an unencrypted PDF that only mentions /Encrypt (comment, string): not encrypted, no conflict", () => {
    expect(structure(pdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [] /Count 0 /Note (see /Encrypt 9 0 R) >>"], ID_A, { tail: () => "% /Encrypt 7 0 R\n" }).bytes)).toEqual({ encrypted: false, conflict: null });
  });

  it("the reviewer's twokey shape: two encryption dictionaries under two trailers, startxref broken", () => {
    const base = pdf([...BASE], `/Encrypt 4 0 R ${ID_A}`, { startxref: 999_999 });
    const twoKey = `${base.bytes}99 0 obj\n${ENC.replace("/O <00>", "/O <11>")}\nendobj\ntrailer\n<< /Size 100 /Root 1 0 R /Encrypt 99 0 R ${ID_A} >>\nstartxref\n999999\n%%EOF\n`;
    expect(structure(twoKey).conflict).toBe("more than one encryption dictionary");
  });

  it("three trailers (A, B, A) with a valid chain: refused", () => {
    const base = pdf(BASE, `/Encrypt 4 0 R ${ID_A}`);
    const b = update(base, 5, [ENC.replace("/O <00>", "/O <22>")], `/Encrypt 5 0 R ${ID_A}`);
    const a = update(b, 6, ["<< /Producer (Q3) >>"], `/Encrypt 4 0 R ${ID_A}`);
    expect(structure(a.bytes).conflict).toBe("more than one encryption dictionary");
  });

  it("a /Prev chain whose update switches to a second encryption dictionary: refused", () => {
    const base = pdf(BASE, `/Encrypt 4 0 R ${ID_A}`);
    expect(structure(update(base, 5, [ENC], `/Encrypt 5 0 R ${ID_A}`).bytes).conflict).toBe("more than one encryption dictionary");
  });

  it("an escaped name in the second trailer (/En#63rypt) counts as a second encryption dictionary", () => {
    const base = pdf(BASE, `/Encrypt 4 0 R ${ID_A}`);
    expect(structure(update(base, 5, [ENC], `/En#63rypt 5 0 R ${ID_A}`).bytes).conflict).toBe("more than one encryption dictionary");
  });

  it("trailers that disagree on whether the file is encrypted (the trailer-enc-first shape): refused", () => {
    const base = pdf(BASE, `/Encrypt 4 0 R ${ID_A}`);
    expect(structure(update(base, 5, ["<< /Producer (Q3) >>"], ID_A).bytes).conflict).toBe("trailers disagree on /Encrypt");
  });

  it("trailers that disagree on the first /ID element (the key's input), or omit it: refused", () => {
    const base = pdf(BASE, `/Encrypt 4 0 R ${ID_A}`);
    expect(structure(update(base, 5, ["<< /Producer (Q3) >>"], `/Encrypt 4 0 R ${ID_B}`).bytes).conflict).toBe("trailers disagree on /ID");
    expect(structure(update(base, 5, ["<< /Producer (Q3) >>"], "/Encrypt 4 0 R").bytes).conflict).toBe("trailers disagree on /ID");
  });

  it("one encryption dictionary, but a broken startxref or /Prev (readers reconstruct): refused", () => {
    expect(structure(pdf(BASE, `/Encrypt 4 0 R ${ID_A}`, { startxref: 999_999 }).bytes).conflict).toBe("startxref does not point at a cross-reference section");
    const base = pdf(BASE, `/Encrypt 4 0 R ${ID_A}`);
    expect(structure(update(base, 5, ["<< /Producer (Q3) >>"], `/Encrypt 4 0 R ${ID_A}`, 17).bytes).conflict).toBe("/Prev does not point at a cross-reference section");
  });

  it("cross-reference streams (object streams): one is consistent, a second /Encrypt or /ID in another is refused", () => {
    expect(structure(xrefStreamPdf("")).conflict).toBeNull();
    expect(structure(xrefStreamPdf("")).encrypted).toBe(true);
    expect(structure(xrefStreamPdf("", [{ encrypt: "/Encrypt 4 0 R", id: ID_A }])).conflict).toBeNull();
    expect(structure(xrefStreamPdf("", [{ encrypt: "/Encrypt 3 0 R", id: ID_A }])).conflict).toBe("more than one encryption dictionary");
    expect(structure(xrefStreamPdf("", [{ encrypt: "/Encrypt 4 0 R", id: ID_B }])).conflict).toBe("trailers disagree on /ID");
    expect(structure(xrefStreamPdf("", [{ encrypt: "", id: ID_A }])).conflict).toBe("trailers disagree on /Encrypt");
  });

  it("the guest inspection reports the conflict (encryptConflict), and only for an encrypted PDF", () => {
    const base = pdf(BASE, `/Encrypt 4 0 R ${ID_A}`);
    const conflicted = Buffer.from(update(base, 5, [ENC], `/Encrypt 5 0 R ${ID_A}`).bytes, "latin1");
    expect(inspectQuarantineBytes(conflicted, "board-pack.pdf", policy).pdf).toEqual({ encryptName: true, encryptConflict: true });
    expect(inspectQuarantineBytes(Buffer.from(base.bytes, "latin1"), "board-pack.pdf", policy).pdf).toEqual({ encryptName: true, encryptConflict: false });
    expect(inspectQuarantineBytes(Buffer.from(pdf(BASE.slice(0, 3), ID_A).bytes, "latin1"), "board-pack.pdf", policy).pdf).toEqual({ encryptName: false, encryptConflict: false });
  });

  it("pdf.js never reads outline titles from such a file (document map: nodes, search text, metadata.mapTitle)", async () => {
    const base = pdf(BASE, `/Encrypt 4 0 R ${ID_A}`);
    await expect(readPdfStructure(Buffer.from(update(base, 5, [ENC], `/Encrypt 5 0 R ${ID_A}`).bytes, "latin1"))).rejects.toThrow(/encryption structure is inconsistent/);
  });

  it("the public reason for pdf-encryption-inconsistent is the reviewed encrypted-file copy", () => {
    expect(quarantinePublicReason("pdf-encryption-inconsistent")).toBe("quarantine-encrypted");
    expect(QUARANTINE_PUBLIC_REASONS[quarantinePublicReason("pdf-encryption-inconsistent")]).not.toMatch(/Encrypt|qpdf|trailer/);
  });
});

describe("council N-L2: a PDF or OLE2 file behind a type exempt from the magic check", () => {
  const pdfBytes = Buffer.from(pdf(BASE.slice(0, 3), ID_A).bytes, "latin1");

  it.each([
    ["NUL-prefixed PDF as .mp3", "earnings-call.mp3", Buffer.concat([Buffer.alloc(1440), pdfBytes])],
    ["NUL-prefixed PDF as .mov", "keynote.mov", Buffer.concat([Buffer.alloc(1440), pdfBytes])],
    ["NUL-prefixed PDF as .aac", "earnings-call.aac", Buffer.concat([Buffer.alloc(1440), pdfBytes])],
    ["ID3 tag, then a PDF, as .mp3", "earnings-call.mp3", Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), Buffer.alloc(1440), pdfBytes])],
    ["a PDF found only by its startxref (header past 64 KiB)", "keynote.mov", Buffer.concat([Buffer.alloc(70_000), pdfBytes])],
    ["an OLE2 file at an offset, as .heic", "launch.heic", Buffer.concat([Buffer.alloc(100), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)])],
  ])("%s: archive-embedded-container", (_label, filename, bytes) => {
    expect(inspectQuarantineBytes(bytes, filename, policy).archive?.issues).toEqual(["archive-embedded-container"]);
  });

  it("controls: ordinary media, a text note quoting %PDF-, and a PDF itself are not refused for it", () => {
    const frame = Buffer.alloc(4096);
    for (let offset = 0; offset < frame.length; offset += 417) frame.set([0xff, 0xfb, 0x90, 0x64], offset);
    expect(inspectQuarantineBytes(Buffer.concat([Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), frame]), "earnings-call.mp3", policy).archive).toBeNull();
    expect(inspectQuarantineBytes(Buffer.from("Release notes: PDF exports now start with %PDF-1.7 and end with startxref.\n"), "notes.txt", policy).archive).toBeNull();
    expect(inspectQuarantineBytes(pdfBytes, "board-pack.pdf", policy).archive).toBeNull();
    expect(findEmbeddedDocument(frame)).toBeNull();
  });
});

describe("council N-L4: stage stats (public) carry no signature or engine; telemetry does", () => {
  const infected = { engine: "clamdscan", available: true, status: "infected", signature: "Win.Trojan.SECRETSIG-1", stdout: "", stderr: "", exitCode: 1, databaseStatus: "fresh", databaseUpdatedAt: null, databaseAgeHours: null, databaseSource: null } as unknown as MalwareScanResult;

  it("buildQuarantineStats omits malwareSignature and malwareEngine; the log line keeps them", async () => {
    const artifact = await scanDocumentForQuarantine({
      documentId: "doc-1", filename: "q3.txt", declaredMimeType: "text/plain", bytes: Buffer.from("Quarterly results beat the forecast.\n"), tempFile: "/nonexistent/q3.txt",
      runner: { scanForMalware: async () => infected } as never, policy,
    });
    const stats = buildQuarantineStats(artifact);
    expect(stats).not.toHaveProperty("malwareSignature");
    expect(stats).not.toHaveProperty("malwareEngine");
    expect(JSON.stringify(stats)).not.toMatch(/SECRETSIG|clamdscan/);
    expect(stats).toMatchObject({ decision: "quarantined", malwareStatus: "infected", reasonCodes: ["malware-detected"] });
    expect(quarantineTelemetryLine(artifact)).toMatch(/document=doc-1 decision=quarantined reasons=malware-detected engine=clamdscan signature="Win\.Trojan\.SECRETSIG-1"/);
  });
});

describe("prior council L3: the local clamd's identity (canary cache key)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-clamd-identity-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const table = (rows: Array<[string, string, string]>) => [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    ...rows.map(([local, st, inode], index) => `   ${index}: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000   100        0 ${inode} 1 0000000000000000 100 0 0 10 0`),
  ].join("\n");

  it("TCPSocket: the listening socket's inode, which a restarted daemon replaces", async () => {
    const conf = path.join(dir, "clamd.conf");
    await writeFile(conf, "TCPSocket 3310\nTCPAddr 127.0.0.1\n");
    const proc = path.join(dir, "proc-a");
    await import("node:fs/promises").then((fs) => fs.mkdir(proc));
    await writeFile(path.join(proc, "tcp"), table([["0100007F:0CEE", "0A", "4242"], ["0100007F:0CEE", "01", "999"], ["0100007F:1F90", "0A", "7"]]));
    const first = await localClamdSocketIdentity(conf, proc);
    expect(first).toBe("tcp:3310:tcp:0100007F:0CEE:4242");
    await writeFile(path.join(proc, "tcp"), table([["0100007F:0CEE", "0A", "4343"]]));
    const restarted = await localClamdSocketIdentity(conf, proc);
    expect(restarted).not.toBe(first);
  });

  it("TCPSocket with nothing listening here (another host or namespace): no identity, so the verdict is never cached", async () => {
    const conf = path.join(dir, "clamd-remote.conf");
    await writeFile(conf, "TCPSocket 3310\nTCPAddr 10.0.0.9\n");
    expect(await localClamdSocketIdentity(conf, path.join(dir, "no-proc"))).toBeNull();
  });

  it("LocalSocket: the socket file's inode and change time; missing socket or config: no identity", async () => {
    const socket = path.join(dir, "clamd.sock");
    await writeFile(socket, "");
    const conf = path.join(dir, "clamd-unix.conf");
    await writeFile(conf, `LocalSocket ${socket}\n`);
    expect(await localClamdSocketIdentity(conf)).toMatch(/^unix:\d+:[\d.]+$/);
    await writeFile(conf, `LocalSocket ${path.join(dir, "gone.sock")}\n`);
    expect(await localClamdSocketIdentity(conf)).toBeNull();
    expect(await localClamdSocketIdentity(path.join(dir, "missing.conf"))).toBeNull();
  });
});
