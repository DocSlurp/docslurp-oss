import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWithPerfContext } from "../lib/perf-context.js";
import { setDefaultParserSandbox } from "../sandbox/startup.js";
import { SandboxPolicyError, type ParserSandboxProvider, type SandboxCommand, type SandboxSessionContext } from "../sandbox/types.js";
import { CLAM_SCAN_COMMAND_TIMEOUT_MS, CLAM_SCAN_LIMITS, clamdLimitLines, clamscanLimitArgs, isClamEncryptedAlert, isClamLimitAlert } from "./clam-limits.js";
import { clamdConfig } from "../sandbox/providers/modal/scanner.js";
import { CommandRunner, clamDetection, parseClamDefinitionsHeader, readClamDefinitionsHeader } from "./runner.js";

/** A ClamAV database header (cvd/cld layout), stime in seconds. */
function header(version: number, stimeSeconds: number): string {
  return `ClamAV-VDB:11 Nov 2026 06-24 +0000:${version}:355854:90:46775b42909810433d77386e7ab35b2e:sig:svc.clamav-publisher:${stimeSeconds}`.padEnd(512, " ");
}

describe("ClamAV definitions header (host-side freshness)", () => {
  it("reads the daily version and signature time clamscan --version prints", () => {
    // `clamscan --version` printed `ClamAV 1.4.6/28180/Wed Nov 11 06:24:27 2026` for this header (live Modal check).
    expect(parseClamDefinitionsHeader(header(28180, 1794378267))).toEqual({ version: 28180, signatureTimeMs: Date.UTC(2026, 10, 11, 6, 24, 27) });
  });

  it.each([
    ["not a database", "PK\u0003\u0004 zip bytes"],
    ["too few fields", "ClamAV-VDB:11 Nov 2026:28180:1"],
    ["a non-numeric version", header(0, 1794378267).replace(":0:", ":x:")],
    ["a missing signature time", "ClamAV-VDB:11 Nov 2026 06-24 +0000:28180:1:90:md5:sig:builder:"],
  ])("refuses %s", (_label, text) => {
    expect(parseClamDefinitionsHeader(text)).toBeNull();
  });

  it("reads the newer of daily.cld and daily.cvd, as ClamAV loads it, and refuses when no daily file is staged", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-clam-header-"));
    try {
      await writeFile(path.join(dir, "daily.cvd"), header(1, 1_700_000_000));
      await writeFile(path.join(dir, "daily.cld"), header(2, 1_700_000_000));
      await writeFile(path.join(dir, "main.cvd"), header(3, 1_700_000_000));
      const files = [path.join(dir, "main.cvd"), path.join(dir, "daily.cvd"), path.join(dir, "daily.cld")];
      expect((await readClamDefinitionsHeader(files)).version).toBe(2);
      // A stale cld left next to a newer cvd (council L3): the cvd is what loads.
      await writeFile(path.join(dir, "daily.cvd"), header(5, 1_700_000_000));
      expect((await readClamDefinitionsHeader(files)).version).toBe(5);
      await writeFile(path.join(dir, "daily.cld"), "garbage");
      await expect(readClamDefinitionsHeader(files)).rejects.toThrow(/malformed/);
      await expect(readClamDefinitionsHeader([path.join(dir, "main.cvd")])).rejects.toThrow(/daily signatures are not staged/);
      await writeFile(path.join(dir, "daily.cvd"), "garbage");
      await expect(readClamDefinitionsHeader([path.join(dir, "daily.cvd")])).rejects.toThrow(/malformed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("malware scans in a scanner session", () => {
  let dir: string;
  let contexts: SandboxSessionContext[];
  let commands: SandboxCommand[];
  let exit: number;
  let stdout: string;

  function register(id = "modal") {
    const provider = {
      id,
      openSession: async (_config: unknown, context: SandboxSessionContext) => {
        contexts.push(context);
        return {
          providerId: id,
          isolation: { filesystem: true, network: "full", processes: true, location: "remote" },
          run: async (command: SandboxCommand) => {
            commands.push(command);
            // The provider's own check (providers/modal/index.ts) is covered in modal-staging.test.ts; mirrored here.
            if (context.scanner && command.tenantKey !== context.scanner.tenantKey) throw new SandboxPolicyError("scanner session refuses a command of another organization (or of none)");
            return { exitCode: exit, stdout, stderr: "", cpuSeconds: 0 };
          },
          close: async () => {},
        };
      },
    } as unknown as ParserSandboxProvider;
    setDefaultParserSandbox({ provider, config: {}, isolation: { filesystem: true, network: "full", processes: true, location: "remote" }, tools: ["clamdscan", "clamscan"] });
  }

  async function stage(stimeSeconds: number) {
    await writeFile(path.join(dir, "daily.cvd"), header(28180, stimeSeconds));
    await writeFile(path.join(dir, "main.cvd"), header(62, stimeSeconds));
  }

  const inOrg = <T>(orgId: string, fn: () => Promise<T>) => runWithPerfContext({ runId: "run", documentId: "doc", orgId, scope: "document", stageName: "quarantine", pushPerformance: () => {}, pushUsage: () => {} }, fn);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-scanner-scan-"));
    contexts = []; commands = []; exit = 0; stdout = "";
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DOCSLURP_CLAMAV_DB_DIR", dir);
    vi.stubEnv("DOCSLURP_QUARANTINE_SCAN_SNAPSHOT", "on");
    register();
    await stage(Math.floor(Date.now() / 1000) - 3600);
  });
  afterEach(async () => {
    setDefaultParserSandbox(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function scan(orgId = "org-a", sessionOrg: string | null = "org-a") {
    const source = path.join(dir, "upload.pdf");
    await writeFile(source, "%PDF-1.4");
    return await inOrg(orgId, () => new CommandRunner().withMalwareScanner(sessionOrg, () => new CommandRunner().scanForMalware(source)));
  }

  it("opens a scanner session keyed by the staged signature set, and runs clamdscan --fdpass there with the run's organization", async () => {
    const result = await scan();
    expect(result).toMatchObject({ status: "clean", engine: "clamdscan", databaseStatus: "fresh" });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.scanner).toMatchObject({ tenantKey: "org-a", expectedVersion: 28180 });
    expect(contexts[0]!.scanner!.signatureSetHash).toMatch(/^[0-9a-f]{64}$/);
    // One command, no version-check VM command: freshness came from the host header.
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ binary: "clamdscan", tenantKey: "org-a", requiresScanner: true });
    expect(commands[0]!.args).toEqual(expect.arrayContaining(["--fdpass", "--no-summary", "--infected"]));
  });

  it("an authored EICAR verdict (exit 1) is infected, with its signature", async () => {
    exit = 1; stdout = "/tmp/upload.pdf: Eicar-Test-Signature FOUND\n";
    expect(await scan()).toMatchObject({ status: "infected", signature: "Eicar-Test-Signature" });
  });

  it("a limit alert from clamd (AlertExceedsMax) is not clean: exit 1 with its Heuristics.Limits signature (council M2)", async () => {
    exit = 1; stdout = "/tmp/upload.pdf: Heuristics.Limits.Exceeded.MaxFileSize FOUND\n";
    expect(await scan()).toMatchObject({ status: "infected", signature: "Heuristics.Limits.Exceeded.MaxFileSize" });
    expect(commands[0]!.limits.timeoutMs).toBeGreaterThanOrEqual(CLAM_SCAN_COMMAND_TIMEOUT_MS);
  });

  it("an encrypted-content alert from clamd is unscannable, not infected and not clean (council re-check H1)", async () => {
    exit = 1; stdout = "/tmp/upload.pdf: Heuristics.Encrypted.PDF FOUND\n";
    expect(await scan()).toMatchObject({ status: "unscannable", signature: "Heuristics.Encrypted.PDF" });
  });

  it("M1: the scanner session is opened for one document (its activity names the document)", async () => {
    await scan();
    expect(contexts[0]!.activityId).toBe("scanner:run:doc");
  });

  it.each([2, null])("a scanner failure (exit %s) is an error verdict, never clean or skipped (fail closed)", async (code) => {
    exit = code as number;
    expect((await scan()).status).toBe("error");
  });

  it("stale signatures fail closed before any VM command runs", async () => {
    await stage(Math.floor(Date.now() / 1000) - 48 * 3600);
    const result = await scan();
    expect(result.status).toBe("error");
    expect(result.databaseStatus).toBe("stale");
    expect(commands).toHaveLength(0);
  });

  it("a header dated in the future is not fresh (fail closed)", async () => {
    await stage(Math.floor(Date.now() / 1000) + 3 * 3600);
    expect((await scan()).status).toBe("error");
    expect(commands).toHaveLength(0);
  });

  it("a document of another organization in the session is refused (cross-tenant batch)", async () => {
    await expect(scan("org-b", "org-a")).rejects.toThrow(/another organization/);
  });

  it("refuses to open a scanner session without the run's organization", async () => {
    await expect(scan("org-a", null)).rejects.toBeInstanceOf(SandboxPolicyError);
    expect(contexts).toHaveLength(0);
  });

  it("with the flag off, no scanner session is opened", async () => {
    vi.stubEnv("DOCSLURP_QUARANTINE_SCAN_SNAPSHOT", "off");
    const ran = await new CommandRunner().withMalwareScanner("org-a", async () => "ran");
    expect(ran).toBe("ran");
    expect(contexts).toHaveLength(0);
  });

  it("a provider without scanner sessions keeps the per-command path, loudly", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    register("bubblewrap");
    expect(await new CommandRunner().withMalwareScanner("org-a", async () => "ran")).toBe("ran");
    expect(contexts).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("scanner-snapshot-unsupported"));
  });
});

describe("ClamAV scan limits (council M2: files over 100 MB scanned clean)", () => {
  const MiB = 1024 * 1024;
  const bytes = (size: string) => Number(size.replace(/M$/, "")) * MiB;

  it("covers every byte quarantine downloads (default upload 500 MiB, download cap 512 MiB) and stays within libclamav's 2 GiB", () => {
    expect(bytes(CLAM_SCAN_LIMITS.maxFileSize)).toBeGreaterThanOrEqual(512 * MiB);
    expect(bytes(CLAM_SCAN_LIMITS.maxScanSize)).toBeGreaterThanOrEqual(bytes(CLAM_SCAN_LIMITS.maxFileSize));
    expect(bytes(CLAM_SCAN_LIMITS.maxScanSize)).toBeLessThan(2048 * MiB);
    expect(CLAM_SCAN_COMMAND_TIMEOUT_MS).toBeGreaterThan(CLAM_SCAN_LIMITS.maxScanTimeMs);
  });

  it("the per-command clamscan plan (flags off, today's production path) applies the limits and alerts on any limit hit", async () => {
    // Reviewer's reproducer shape: an EICAR followed by more than 100 MB of padding. Before the fix clamscan ran with
    // libclamav's 100 MB MaxFileSize, skipped the file and exited 0 (clean).
    const plan = await new CommandRunner().clamScan("/tmp/docslurp-quarantine-eicar-110mb.bin");
    expect(plan.args).toEqual(expect.arrayContaining(clamscanLimitArgs()));
    expect(plan.args).toContain("--alert-exceeds-max=yes");
    expect(plan.args).toContain("--max-filesize=1024M");
    expect(plan.args.at(-1)).toBe("/tmp/docslurp-quarantine-eicar-110mb.bin");
    expect(plan.timeoutMs).toBeGreaterThanOrEqual(CLAM_SCAN_COMMAND_TIMEOUT_MS);
  });

  it("the scanner VMs' clamd config carries the same limits and AlertExceedsMax", () => {
    const config = clamdConfig("/opt/docslurp-assets/clam-x");
    for (const line of clamdLimitLines()) expect(config.split("\n")).toContain(line);
    expect(config).toMatch(/^AlertExceedsMax yes$/m);
    expect(config).toMatch(/^MaxFileSize 1024M$/m);
    expect(config).toMatch(/^StreamMaxLength 1024M$/m);
  });

  it("both scan paths alert on encrypted archives and documents (council re-check H1)", async () => {
    const plan = await new CommandRunner().clamScan("/tmp/upload.zip");
    expect(plan.args).toEqual(expect.arrayContaining(["--alert-encrypted-archive=yes", "--alert-encrypted-doc=yes"]));
    const config = clamdConfig("/opt/docslurp-assets/clam-x").split("\n");
    expect(config).toEqual(expect.arrayContaining(["AlertEncryptedArchive yes", "AlertEncryptedDoc yes"]));
  });

  it("recognizes ClamAV's encrypted-content alerts and nothing else", () => {
    expect(isClamEncryptedAlert("Heuristics.Encrypted.Zip")).toBe(true);
    expect(isClamEncryptedAlert("Heuristics.Encrypted.PDF")).toBe(true);
    expect(isClamEncryptedAlert("Heuristics.Encrypted")).toBe(true);
    expect(isClamEncryptedAlert("Heuristics.EncryptedX")).toBe(false);
    expect(isClamEncryptedAlert("Heuristics.Limits.Exceeded.MaxFileSize")).toBe(false);
    expect(isClamEncryptedAlert("Eicar-Test-Signature")).toBe(false);
    expect(isClamEncryptedAlert(null)).toBe(false);
  });

  it("an exit-1 verdict is unscannable only when every detection is an encryption alert", () => {
    expect(clamDetection("/w/a.zip: Heuristics.Encrypted.Zip FOUND\n", "")).toEqual({ status: "unscannable", signature: "Heuristics.Encrypted.Zip" });
    // Malware next to an encrypted member is reported as malware.
    expect(clamDetection("/w/a.zip: Heuristics.Encrypted.Zip FOUND\n/w/a.zip: Eicar-Test-Signature FOUND\n", ""))
      .toEqual({ status: "infected", signature: "Eicar-Test-Signature" });
    expect(clamDetection("/w/a.pdf: Heuristics.Limits.Exceeded.MaxFiles FOUND\n", "")).toEqual({ status: "infected", signature: "Heuristics.Limits.Exceeded.MaxFiles" });
    expect(clamDetection("", "")).toEqual({ status: "infected", signature: null });
  });

  it("recognizes ClamAV's limit alerts and nothing else", () => {
    expect(isClamLimitAlert("Heuristics.Limits.Exceeded.MaxFileSize")).toBe(true);
    expect(isClamLimitAlert("Heuristics.Limits.Exceeded")).toBe(true);
    expect(isClamLimitAlert("Eicar-Test-Signature")).toBe(false);
    expect(isClamLimitAlert("Heuristics.Encrypted.PDF")).toBe(false);
    expect(isClamLimitAlert(null)).toBe(false);
  });
});
