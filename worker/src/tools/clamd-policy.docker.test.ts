import { execFile, execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setDefaultParserSandbox } from "../sandbox/startup.js";
import type { ParserSandboxProvider, SandboxCommand } from "../sandbox/types.js";
import { flatePdfCanary } from "./clamd-policy.js";
import { CommandRunner, resetLocalClamdPolicyCache } from "./runner.js";

/**
 * Council re-check 2, H1, with real ClamAV: the runner's local-daemon path (CommandRunner.scanForMalware outside production)
 * against a running clamd. A test sandbox provider runs each planned command in one container (`docker exec`), where two
 * daemons run: one started with the council reproducer's config (sockets and paths only, no alert options), and one with
 * the worker image's config after scripts/apply-clamd-policy.sh. The test directory is mounted at the same path, and
 * TMPDIR points into it, so the canaries the runner writes are visible to the daemons.
 *
 * Opt-in: DOCSLURP_CLAMAV_DOCKER_IMAGE (the worker image). No network, the caller's uid.
 */
const image = process.env.DOCSLURP_CLAMAV_DOCKER_IMAGE?.trim();
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

describe.skipIf(!image)("real clamd: the local daemon is trusted only after its canaries (council re-check 2, H1)", () => {
  let dir: string;
  let container: string;
  let commands: SandboxCommand[];

  const exec = (args: string[]) => new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile("docker", ["exec", container, ...args], { encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null) : 0;
      resolve({ exitCode: code, stdout, stderr });
    });
  });

  function register(tools: string[]) {
    const provider = {
      id: "docker-clamav",
      openSession: async () => ({
        providerId: "docker-clamav",
        isolation: { filesystem: true, network: "none", processes: true, location: "remote" },
        run: async (command: SandboxCommand) => {
          commands.push(command);
          return { ...(await exec([path.basename(command.binary), ...command.args])), cpuSeconds: 0 };
        },
        close: async () => {},
      }),
    } as unknown as ParserSandboxProvider;
    setDefaultParserSandbox({ provider, config: {}, isolation: { filesystem: true, network: "none", processes: true, location: "remote" }, tools });
  }

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "docslurp-clamd-policy-docker-"));
    mkdirSync(path.join(dir, "tmp"));
    mkdirSync(path.join(dir, "hostdb"));
    writeFileSync(path.join(dir, "hostdb", "daily.cvd"), "signatures"); // host-side freshness only
    writeFileSync(path.join(dir, "eicar.com"), EICAR);
    writeFileSync(path.join(dir, "note.txt"), "Quarterly results beat the forecast.\n");
    writeFileSync(path.join(dir, "eicar-flate.pdf"), flatePdfCanary());
    execFileSync("zip", ["-q", "-j", "-P", "zip-secret", path.join(dir, "encrypted.zip"), path.join(dir, "eicar.com")]);
    copyFileSync(fileURLToPath(new URL("../../scripts/apply-clamd-policy.sh", import.meta.url)), path.join(dir, "apply-clamd-policy.sh"));
    // The council reproducer's daemon: sockets and paths only.
    writeFileSync(path.join(dir, "default.conf"), `LocalSocket ${dir}/default.sock\nTemporaryDirectory ${dir}/tmp\nDatabaseDirectory /var/lib/clamav\nForeground no\n`);
    const started = spawnSync("docker", ["run", "-d", "--rm", "--network", "none", "--user", `${process.getuid!()}:${process.getgid!()}`, "--cpus", "2", "--memory", "6g", "-v", `${dir}:${dir}`, "--entrypoint", "sleep", image!, "infinity"], { encoding: "utf8" });
    if (started.status !== 0) throw new Error(`container did not start: ${started.stderr}`);
    container = started.stdout.trim();
    const setup = [
      `cp /etc/clamav/clamd.conf ${dir}/image.conf`,
      `sh ${dir}/apply-clamd-policy.sh ${dir}/image.conf`,
      `sed -ri '/^#?(User|LocalSocket|LocalSocketGroup|PidFile|TemporaryDirectory|LogFile|Foreground)[[:space:]]/d' ${dir}/image.conf`,
      `printf 'LocalSocket ${dir}/image.sock\\nTemporaryDirectory ${dir}/tmp\\nForeground no\\n' >> ${dir}/image.conf`,
      // Council re-check 4, M2: the image's policy with PDF scanning off (every alert option still on).
      `sed -e '/^ScanPDF[[:space:]]/d' -e 's#^LocalSocket .*#LocalSocket ${dir}/weakpdf.sock#' ${dir}/image.conf > ${dir}/weakpdf.conf`,
      `printf 'ScanPDF no\\n' >> ${dir}/weakpdf.conf`,
      `clamd --config-file=${dir}/default.conf || exit 9`,
      `clamd --config-file=${dir}/image.conf || exit 9`,
      `clamd --config-file=${dir}/weakpdf.conf || exit 9`,
    ].join("\n");
    const ready = spawnSync("docker", ["exec", container, "sh", "-c", setup], { encoding: "utf8", timeout: 600_000 });
    if (ready.status !== 0) throw new Error(`daemons did not start: ${ready.stderr}`);
  }, 900_000);
  afterAll(() => {
    if (container) spawnSync("docker", ["rm", "-f", container]);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    commands = [];
    resetLocalClamdPolicyCache();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "");
    vi.stubEnv("TMPDIR", path.join(dir, "tmp"));
    vi.stubEnv("DOCSLURP_CLAMAV_DB_DIR", path.join(dir, "hostdb"));
    vi.stubEnv("DOCSLURP_CLAMAV_REQUIRE_DAEMON", "false");
    vi.spyOn(console, "error").mockImplementation(() => {});
    register(["clamdscan", "clamscan"]);
  });
  afterEach(() => {
    setDefaultParserSandbox(undefined);
    resetLocalClamdPolicyCache();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const scan = (file: string) => new CommandRunner().scanForMalware(path.join(dir, file));
  const daemonScanned = (file: string) => commands.some((command) => command.binary.endsWith("clamdscan") && command.args.at(-1) === path.join(dir, file));

  it("precondition (the reviewer's reproducer): the default-config daemon reports the encrypted ZIP OK", async () => {
    const result = await exec(["clamdscan", `--config-file=${dir}/default.conf`, "--fdpass", "--no-summary", path.join(dir, "encrypted.zip")]);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain("encrypted.zip: OK");
  }, 120_000);

  it("a daemon lacking the options is refused: the encrypted ZIP goes to clamscan with the alert flags and is unscannable, not clean", async () => {
    vi.stubEnv("DOCSLURP_CLAMAV_CLAMD_CONF", `${dir}/default.conf`);
    const result = await scan("encrypted.zip");
    expect(result).toMatchObject({ engine: "clamscan", status: "unscannable", signature: "Heuristics.Encrypted.Zip" });
    expect(result.healthWarnings.join("\n")).toMatch(/clamd refused: encrypted ZIP canary was not reported/);
    expect(daemonScanned("encrypted.zip")).toBe(false);
    expect(await scan("note.txt")).toMatchObject({ engine: "clamscan", status: "clean" });
  }, 600_000);

  it("a daemon lacking the options with no clamscan to fall back on is an error verdict, never clean", async () => {
    vi.stubEnv("DOCSLURP_CLAMAV_CLAMD_CONF", `${dir}/default.conf`);
    register(["clamdscan"]);
    const result = await scan("encrypted.zip");
    expect(result).toMatchObject({ status: "error", engine: null });
    expect(daemonScanned("encrypted.zip")).toBe(false);
  }, 600_000);

  it("council re-check 4, M2: a daemon with ScanPDF off (alert options on) is refused, and the Flate PDF it would pass goes to clamscan", async () => {
    const direct = await exec(["clamdscan", `--config-file=${dir}/weakpdf.conf`, "--fdpass", "--no-summary", path.join(dir, "eicar-flate.pdf")]);
    expect(direct).toMatchObject({ exitCode: 0 }); // the reproducer: that daemon reports it OK
    vi.stubEnv("DOCSLURP_CLAMAV_CLAMD_CONF", `${dir}/weakpdf.conf`);
    const result = await scan("eicar-flate.pdf");
    expect(result).toMatchObject({ engine: "clamscan", status: "infected", signature: "Eicar-Test-Signature" });
    expect(result.healthWarnings.join("\n")).toMatch(/clamd refused: pdf content canary/);
    expect(daemonScanned("eicar-flate.pdf")).toBe(false);
  }, 600_000);

  it("the worker image's daemon (apply-clamd-policy.sh) passes its canaries and is used", async () => {
    vi.stubEnv("DOCSLURP_CLAMAV_CLAMD_CONF", `${dir}/image.conf`);
    expect(await scan("encrypted.zip")).toMatchObject({ engine: "clamdscan", status: "unscannable", signature: "Heuristics.Encrypted.Zip" });
    expect(await scan("eicar.com")).toMatchObject({ engine: "clamdscan", status: "infected", signature: "Eicar-Test-Signature" });
    expect(await scan("note.txt")).toMatchObject({ engine: "clamdscan", status: "clean" });
    expect(daemonScanned("encrypted.zip")).toBe(true);
    // Verified once for the three scans.
    expect(commands.filter((command) => command.args.at(-1)!.endsWith("encrypted-canary.zip"))).toHaveLength(1);
  }, 600_000);
});
