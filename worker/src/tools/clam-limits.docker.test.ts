import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, openSync, closeSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clamdConfig } from "../sandbox/providers/modal/scanner.js";
import { isClamLimitAlert } from "./clam-limits.js";
import { CommandRunner, parseClamSignature } from "./runner.js";

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
