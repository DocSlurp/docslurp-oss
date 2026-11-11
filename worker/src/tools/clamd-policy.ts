import { randomBytes } from "node:crypto";
import { deflateRawSync, deflateSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CLAM_SCAN_LIMITS, isClamEncryptedAlert, isClamLimitAlert } from "./clam-limits.js";

/**
 * Verified policy of a locally configured clamd (council re-check 2, H1).
 *
 * clamdscan only connects to a daemon that is already running; its client config cannot tell what that daemon was started
 * with. A daemon without AlertEncryptedArchive/AlertEncryptedDoc returns `OK` (exit 0) for a password-protected ZIP, and one
 * without AlertExceedsMax returns `OK` for anything over its size, depth or time limits (the Debian default config stops at
 * 25 MB). Either is a silent clean verdict. So before a daemon is trusted, two generated canaries are scanned through it:
 *
 * - an encrypted ZIP (ZipCrypto, random password, benign contents) must be a `Heuristics.Encrypted.*` detection;
 * - ZIPs nested deeper than CLAM_SCAN_LIMITS.maxRecursion must be a `Heuristics.Limits.Exceeded.*` detection.
 *
 * The scan also relies on the daemon opening what it is given (council re-check 4, M2: a daemon started with `ScanPDF no`
 * passed both canaries and then reported a Flate-compressed PDF stream clean). So four content canaries carry the EICAR
 * test file where only that parser can reach it, each of which must be an EICAR detection:
 *
 * - a PDF whose one stream is the EICAR file, Flate-compressed (ScanPDF);
 * - a ZIP whose one member is the EICAR file, Deflate-compressed (ScanArchive);
 * - an OLE2 compound file whose one stream is the EICAR file, its two mini sectors stored in reverse order so the bytes
 *   appear in order only to an OLE2 reader (ScanOLE2);
 * - an HTML page with the EICAR file as a base64 `data:` URI, which libclamav's HTML parser decodes (ScanHTML).
 *
 * The EICAR signatures (a hash of the 68-byte file and a body signature at offset 0) never match the canary files
 * themselves, only what a parser extracts from them. Measured with ClamAV 1.4.3: each canary is detected with the full
 * policy and reported OK when only its own parser is turned off (--scan-pdf/-ole2/-archive/-html=no).
 *
 * Anything else (clean, another signature, an error) means the daemon's effective policy is not ours, and it is not used.
 * Results are cached per daemon identity (config, its socket's inode and change time, the version and signature version
 * the daemon reports) for a short TTL and dropped when a scan through the daemon fails to talk to it, so a daemon
 * restarted with another config is re-verified (council L3).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Byte(crc: number, byte: number): number {
  return (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crc32Byte(crc, byte);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Traditional PKWARE (ZipCrypto) encryption of `data`, with its 12-byte header (APPNOTE 6.1). */
function zipCrypto(data: Uint8Array, password: Uint8Array, crc: number): Buffer {
  let k0 = 0x12345678;
  let k1 = 0x23456789;
  let k2 = 0x34567890;
  const update = (byte: number) => {
    k0 = crc32Byte(k0, byte);
    k1 = (Math.imul((k1 + (k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    k2 = crc32Byte(k2, k1 >>> 24);
  };
  const streamByte = () => {
    const temp = (k2 | 2) & 0xffff;
    return (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
  };
  for (const byte of password) update(byte);
  const header = randomBytes(12);
  header[11] = crc >>> 24;
  const plain = Buffer.concat([header, data]);
  const out = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i += 1) {
    out[i] = plain[i]! ^ streamByte();
    update(plain[i]!);
  }
  return out;
}

/** A ZIP of stored entries; `password` encrypts every entry with ZipCrypto. */
export function storedZip(entries: Array<{ name: string; data: Uint8Array }>, password?: Uint8Array): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const body = password ? zipCrypto(entry.data, password, crc) : Buffer.from(entry.data);
    const flags = (password ? 0x0001 : 0) | 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

/** A password-protected ZIP (random password) of a short benign note: a daemon that alerts on encryption detects it. */
export function encryptedZipCanary(): Buffer {
  const note = Buffer.from(`DocSlurp clamd policy canary ${randomBytes(8).toString("hex")}: quarterly results beat the forecast.\n`);
  return storedZip([{ name: "note.txt", data: note }], Buffer.from(randomBytes(16).toString("hex")));
}

/** ZIPs nested `depth` deep around a benign note: past MaxRecursion, a daemon with AlertExceedsMax reports a limit. */
export function nestedZipCanary(depth = CLAM_SCAN_LIMITS.maxRecursion + 3): Buffer {
  let data: Buffer = Buffer.from(`DocSlurp clamd recursion canary ${randomBytes(8).toString("hex")}\n`);
  let name = "note.txt";
  for (let level = 0; level < depth; level += 1) {
    data = storedZip([{ name, data }]);
    name = `level-${level}.zip`;
  }
  return data;
}

/** The EICAR anti-virus test file (eicar.org): detected by every ClamAV signature set, harmless. */
export const EICAR_TEST_FILE = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*", "latin1");

/** A one-page PDF whose only stream is `payload`, Flate-compressed: a daemon that scans PDFs extracts and matches it. */
export function flatePdfCanary(payload: Buffer = EICAR_TEST_FILE): Buffer {
  const stream = deflateSync(payload);
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets: number[] = [];
  const add = (body: Buffer) => {
    offsets.push(parts.reduce((sum, part) => sum + part.length, 0));
    parts.push(body);
  };
  add(Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "latin1"));
  add(Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "latin1"));
  add(Buffer.from("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n", "latin1"));
  add(Buffer.concat([Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), stream, Buffer.from("\nendstream\nendobj\n", "latin1")]));
  const xref = parts.reduce((sum, part) => sum + part.length, 0);
  const table = ["xref", `0 ${offsets.length + 1}`, "0000000000 65535 f ", ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)].join("\n");
  parts.push(Buffer.from(`${table}\ntrailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/** A ZIP whose one member is `payload`, Deflate-compressed: a daemon that scans archives inflates and matches it. */
export function deflatedZipCanary(payload: Buffer = EICAR_TEST_FILE, name = "canary.com"): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const body = deflateRawSync(payload);
  const crc = crc32(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const directory = Buffer.concat([central, nameBytes]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + body.length, 16);
  return Buffer.concat([local, nameBytes, body, directory, end]);
}

/**
 * A version 3 OLE2 compound file (MS-CFB) with one stream, `Canary`, holding `payload` (at most 128 bytes) in the mini
 * stream, its mini sectors stored in reverse order: the payload's bytes are in order only when an OLE2 reader follows the
 * mini FAT chain. Sectors: 0 the FAT, 1 the directory, 2 the mini FAT, 3 the mini stream.
 */
export function ole2Canary(payload: Buffer = EICAR_TEST_FILE): Buffer {
  if (payload.length === 0 || payload.length > 128) throw new Error("OLE2 canary payload must be 1-128 bytes");
  const SECTOR = 512;
  const FREESECT = 0xffffffff;
  const ENDOFCHAIN = 0xfffffffe;
  const FATSECT = 0xfffffffd;
  const header = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(1, 0x2c); // FAT sectors
  header.writeUInt32LE(1, 0x30); // directory start
  header.writeUInt32LE(4096, 0x38); // mini stream cutoff
  header.writeUInt32LE(2, 0x3c); // mini FAT start
  header.writeUInt32LE(1, 0x40); // mini FAT sectors
  header.writeUInt32LE(ENDOFCHAIN, 0x44); // no DIFAT sectors
  for (let index = 0; index < 109; index += 1) header.writeUInt32LE(index === 0 ? 0 : FREESECT, 0x4c + index * 4);
  const fat = Buffer.alloc(SECTOR, 0xff);
  fat.writeUInt32LE(FATSECT, 0);
  fat.writeUInt32LE(ENDOFCHAIN, 4);
  fat.writeUInt32LE(ENDOFCHAIN, 8);
  fat.writeUInt32LE(ENDOFCHAIN, 12);
  // Mini sectors: the payload's first 64 bytes go to mini sector 1, the rest to mini sector 0; the chain is 1 -> 0.
  const miniFat = Buffer.alloc(SECTOR, 0xff);
  const twoSectors = payload.length > 64;
  miniFat.writeUInt32LE(ENDOFCHAIN, 0);
  if (twoSectors) miniFat.writeUInt32LE(0, 4);
  const miniStream = Buffer.alloc(SECTOR);
  if (twoSectors) {
    payload.copy(miniStream, 64, 0, 64);
    payload.copy(miniStream, 0, 64);
  } else {
    payload.copy(miniStream, 0);
  }
  const directory = Buffer.alloc(SECTOR);
  const entry = (index: number, name: string, type: number, child: number, start: number, size: number) => {
    const at = index * 128;
    directory.write(name, at, "utf16le");
    directory.writeUInt16LE((name.length + 1) * 2, at + 0x40);
    directory[at + 0x42] = type;
    directory[at + 0x43] = 1; // black
    directory.writeUInt32LE(FREESECT, at + 0x44);
    directory.writeUInt32LE(FREESECT, at + 0x48);
    directory.writeUInt32LE(child, at + 0x4c);
    directory.writeUInt32LE(start, at + 0x74);
    directory.writeUInt32LE(size, at + 0x78);
  };
  entry(0, "Root Entry", 5, 1, 3, twoSectors ? 128 : 64);
  entry(1, "Canary", 2, FREESECT, twoSectors ? 1 : 0, payload.length);
  for (const index of [2, 3]) {
    for (const offset of [0x44, 0x48, 0x4c]) directory.writeUInt32LE(FREESECT, index * 128 + offset);
  }
  return Buffer.concat([header, fat, directory, miniFat, miniStream]);
}

/** An HTML page carrying `payload` as a base64 `data:` URI: a daemon that scans HTML decodes and matches it. */
export function htmlDataUriCanary(payload: Buffer = EICAR_TEST_FILE): Buffer {
  return Buffer.from(`<!doctype html>\n<html><body><p>DocSlurp clamd HTML canary</p><img alt="" src="data:application/octet-stream;base64,${payload.toString("base64")}"></body></html>\n`, "latin1");
}

export interface ClamdProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * `transient`: the daemon did not answer as a scanner (exit 2+, no exit, an exception): it may be down or reloading, so
 * the refusal is not cached and the next scan checks again. A daemon that answered with the wrong verdict is not transient.
 */
export type ClamdPolicyVerdict = { trusted: true } | { trusted: false; reason: string; transient: boolean };

function detections(result: ClamdProbeResult, file: string): string[] {
  const base = path.basename(file);
  return [...`${result.stdout}\n${result.stderr}`.matchAll(/^(.*?):\s+(.+?)\s+FOUND$/gm)]
    .filter((match) => path.basename(match[1]!.trim()) === base)
    .map((match) => match[2]!.trim());
}

function describe(result: ClamdProbeResult): string {
  if (result.exitCode === 0) return "clean (exit 0)";
  const text = `${result.stdout} ${result.stderr}`.replace(/\s+/g, " ").trim().slice(0, 200);
  return `exit ${result.exitCode ?? "none"}${text ? `: ${text}` : ""}`;
}

export type ClamdCanaryKind = "encrypted" | "recursion" | "pdf" | "archive" | "ole2" | "html";

/** The policy canaries, generated fresh each time (random contents and password for the alert canaries). */
export function policyCanaries(): Array<{ kind: ClamdCanaryKind; name: string; data: Buffer }> {
  return [
    { kind: "encrypted", name: "encrypted-canary.zip", data: encryptedZipCanary() },
    { kind: "recursion", name: "recursion-canary.zip", data: nestedZipCanary() },
    { kind: "pdf", name: "pdf-canary.pdf", data: flatePdfCanary() },
    { kind: "archive", name: "archive-canary.zip", data: deflatedZipCanary() },
    { kind: "ole2", name: "ole2-canary.doc", data: ole2Canary() },
    { kind: "html", name: "html-canary.html", data: htmlDataUriCanary() },
  ];
}

const CONTENT_CANARY_PARSER: Record<"pdf" | "archive" | "ole2" | "html", string> = { pdf: "ScanPDF", archive: "ScanArchive", ole2: "ScanOLE2", html: "ScanHTML" };

/** Why a daemon's answer for one canary shows a policy other than ours, or null when it is the expected detection. */
export function judgeCanary(kind: ClamdCanaryKind, result: ClamdProbeResult, file: string): string | null {
  const found = detections(result, file);
  if (kind === "pdf" || kind === "archive" || kind === "ole2" || kind === "html") {
    return result.exitCode === 1 && found.some((signature) => /eicar/i.test(signature))
      ? null
      : `${kind} content canary (EICAR only a ${kind} parser reaches) was not detected (${CONTENT_CANARY_PARSER[kind]} off?): ${describe(result)}`;
  }
  if (kind === "encrypted") {
    return result.exitCode === 1 && found.some(isClamEncryptedAlert)
      ? null
      : `encrypted ZIP canary was not reported as Heuristics.Encrypted (AlertEncryptedArchive off?): ${describe(result)}`;
  }
  return result.exitCode === 1 && found.some(isClamLimitAlert)
    ? null
    : `nested ZIP canary was not reported as Heuristics.Limits.Exceeded (AlertExceedsMax off, or MaxRecursion above ${CLAM_SCAN_LIMITS.maxRecursion + 2}?): ${describe(result)}`;
}

/**
 * Scan both canaries through `probe` (which must scan exactly as a document scan would: same binary, config and daemon) and
 * decide whether that daemon may be trusted. The canaries are written to a fresh private directory and removed after.
 */
export async function verifyClamdPolicy(probe: (file: string) => Promise<ClamdProbeResult>): Promise<ClamdPolicyVerdict> {
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-clamd-canary-"));
  try {
    for (const canary of policyCanaries()) {
      const file = path.join(dir, canary.name);
      await writeFile(file, canary.data, { mode: 0o644 });
      const result = await probe(file);
      const refusal = judgeCanary(canary.kind, result, file);
      if (refusal) return { trusted: false, transient: result.exitCode !== 0 && result.exitCode !== 1, reason: refusal };
    }
    return { trusted: true };
  } catch (error) {
    return { trusted: false, transient: true, reason: `canary scan failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** DOCSLURP_CLAMD_POLICY_TTL_MS: how long a daemon's verified policy is trusted before it is checked again (default 5 min). */
export function clamdPolicyTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DOCSLURP_CLAMD_POLICY_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 3_600_000) : 300_000;
}

/**
 * Verdicts by daemon key (config path plus signature version). One verification at a time per key; at most `maxKeys` keys
 * are held (oldest dropped). A refusal is cached for the same TTL as a pass, so a misconfigured daemon is not probed on
 * every document, except a transient one (the daemon did not answer), which is checked again on the next scan.
 * `invalidate` drops a key, or every key, at once (a scan that could not talk to the daemon).
 */
export class ClamdPolicyCache {
  private readonly verdicts = new Map<string, { at: number; verdict: Promise<ClamdPolicyVerdict> }>();

  constructor(
    private readonly ttlMs: () => number = () => clamdPolicyTtlMs(),
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 8,
  ) {}

  verify(key: string, probe: (file: string) => Promise<ClamdProbeResult>): Promise<ClamdPolicyVerdict> {
    const cached = this.verdicts.get(key);
    if (cached && this.now() - cached.at < this.ttlMs()) return cached.verdict;
    const verdict = verifyClamdPolicy(probe);
    const entry = { at: this.now(), verdict };
    this.verdicts.delete(key);
    this.verdicts.set(key, entry);
    void verdict.then((result) => {
      if (!result.trusted && result.transient && this.verdicts.get(key) === entry) this.verdicts.delete(key);
    });
    while (this.verdicts.size > this.maxKeys) this.verdicts.delete(this.verdicts.keys().next().value!);
    return verdict;
  }

  invalidate(key?: string): void {
    if (key === undefined) this.verdicts.clear();
    else this.verdicts.delete(key);
  }

  get size(): number {
    return this.verdicts.size;
  }
}
