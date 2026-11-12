import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clamdConfig } from "../sandbox/providers/modal/scanner.js";
import { isClamLimitAlert } from "./clam-limits.js";
import { CommandRunner, clamDetection, parseClamSignature } from "./runner.js";

/**
 * Real ClamAV against the council M2 reproducer: files over libclamav's default 100 MB MaxFileSize. Opt-in, because it
 * scans about 1 GB in a container: set DOCSLURP_CLAMAV_DOCKER_IMAGE to an image with clamscan, clamd and signatures in
 * /var/lib/clamav (the worker image). Runs with no network, as the caller's uid.
 */
const image = process.env.DOCSLURP_CLAMAV_DOCKER_IMAGE?.trim();
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
// A body signature (matches anywhere), so detection proves the bytes past 100 MB were scanned. EICAR itself is a
// whole-file hash: padding it hides it from any scan, so it is used only inside an archive.
const MARKER = "DOCSLURP-M2-TEST-MARKER-0123456789abcdef";

function padded(file: string, zeroBytes: number, tail: string) {
  const fd = openSync(file, "w");
  const chunk = Buffer.alloc(1024 * 1024);
  for (let left = zeroBytes; left > 0; left -= chunk.length) writeSync(fd, chunk, 0, Math.min(left, chunk.length));
  writeSync(fd, Buffer.from(tail));
  closeSync(fd);
}

describe.skipIf(!image)("real ClamAV over 100 MB (council M2)", () => {
  let dir: string;
  const docker = (args: string[]) => spawnSync("docker", ["run", "--rm", "--network", "none", "--user", `${process.getuid!()}:${process.getgid!()}`, "--cpus", "2", "--memory", "4g", "-v", `${dir}:/work`, "--entrypoint", ...args], { encoding: "utf8", timeout: 600_000 });

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "docslurp-clam-m2-"));
    padded(path.join(dir, "marker-after-110mb.bin"), 110_000_000, MARKER);
    writeFileSync(path.join(dir, "marker.ndb"), `Docslurp.Test.M2Marker:0:*:${Buffer.from(MARKER).toString("hex")}\n`);
    // EICAR inside a stored 110 MB ZIP, written by the host's python (zipfile), never by a parser under test.
    execFileSync("python3", ["-I", "-c", [
      "import sys, zipfile",
      "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_STORED) as z:",
      "    z.writestr('notes/eicar.com', sys.argv[2])",
      "    with z.open('media/big.bin', 'w', force_zip64=True) as f:",
      "        for _ in range(110): f.write(b'\\0' * 1000000)",
    ].join("\n"), path.join(dir, "eicar-in-110mb.zip"), EICAR]);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function clamscan(file: string, override?: (args: string[]) => string[]) {
    const plan = await new CommandRunner().clamScan(`/work/${file}`);
    const args = override ? override(plan.args) : plan.args;
    const result = docker(["clamscan", image!, "-d", "/var/lib/clamav", "-d", "/work/marker.ndb", ...args]);
    return { code: result.status, signature: parseClamSignature(result.stdout), stdout: result.stdout };
  }
  const withoutLimits = (args: string[]) => args.filter((arg) => !/^--(max-|alert-exceeds-max)/.test(arg));

  it("before the fix: libclamav's defaults skip both files and report them clean", async () => {
    expect(await clamscan("marker-after-110mb.bin", withoutLimits)).toMatchObject({ code: 0, signature: null });
    expect(await clamscan("eicar-in-110mb.zip", withoutLimits)).toMatchObject({ code: 0, signature: null });
  }, 600_000);

  it("the per-command plan scans past 100 MB and detects both", async () => {
    expect(await clamscan("marker-after-110mb.bin")).toMatchObject({ code: 1, signature: "Docslurp.Test.M2Marker.UNOFFICIAL" });
    expect(await clamscan("eicar-in-110mb.zip")).toMatchObject({ code: 1, signature: "Eicar-Test-Signature" });
  }, 600_000);

  it("a file still over a limit is a Limits.Exceeded detection (exit 1), not clean", async () => {
    const result = await clamscan("marker-after-110mb.bin", (args) => args.map((arg) => arg.startsWith("--max-filesize=") ? "--max-filesize=50M" : arg.startsWith("--max-scansize=") ? "--max-scansize=50M" : arg));
    expect(result.code).toBe(1);
    expect(result.signature).toBe("Heuristics.Limits.Exceeded.MaxFileSize");
    expect(isClamLimitAlert(result.signature)).toBe(true);
  }, 600_000);

  it("the scanner VMs' clamd config detects EICAR inside the 110 MB ZIP through clamdscan --fdpass", () => {
    // The production config, with only the paths and the daemon user adapted to an unprivileged container.
    const config = clamdConfig("/var/lib/clamav").split("\n")
      .filter((line) => !line.startsWith("User "))
      .map((line) => line.replace(/^LocalSocket .*/, "LocalSocket /work/clamd.sock").replace(/^TemporaryDirectory .*/, "TemporaryDirectory /work"))
      .join("\n");
    writeFileSync(path.join(dir, "clamd.conf"), config);
    const script = [
      "clamd --config-file=/work/clamd.conf || exit 9",
      "clamdscan --config-file=/work/clamd.conf --fdpass --no-summary --infected /work/eicar-in-110mb.zip; echo \"exit=$?\"",
    ].join("\n");
    const result = docker(["sh", image!, "-c", script]);
    expect(result.stdout).toContain("Eicar-Test-Signature FOUND");
    expect(result.stdout).toContain("exit=1");
  }, 600_000);
});

/**
 * Council re-check H1: encrypted content. Without the encryption alerts, libclamav skips what it cannot decrypt and reports
 * it clean: an EICAR in a password-protected ZIP nested in a plain ZIP, and a PDF that needs a user password, both exited 0
 * on both paths. Fixtures are written by the host's qpdf, zip and python, never by a parser under test.
 */
describe.skipIf(!image)("real ClamAV on encrypted content (council re-check H1)", () => {
  let dir: string;
  const docker = (args: string[]) => spawnSync("docker", ["run", "--rm", "--network", "none", "--user", `${process.getuid!()}:${process.getgid!()}`, "--cpus", "2", "--memory", "4g", "-v", `${dir}:/work`, "--entrypoint", ...args], { encoding: "utf8", timeout: 600_000 });
  const files = {
    "user-password.pdf": "unscannable",
    "user-password-rc4.pdf": "unscannable",
    "encrypted.zip": "unscannable",
    "nested-encrypted.zip": "unscannable",
    "owner-only.pdf": "clean",
    "owner-only-restricted.pdf": "clean",
    "owner-only-rc4.pdf": "clean",
    "plain.pdf": "clean",
    "plain.docx": "clean",
    "plain.png": "clean",
    "eicar.com": "infected",
  } as const;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "docslurp-clam-h1-"));
    const at = (name: string) => path.join(dir, name);
    const source = fileURLToPath(new URL("../../testdata/pdf-fixtures/academic-latex-ligatures.pdf", import.meta.url));
    execFileSync("qpdf", [source, at("plain.pdf")]);
    execFileSync("qpdf", ["--encrypt", "user-secret", "owner-secret", "256", "--", source, at("user-password.pdf")]);
    execFileSync("qpdf", ["--allow-weak-crypto", "--encrypt", "user-secret", "owner-secret", "128", "--", source, at("user-password-rc4.pdf")]);
    // Owner password only (empty user password): the common "permissions" PDF anyone can open.
    execFileSync("qpdf", ["--encrypt", "", "owner-secret", "256", "--", source, at("owner-only.pdf")]);
    execFileSync("qpdf", ["--encrypt", "", "owner-secret", "256", "--print=none", "--modify=none", "--extract=n", "--", source, at("owner-only-restricted.pdf")]);
    execFileSync("qpdf", ["--allow-weak-crypto", "--encrypt", "", "owner-secret", "128", "--", source, at("owner-only-rc4.pdf")]);
    writeFileSync(at("eicar.com"), EICAR);
    execFileSync("zip", ["-q", "-j", "-P", "zip-secret", at("encrypted.zip"), at("eicar.com")]);
    execFileSync("python3", ["-I", "-c", [
      "import sys, zipfile",
      "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_STORED) as z:",
      "    z.write(sys.argv[2], 'inner/encrypted.zip')",
      "with zipfile.ZipFile(sys.argv[3], 'w', zipfile.ZIP_DEFLATED) as z:",
      "    z.writestr('[Content_Types].xml', '<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>')",
      "    z.writestr('word/document.xml', '<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>Quarterly earnings beat</w:t></w:r></w:p></w:body></w:document>')",
    ].join("\n"), at("nested-encrypted.zip"), at("encrypted.zip"), at("plain.docx")]);
    // A valid 1x1 PNG.
    writeFileSync(at("plain.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const verdict = (code: number | null, stdout: string, stderr: string) =>
    code === 0 ? "clean" : code === 1 ? clamDetection(stdout, stderr).status : `error:${code}`;

  it("the per-command clamscan plan: encrypted content is unscannable, owner-only PDFs and plain files are clean", async () => {
    const lines: string[] = [];
    for (const file of Object.keys(files)) {
      const plan = await new CommandRunner().clamScan(`/work/${file}`);
      const result = docker(["clamscan", image!, "-d", "/var/lib/clamav", ...plan.args]);
      lines.push(`${file} ${verdict(result.status, result.stdout, result.stderr)}`);
    }
    expect(lines).toEqual(Object.entries(files).map(([file, expected]) => `${file} ${expected}`));
  }, 600_000);

  it("the scanner VMs' clamd config gives the same verdicts through clamdscan --fdpass", () => {
    const config = clamdConfig("/var/lib/clamav").split("\n")
      .filter((line) => !line.startsWith("User "))
      .map((line) => line.replace(/^LocalSocket .*/, "LocalSocket /work/clamd.sock").replace(/^TemporaryDirectory .*/, "TemporaryDirectory /work"))
      .join("\n");
    writeFileSync(path.join(dir, "clamd.conf"), config);
    const script = [
      "clamd --config-file=/work/clamd.conf || exit 9",
      ...Object.keys(files).map((file) => `clamdscan --config-file=/work/clamd.conf --fdpass --no-summary --infected /work/${file} > /work/${file}.out 2>&1; echo "${file} $?"`),
    ].join("\n");
    const result = docker(["sh", image!, "-c", script]);
    const lines = result.stdout.trim().split("\n").map((line) => {
      const [file, code] = line.split(" ");
      const out = readFileSync(path.join(dir, `${file}.out`), "utf8");
      return `${file} ${verdict(Number(code), out, "")}`;
    });
    expect(lines).toEqual(Object.entries(files).map(([file, expected]) => `${file} ${expected}`));
  }, 600_000);

  it("the self-host image's /etc/clamav/clamd.conf, edited as worker/Dockerfile does, alerts on encrypted content", () => {
    const script = [
      "cp /etc/clamav/clamd.conf /work/selfhost.conf",
      // The Dockerfile's edit (keep in sync with worker/Dockerfile).
      "sed -ri '/^#?(ArchiveBlockEncrypted|AlertEncrypted(Archive|Doc)?)[[:space:]]/d' /work/selfhost.conf",
      "printf 'AlertEncryptedArchive yes\\nAlertEncryptedDoc yes\\n' >> /work/selfhost.conf",
      // Unprivileged test adaptations: socket, pid and temp paths, no user switch, foreground off.
      "sed -ri '/^#?(User|LocalSocket|LocalSocketGroup|PidFile|TemporaryDirectory|LogFile|Foreground|DatabaseDirectory)[[:space:]]/d' /work/selfhost.conf",
      "printf 'LocalSocket /work/selfhost.sock\\nTemporaryDirectory /work\\nDatabaseDirectory /var/lib/clamav\\nForeground no\\n' >> /work/selfhost.conf",
      "clamd --config-file=/work/selfhost.conf || exit 9",
      "for f in nested-encrypted.zip user-password.pdf owner-only.pdf; do clamdscan --config-file=/work/selfhost.conf --fdpass --no-summary /work/$f; echo \"exit=$?\"; done",
    ].join("\n");
    const result = docker(["sh", image!, "-c", script]);
    expect(result.stdout).toContain("/work/nested-encrypted.zip: Heuristics.Encrypted.Zip FOUND");
    expect(result.stdout).toContain("/work/user-password.pdf: Heuristics.Encrypted.PDF FOUND");
    expect(result.stdout).toContain("/work/owner-only.pdf: OK");
  }, 600_000);
});
