import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDefaultParserSandbox } from "../sandbox/startup.js";
import type { ParserSandboxProvider, SandboxCommand } from "../sandbox/types.js";
import { clamdLimitLines } from "./clam-limits.js";
import { ClamdPolicyCache, crc32, encryptedZipCanary, nestedZipCanary, storedZip, verifyClamdPolicy, type ClamdProbeResult } from "./clamd-policy.js";
import { CommandRunner, resetLocalClamdPolicyCache } from "./runner.js";

const hasPython = spawnSync("python3", ["-I", "-c", "import zipfile"]).status === 0;

/** A daemon with our policy: encrypted canary and nested canary are detections, anything else is clean. */
function goodDaemon(file: string): ClamdProbeResult {
  if (file.endsWith("encrypted-canary.zip")) return { exitCode: 1, stdout: `${file}: Heuristics.Encrypted.Zip FOUND\n`, stderr: "" };
  if (file.endsWith("recursion-canary.zip")) return { exitCode: 1, stdout: `${file}: Heuristics.Limits.Exceeded.MaxRecursion FOUND\n`, stderr: "" };
  return { exitCode: 0, stdout: `${file}: OK\n`, stderr: "" };
}
/** A daemon started without the alert options: everything is OK (the council reproducer). */
const defaultDaemon = (file: string): ClamdProbeResult => ({ exitCode: 0, stdout: `${file}: OK\n`, stderr: "" });

describe("clamd policy canaries", () => {
  it("CRC-32 matches the standard check value", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it.skipIf(!hasPython)("the encrypted ZIP is a real ZipCrypto archive (python's zipfile needs the password and then reads it)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-zipcrypto-"));
    try {
      const file = path.join(dir, "known.zip");
      await writeFile(file, storedZip([{ name: "a.txt", data: Buffer.from("record quarter") }], Buffer.from("pw-123")));
      const script = "import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\ntry:\n    z.read('a.txt'); print('no password needed')\nexcept RuntimeError:\n    print(z.read('a.txt', pwd=b'pw-123').decode())";
      expect(execFileSync("python3", ["-I", "-c", script, file], { encoding: "utf8" }).trim()).toBe("record quarter");
      const canary = path.join(dir, "canary.zip");
      await writeFile(canary, encryptedZipCanary());
      expect(execFileSync("python3", ["-I", "-c", "import sys, zipfile\nprint(zipfile.ZipFile(sys.argv[1]).infolist()[0].flag_bits & 1)", canary], { encoding: "utf8" }).trim()).toBe("1");
      const nested = path.join(dir, "nested.zip");
      await writeFile(nested, nestedZipCanary(3));
      const depth = execFileSync("python3", ["-I", "-c", "import io, sys, zipfile\nd = open(sys.argv[1], 'rb').read(); n = 0\nwhile d[:2] == b'PK':\n    z = zipfile.ZipFile(io.BytesIO(d)); d = z.read(z.namelist()[0]); n += 1\nprint(n)", nested], { encoding: "utf8" }).trim();
      expect(depth).toBe("3");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("trusts a daemon that reports both canaries", async () => {
    expect(await verifyClamdPolicy(async (file) => goodDaemon(file))).toEqual({ trusted: true });
  });

  it("refuses a daemon that reports the encrypted canary clean (no AlertEncryptedArchive), not transiently", async () => {
    expect(await verifyClamdPolicy(async (file) => defaultDaemon(file))).toMatchObject({ trusted: false, transient: false, reason: expect.stringMatching(/encrypted ZIP canary.*clean/) });
  });

  it("refuses a daemon that alerts on encryption but not on limits (no AlertExceedsMax)", async () => {
    const verdict = await verifyClamdPolicy(async (file) => (file.endsWith("recursion-canary.zip") ? defaultDaemon(file) : goodDaemon(file)));
    expect(verdict).toMatchObject({ trusted: false, transient: false, reason: expect.stringMatching(/nested ZIP canary/) });
  });

  it("refuses other signatures, detections named for another file, and daemons that do not answer", async () => {
    expect(await verifyClamdPolicy(async (file) => ({ exitCode: 1, stdout: `${file}: Eicar-Test-Signature FOUND\n`, stderr: "" }))).toMatchObject({ trusted: false, transient: false });
    expect(await verifyClamdPolicy(async () => ({ exitCode: 1, stdout: "/elsewhere/other.zip: Heuristics.Encrypted.Zip FOUND\n", stderr: "" }))).toMatchObject({ trusted: false });
    expect(await verifyClamdPolicy(async () => ({ exitCode: 2, stdout: "", stderr: "ERROR: Could not connect to clamd" }))).toMatchObject({ trusted: false, transient: true });
    expect(await verifyClamdPolicy(async () => { throw new Error("spawn failed"); })).toMatchObject({ trusted: false, transient: true, reason: expect.stringMatching(/spawn failed/) });
  });

  it("caches verdicts per key for the TTL, re-verifies after it, never caches transient refusals, and stays bounded", async () => {
    let now = 0;
    const cache = new ClamdPolicyCache(() => 1_000, () => now, 2);
    const probe = vi.fn(async (file: string) => goodDaemon(file));
    expect(await cache.verify("a", probe)).toEqual({ trusted: true });
    expect(await cache.verify("a", probe)).toEqual({ trusted: true });
    expect(probe).toHaveBeenCalledTimes(2); // two canaries, one verification
    now = 1_000;
    await cache.verify("a", probe);
    expect(probe).toHaveBeenCalledTimes(4);
    cache.invalidate("a");
    await cache.verify("a", probe);
    expect(probe).toHaveBeenCalledTimes(6);

    const down = vi.fn(async (): Promise<ClamdProbeResult> => ({ exitCode: 2, stdout: "", stderr: "connect failed" }));
    expect(await cache.verify("b", down)).toMatchObject({ trusted: false, transient: true });
    await Promise.resolve();
    expect(await cache.verify("b", down)).toMatchObject({ trusted: false });
    expect(down).toHaveBeenCalledTimes(2);

    const bad = vi.fn(async (file: string) => defaultDaemon(file));
    await cache.verify("c", bad);
    await cache.verify("c", bad);
    expect(bad).toHaveBeenCalledTimes(1);
    await cache.verify("d", bad);
    await cache.verify("e", bad);
    expect(cache.size).toBeLessThanOrEqual(2);
  });
});

describe("local clamd scans verify the daemon's policy first (council re-check 2, H1)", () => {
  let dir: string;
  let commands: SandboxCommand[];
  let daemon: (file: string) => ClamdProbeResult;

  function register(tools: string[]) {
    const provider = {
      id: "test-local",
      openSession: async () => ({
        providerId: "test-local",
        isolation: { filesystem: true, network: "none", processes: true, location: "remote" },
        run: async (command: SandboxCommand) => {
          commands.push(command);
          const file = command.args.at(-1)!;
          if (command.binary.endsWith("clamdscan")) return { ...daemon(file), cpuSeconds: 0 };
          // clamscan with the per-command alert flags.
          expect(command.args).toEqual(expect.arrayContaining(["--alert-encrypted-archive=yes", "--alert-exceeds-max=yes"]));
          return { exitCode: 0, stdout: "", stderr: "", cpuSeconds: 0 };
        },
        close: async () => {},
      }),
    } as unknown as ParserSandboxProvider;
    setDefaultParserSandbox({ provider, config: {}, isolation: { filesystem: true, network: "none", processes: true, location: "remote" }, tools });
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-clamd-policy-"));
    commands = [];
    daemon = goodDaemon;
    resetLocalClamdPolicyCache();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "");
    vi.stubEnv("DOCSLURP_CLAMAV_DB_DIR", dir);
    vi.stubEnv("DOCSLURP_CLAMAV_REQUIRE_DAEMON", "false");
    await writeFile(path.join(dir, "daily.cvd"), "signatures");
    register(["clamdscan", "clamscan"]);
  });
  afterEach(async () => {
    setDefaultParserSandbox(undefined);
    resetLocalClamdPolicyCache();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function scan() {
    const source = path.join(dir, "upload.zip");
    await writeFile(source, "PK");
    return await new CommandRunner().scanForMalware(source);
  }
  const daemonScansOf = (name: string) => commands.filter((command) => command.binary.endsWith("clamdscan") && command.args.at(-1)!.endsWith(name)).length;

  it("a daemon whose canaries alert is used, and verified once per TTL, not per document", async () => {
    expect(await scan()).toMatchObject({ engine: "clamdscan", status: "clean" });
    expect(await scan()).toMatchObject({ engine: "clamdscan", status: "clean" });
    expect(daemonScansOf("encrypted-canary.zip")).toBe(1);
    expect(daemonScansOf("recursion-canary.zip")).toBe(1);
    expect(daemonScansOf("upload.zip")).toBe(2);
  });

  it("a daemon without the alert options is never used: the scan falls back to clamscan with the alert flags, loudly", async () => {
    daemon = defaultDaemon;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await scan();
    expect(result).toMatchObject({ engine: "clamscan", status: "clean" });
    expect(result.healthWarnings.join("\n")).toMatch(/clamd refused: encrypted ZIP canary/);
    expect(daemonScansOf("upload.zip")).toBe(0);
    expect(errors.mock.calls.flat().join("\n")).toMatch(/status=clamd-policy-refused/);
  });

  it("with no clamscan to fall back on, a refused daemon is an error verdict, never clean or skipped", async () => {
    register(["clamdscan"]);
    daemon = defaultDaemon;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await scan();
    expect(result).toMatchObject({ status: "error", engine: null });
    expect(result.stderr).toMatch(/effective policy could not be verified/);
    expect(daemonScansOf("upload.zip")).toBe(0);
  });

  it("DOCSLURP_CLAMAV_REQUIRE_DAEMON with a refused daemon is an error verdict", async () => {
    vi.stubEnv("DOCSLURP_CLAMAV_REQUIRE_DAEMON", "true");
    daemon = defaultDaemon;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await scan()).toMatchObject({ status: "error", engine: null });
    expect(commands.filter((command) => command.binary.endsWith("clamscan"))).toHaveLength(0);
  });

  it("a daemon that stops answering is re-verified, so one restarted without the options is refused", async () => {
    expect(await scan()).toMatchObject({ engine: "clamdscan", status: "clean" });
    // The daemon goes away mid-run (restart): the scan is an error, and its verified policy is forgotten.
    daemon = () => ({ exitCode: 2, stdout: "", stderr: "ERROR: Could not connect to clamd on LocalSocket" });
    expect(await scan()).toMatchObject({ status: "error" });
    // It comes back with the distribution's default config.
    daemon = defaultDaemon;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await scan()).toMatchObject({ engine: "clamscan" });
    expect(daemonScansOf("encrypted-canary.zip")).toBe(2);
  });
});

describe("worker/scripts/apply-clamd-policy.sh (the worker image's clamd.conf)", () => {
  const script = fileURLToPath(new URL("../../scripts/apply-clamd-policy.sh", import.meta.url));

  it("applies exactly clamdLimitLines(), replacing the distribution's settings (Debian: MaxFileSize 25M, no AlertExceedsMax)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-clamd-conf-"));
    try {
      const conf = path.join(dir, "clamd.conf");
      await writeFile(conf, ["LocalSocket /tmp/clamav/clamd.ctl", "ArchiveBlockEncrypted false", "#AlertEncrypted no", "MaxScanSize 100M", "MaxFileSize 25M", "MaxRecursion 16", "StreamMaxLength 25M", "# MaxFiles 10000", "ScanPDF true", ""].join("\n"));
      execFileSync("sh", [script, conf]);
      const lines = (await readFile(conf, "utf8")).split("\n").filter(Boolean);
      expect(lines).toEqual(["LocalSocket /tmp/clamav/clamd.ctl", "ScanPDF true", ...clamdLimitLines()]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
