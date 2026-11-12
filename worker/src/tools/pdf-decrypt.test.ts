import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDefaultParserSandbox } from "../sandbox/startup.js";
import type { ParserSandboxProvider, SandboxCommand } from "../sandbox/types.js";
import { CommandRunner, PDF_DECRYPT_LIMITS, PDF_REWRITE_EXPANSION, pdfDecryptArgv, pdfEncryptionCheckArgv, pdfRewriteOutputLimit, pdfShowEncryptionArgv, qpdfDecryptComplete, qpdfReportsNotEncrypted, qpdfWarningsBenign } from "./runner.js";

/**
 * Owner decision on PR #339: an empty-user-password PDF is decrypted in the parser VM (qpdf, bounded by prlimit) and the
 * plaintext copy scanned too. These hold the command shape and the fail-closed mapping of every qpdf outcome; the real
 * qpdf and ClamAV run in clam-hostile-matrix.docker.test.ts with these same argv.
 */
describe("CommandRunner.decryptPdfForScan", () => {
  let dir: string;
  let commands: SandboxCommand[];
  let replies: Array<{ exitCode: number; stdout?: string; stderr?: string; write?: number }>;

  function register(tools: string[]) {
    const provider = {
      id: "modal",
      openSession: async () => ({
        providerId: "modal",
        isolation: { filesystem: true, network: "none", processes: true, location: "remote" },
        run: async (command: SandboxCommand) => {
          commands.push(command);
          const reply = replies.shift() ?? { exitCode: 0 };
          // A decrypt that "wrote" its copy: the output argument is the last one.
          if (reply.write !== undefined) await writeFile(command.args.at(-1)!, Buffer.alloc(reply.write));
          return { exitCode: reply.exitCode, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", cpuSeconds: 0 };
        },
        close: async () => {},
      }),
    } as unknown as ParserSandboxProvider;
    setDefaultParserSandbox({ provider, config: {}, isolation: { filesystem: true, network: "none", processes: true, location: "remote" }, tools });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-pdf-decrypt-"));
    commands = [];
    replies = [];
    register(["qpdf", "prlimit"]);
  });
  afterEach(async () => {
    setDefaultParserSandbox(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  async function decrypt() {
    const source = path.join(dir, "upload.pdf");
    await writeFile(source, "%PDF-1.7\ntrailer<</Encrypt 5 0 R>>");
    const out = await mkdtemp(path.join(dir, "out-"));
    return await new CommandRunner().decryptPdfForScan(source, out);
  }

  it("bounds both qpdf runs with prlimit (address space, CPU; the copy by RLIMIT_FSIZE) and a wall clock", () => {
    expect(pdfEncryptionCheckArgv("/w/in.pdf")).toEqual(["prlimit", `--as=${PDF_DECRYPT_LIMITS.addressSpaceMiB * 1024 * 1024}`, `--cpu=${PDF_DECRYPT_LIMITS.cpuSeconds}`, "--", "qpdf", "--requires-password", "/w/in.pdf"]);
    expect(pdfDecryptArgv("/w/in.pdf", "/w/out/decrypted.pdf")).toEqual(["prlimit", `--as=${PDF_DECRYPT_LIMITS.addressSpaceMiB * 1024 * 1024}`, `--cpu=${PDF_DECRYPT_LIMITS.cpuSeconds}`, `--fsize=${PDF_DECRYPT_LIMITS.maxOutputBytes}`, "--", "qpdf", "--decrypt", "--qdf", "--object-streams=disable", "--stream-data=uncompress", "/w/in.pdf", "/w/out/decrypted.pdf"]);
    // A file argument that looks like an option is neutralised (planDocumentToolInvocation).
    expect(pdfEncryptionCheckArgv("-in.pdf").at(-1)).not.toMatch(/^-/);
    expect(PDF_DECRYPT_LIMITS.maxOutputBytes).toBeLessThan(1024 * 1024 * 1024);
  });

  it("no password needed (exit 3), then a written copy: decrypted, in the VM, with its size", async () => {
    replies = [{ exitCode: 3 }, { exitCode: 0, write: 4495 }];
    const outcome = await decrypt();
    expect(outcome).toMatchObject({ status: "decrypted", bytes: 4495 });
    expect(commands.map((command) => command.args.slice(command.args.indexOf("qpdf") + 1, command.args.indexOf("qpdf") + 2)[0])).toEqual(["--requires-password", "--decrypt"]);
    expect(commands.every((command) => command.binary === "prlimit" && command.limits.timeoutMs === PDF_DECRYPT_LIMITS.wallMs)).toBe(true);
  });

  it("qpdf recovered a stream length while decrypting an encrypted PDF (exit 3): the copy is still scanned", async () => {
    replies = [{ exitCode: 3 }, { exitCode: 3, write: 10, stderr: "WARNING: upload.pdf (object 4 0, offset 90): expected endstream\nWARNING: upload.pdf (object 4 0, offset 90): attempting to recover stream length\nWARNING: upload.pdf (object 4 0, offset 90): recovered stream length: 120" }];
    expect(await decrypt()).toMatchObject({ status: "decrypted" });
  });

  it("council N-H1: qpdf had to reconstruct an encrypted PDF's cross-reference table (exit 3): failed, readers may pick another trailer and key", async () => {
    for (const stderr of [
      "WARNING: upload.pdf: file is damaged\nWARNING: upload.pdf (offset 999999): xref not found\nWARNING: upload.pdf: Attempting to reconstruct cross-reference table\nqpdf: operation succeeded with warnings; resulting file may have some problems",
      "WARNING: upload.pdf: file is damaged",
      "WARNING: upload.pdf (object 7 0): object has offset 0",
    ]) {
      replies = [{ exitCode: 3 }, { exitCode: 3, write: 10, stderr }];
      expect(await decrypt(), stderr).toMatchObject({ status: "failed", reason: expect.stringMatching(/--decrypt failed \(exit 3\)/) });
    }
  });

  it("an unencrypted PDF (a literal /Encrypt) whose xref qpdf rebuilt: the rewrite is still scanned", async () => {
    replies = [{ exitCode: 2 }, { exitCode: 0, stdout: "File is not encrypted\n" }, { exitCode: 3, write: 10, stderr: "WARNING: upload.pdf: file is damaged\nWARNING: upload.pdf: Attempting to reconstruct cross-reference table" }];
    expect(await decrypt()).toMatchObject({ status: "decrypted", encrypted: false });
  });

  it("council N-L1: an unencrypted PDF's rewrite is capped at a small multiple of the input (RLIMIT_FSIZE and the size check)", async () => {
    replies = [{ exitCode: 2 }, { exitCode: 0, stdout: "File is not encrypted\n" }, { exitCode: 0, write: 10 }];
    await decrypt();
    const rewrite = commands.at(-1)!;
    const sourceBytes = "%PDF-1.7\ntrailer<</Encrypt 5 0 R>>".length;
    expect(rewrite.args).toContain(`--fsize=${pdfRewriteOutputLimit(sourceBytes)}`);
    expect(pdfRewriteOutputLimit(204_000)).toBe(PDF_REWRITE_EXPANSION.floorBytes);
    expect(pdfRewriteOutputLimit(10 * 1024 * 1024)).toBe(PDF_REWRITE_EXPANSION.multiple * 10 * 1024 * 1024);
    expect(pdfRewriteOutputLimit(400 * 1024 * 1024)).toBe(PDF_DECRYPT_LIMITS.maxOutputBytes);
    // A rewrite at the cap (a 200 MiB Flate bomb behind one literal /Encrypt) is refused, never scanned.
    const source = path.join(dir, "bomb.pdf");
    await writeFile(source, "%PDF-1.4\n% /Encrypt\n");
    const out = await mkdtemp(path.join(dir, "out-"));
    await writeFile(path.join(out, "decrypted.pdf"), "");
    await truncate(path.join(out, "decrypted.pdf"), PDF_REWRITE_EXPANSION.floorBytes);
    replies = [{ exitCode: 2 }, { exitCode: 0, stdout: "File is not encrypted\n" }, { exitCode: 0 }];
    expect(await new CommandRunner().decryptPdfForScan(source, out)).toMatchObject({ status: "failed", reason: expect.stringMatching(/reached the \d+-byte limit/) });
    // An encrypted PDF keeps the full limit.
    replies = [{ exitCode: 3 }, { exitCode: 0, write: 10 }];
    commands = [];
    await decrypt();
    expect(commands.at(-1)!.args).toContain(`--fsize=${PDF_DECRYPT_LIMITS.maxOutputBytes}`);
  });

  it("qpdf hit its memory limit, dropped a nested object or left a stream undecoded (exit 3): failed, never a partial copy (council L2)", async () => {
    for (const stderr of [
      "qpdf: std::bad_alloc\nWARNING: upload.pdf (offset 499): stream will be re-processed without filtering to avoid data loss\nqpdf: operation succeeded with warnings; resulting file may have some problems",
      "WARNING: upload.pdf (object 6 0, offset 1757): ignoring excessively deeply nested data structure\nqpdf: operation succeeded with warnings; resulting file may have some problems",
      "qpdf: operation succeeded with warnings; resulting file may have some problems",
    ]) {
      replies = [{ exitCode: 3 }, { exitCode: 3, write: 10, stderr }];
      expect(await decrypt()).toMatchObject({ status: "failed", reason: expect.stringMatching(/--decrypt failed \(exit 3\)/) });
    }
  });

  it("only cross-reference and stream-length recoveries are benign qpdf warnings", () => {
    expect(qpdfWarningsBenign("WARNING: a.pdf: file is damaged\nWARNING: a.pdf (offset 12): xref not found\nWARNING: a.pdf: Attempting to reconstruct cross-reference table\nqpdf: operation succeeded with warnings; resulting file may have some problems\n")).toBe(true);
    expect(qpdfWarningsBenign("WARNING: a.pdf (object 4 0, offset 90): expected endstream\nWARNING: a.pdf (object 4 0, offset 90): attempting to recover stream length\nWARNING: a.pdf (object 4 0, offset 90): recovered stream length: 120\n")).toBe(true);
    expect(qpdfWarningsBenign("")).toBe(false);
    expect(qpdfWarningsBenign("WARNING: a.pdf: file is damaged\nqpdf: std::bad_alloc")).toBe(false);
    expect(qpdfWarningsBenign("WARNING: a.pdf (offset 1): stream will be re-processed without filtering to avoid data loss")).toBe(false);
    // Council N-H1: for an encrypted PDF, cross-reference reconstruction is not benign; stream-length recovery still is.
    expect(qpdfWarningsBenign("WARNING: a.pdf: file is damaged\nWARNING: a.pdf: Attempting to reconstruct cross-reference table", { encrypted: true })).toBe(false);
    expect(qpdfWarningsBenign("WARNING: a.pdf (offset 12): xref not found", { encrypted: true })).toBe(false);
    expect(qpdfWarningsBenign("WARNING: a.pdf (object 4 0, offset 90): recovered stream length: 120", { encrypted: true })).toBe(true);
    expect(qpdfDecryptComplete({ exitCode: 0, stderr: "" }, true)).toBe(true);
    expect(qpdfDecryptComplete({ exitCode: 3, stderr: "WARNING: a.pdf: file is damaged" }, true)).toBe(false);
    expect(qpdfDecryptComplete({ exitCode: 3, stderr: "WARNING: a.pdf: file is damaged" }, false)).toBe(true);
  });

  it("council N-L5: qpdf 12.2's --show-encryption closing line (no 'resulting file' clause) is allowed after benign warnings", () => {
    const stderr = "WARNING: trailer-enc-first.pdf: file is damaged\nWARNING: trailer-enc-first.pdf (offset 999999): xref not found\nWARNING: trailer-enc-first.pdf: Attempting to reconstruct cross-reference table\nqpdf: operation succeeded with warnings\n";
    expect(qpdfWarningsBenign(stderr)).toBe(true);
    expect(qpdfReportsNotEncrypted({ exitCode: 3, stdout: "File is not encrypted\n", stderr })).toBe(true);
    // The closing line alone is still not a benign warning set, and it does not excuse another line.
    expect(qpdfWarningsBenign("qpdf: operation succeeded with warnings\n")).toBe(false);
    expect(qpdfWarningsBenign("WARNING: a.pdf: ignoring excessively deeply nested data structure\nqpdf: operation succeeded with warnings")).toBe(false);
  });

  it("qpdf --requires-password exits 2 but --show-encryption finds no encryption (a literal /Encrypt in a comment, string or stream): the PDF is rewritten and the rewrite scanned, not refused (correctness council, High)", async () => {
    replies = [{ exitCode: 2 }, { exitCode: 0, stdout: "File is not encrypted\n" }, { exitCode: 0, write: 812 }];
    expect(await decrypt()).toMatchObject({ status: "decrypted", bytes: 812, encrypted: false });
    expect(commands.map((command) => command.args[command.args.indexOf("qpdf") + 1])).toEqual(["--requires-password", "--show-encryption", "--decrypt"]);
    expect(pdfShowEncryptionArgv("/w/in.pdf")).toEqual(["prlimit", `--as=${PDF_DECRYPT_LIMITS.addressSpaceMiB * 1024 * 1024}`, `--cpu=${PDF_DECRYPT_LIMITS.cpuSeconds}`, "--", "qpdf", "--show-encryption", "/w/in.pdf"]);
  });

  it("a user password is required (exit 0): requires-password, nothing decrypted", async () => {
    replies = [{ exitCode: 0 }];
    expect(await decrypt()).toMatchObject({ status: "requires-password" });
    expect(commands).toHaveLength(1);
  });

  it.each([
    ["qpdf cannot read the file (exit 2) and --show-encryption cannot either", [{ exitCode: 2 }, { exitCode: 2, stderr: "qpdf: upload.pdf: unable to find trailer dictionary" }], /could not settle the encryption \(exit 2\)/],
    ["qpdf errors on a damaged file (exit 2, warnings) and --show-encryption reports encryption", [{ exitCode: 2, stderr: "WARNING: file is damaged" }, { exitCode: 0, stdout: "R = 4\nP = -4\n" }], /exit 2\): WARNING: file is damaged/],
    ["--show-encryption says not encrypted but with a non-benign warning", [{ exitCode: 2 }, { exitCode: 3, stdout: "File is not encrypted\n", stderr: "WARNING: upload.pdf: ignoring excessively deeply nested data structure" }], /could not settle/],
    ["not encrypted, but the rewrite fails", [{ exitCode: 2 }, { exitCode: 0, stdout: "File is not encrypted\n" }, { exitCode: 2, stderr: "qpdf: operation failed" }], /--decrypt failed \(exit 2\)/],
    ["the check is killed (prlimit CPU, exit 137)", [{ exitCode: 137 }], /exit 137/],
    ["the decryption fails", [{ exitCode: 3 }, { exitCode: 2, stderr: "qpdf: operation failed" }], /--decrypt failed \(exit 2\)/],
    ["the copy hits RLIMIT_FSIZE (SIGXFSZ, exit 153)", [{ exitCode: 3 }, { exitCode: 153 }], /--decrypt failed \(exit 153\)/],
    ["qpdf reports success but wrote no copy", [{ exitCode: 3 }, { exitCode: 0 }], /decrypted copy missing/],
  ] as const)("%s: failed (fail closed)", async (_label, sequence, reason) => {
    replies = sequence.map((reply) => ({ ...reply }));
    expect(await decrypt()).toMatchObject({ status: "failed", reason: expect.stringMatching(reason) });
  });

  it("a copy at the output limit is refused even if qpdf was not stopped", async () => {
    const source = path.join(dir, "upload.pdf");
    await writeFile(source, "%PDF-1.7");
    const out = await mkdtemp(path.join(dir, "out-"));
    // The copy "qpdf" left behind, sized at the limit (sparse).
    await writeFile(path.join(out, "decrypted.pdf"), "");
    await truncate(path.join(out, "decrypted.pdf"), PDF_DECRYPT_LIMITS.maxOutputBytes);
    replies = [{ exitCode: 3 }, { exitCode: 0 }];
    expect(await new CommandRunner().decryptPdfForScan(source, out)).toMatchObject({ status: "failed", reason: expect.stringMatching(/reached the \d+-byte limit/) });
  });

  it("without qpdf in the VM image: failed, and no command runs", async () => {
    register(["prlimit"]);
    expect(await decrypt()).toMatchObject({ status: "failed", reason: "qpdf unavailable" });
    expect(commands).toHaveLength(0);
  });
});
