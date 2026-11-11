import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWithPerfContext } from "../lib/perf-context.js";
import { setDefaultParserSandbox } from "../sandbox/startup.js";
import { SandboxPolicyError, type ParserSandboxProvider, type SandboxCommand, type SandboxSessionContext } from "../sandbox/types.js";
import { CommandRunner, parseClamDefinitionsHeader, readClamDefinitionsHeader } from "./runner.js";

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

  it("prefers daily.cld over daily.cvd, as ClamAV loads it, and refuses when no daily file is staged", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-clam-header-"));
    try {
      await writeFile(path.join(dir, "daily.cvd"), header(1, 1_700_000_000));
      await writeFile(path.join(dir, "daily.cld"), header(2, 1_700_000_000));
      await writeFile(path.join(dir, "main.cvd"), header(3, 1_700_000_000));
      expect((await readClamDefinitionsHeader([path.join(dir, "main.cvd"), path.join(dir, "daily.cvd"), path.join(dir, "daily.cld")])).version).toBe(2);
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
