import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";

import type { SandboxCommand, SandboxResult, SandboxSession } from "../types.js";

const BASH = "/usr/bin/bash";

/** Run a command to completion through whichever entry point the session offers. */
export async function execInSession(session: SandboxSession, command: SandboxCommand): Promise<SandboxResult> {
  if (session.spawn) {
    const child = session.spawn(command);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    // Local sessions leave limit enforcement to the caller (the runner's monitor in production).
    const timer = setTimeout(() => child.kill("SIGKILL"), command.limits.timeoutMs);
    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }
  if (session.run) return session.run(command);
  throw new Error(`Session '${session.providerId}' offers neither spawn nor run`);
}

/**
 * Behavior every parser sandbox provider must satisfy. Cases that depend on an isolation
 * guarantee are skipped (visibly) when the session does not declare it.
 */
export function defineSandboxContract(
  name: string,
  open: () => Promise<SandboxSession | { skip: string }>,
): void {
  describe(`sandbox contract: ${name}`, () => {
    let session: SandboxSession | null = null;
    let skipReason: string | null = null;
    let root = "";
    const leakKey = "DOCSLURP_CONTRACT_HOST_CANARY";

    beforeAll(async () => {
      // Directory names starting with docslurp- are the only writable mounts launchers accept.
      root = mkdtempSync(path.join(tmpdir(), "docslurp-contract-"));
      const opened = await open();
      if ("skip" in opened) skipReason = opened.skip;
      else session = opened;
      process.env[leakKey] = "leaked";
    });

    afterAll(async () => {
      delete process.env[leakKey];
      await session?.close();
      rmSync(root, { recursive: true, force: true });
    });

    function ready(ctx: TestContext): SandboxSession {
      if (!session) ctx.skip(`provider unavailable: ${skipReason}`);
      return session!;
    }

    function requireFilesystem(ctx: TestContext): SandboxSession {
      const opened = ready(ctx);
      if (!opened.isolation.filesystem) ctx.skip("provider declares no filesystem isolation");
      return opened;
    }

    function workspace(label: string): string {
      const dir = mkdtempSync(path.join(root, `${label}-`));
      return dir;
    }

    function command(args: string[], overrides: Partial<SandboxCommand> = {}): SandboxCommand {
      return {
        binary: BASH,
        args,
        env: { PATH: "/usr/bin:/bin" },
        readablePaths: [],
        inputPaths: [],
        writablePaths: [],
        limits: { timeoutMs: 20_000 },
        ...overrides,
      };
    }

    it("fails to read a file that was not declared readable", async (ctx) => {
      const opened = requireFilesystem(ctx);
      const dir = workspace("secret");
      const secret = path.join(dir, "secret.txt");
      writeFileSync(secret, "top-secret");
      const result = await execInSession(opened, command(["-c", `cat "${secret}"`]));
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("top-secret");
    });

    it("reads a declared input file", async (ctx) => {
      const opened = ready(ctx);
      const dir = workspace("input");
      const input = path.join(dir, "input.txt");
      writeFileSync(input, "input-contents");
      const result = await execInSession(
        opened,
        command(["-c", `cat "${input}"`], { readablePaths: [input], inputPaths: [input] }),
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe("input-contents");
    });

    it("fails to write outside the declared writable paths", async (ctx) => {
      const opened = requireFilesystem(ctx);
      const allowed = workspace("allowed");
      const outside = workspace("outside");
      const target = path.join(outside, "out.txt");
      const result = await execInSession(
        opened,
        command(["-c", `echo data > "${target}"`], { writablePaths: [allowed] }),
      );
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(target)).toBe(false);
    });

    it("makes writes to a declared writable path visible locally", async (ctx) => {
      const opened = ready(ctx);
      if (opened.isolation.location !== "local") ctx.skip("write-back is checked on local providers only");
      const dir = workspace("writable");
      const target = path.join(dir, "out.txt");
      const result = await execInSession(
        opened,
        command(["-c", `echo written > "${target}"`], { writablePaths: [dir] }),
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(readFileSync(target, "utf8").trim()).toBe("written");
    });

    it("gives the command a writable $TMPDIR and $HOME", async (ctx) => {
      // Parsers write there: soffice keeps its profile in $HOME, Python's tempfile uses $TMPDIR.
      const opened = requireFilesystem(ctx);
      const result = await execInSession(
        opened,
        command([
          "-c",
          ': "${HOME:?HOME is unset}"; t="${TMPDIR:-/tmp}"; echo tmp > "$t/contract-probe" && echo home > "$HOME/contract-probe" && cat "$t/contract-probe" "$HOME/contract-probe"',
        ]),
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe("tmp\nhome\n");
    });

    it("blocks outbound TCP connections", async (ctx) => {
      const opened = ready(ctx);
      if (opened.isolation.network === "none") ctx.skip("provider declares no network isolation");
      const result = await execInSession(
        opened,
        command(["-c", "exec 3<>/dev/tcp/1.1.1.1/443"], { limits: { timeoutMs: 10_000 } }),
      );
      expect(result.exitCode).not.toBe(0);
    });

    it("kills a command that exceeds its time limit", async (ctx) => {
      const opened = ready(ctx);
      const started = Date.now();
      const result = await execInSession(opened, command(["-c", "sleep 30"], { limits: { timeoutMs: 1_000 } }));
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.exitCode).not.toBe(0);
    });

    it("passes only the provided environment variables", async (ctx) => {
      const opened = ready(ctx);
      const result = await execInSession(
        opened,
        command(["-c", "env"], { env: { PATH: "/usr/bin:/bin", CONTRACT_VALUE: "present" } }),
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("CONTRACT_VALUE=present");
      expect(result.stdout).not.toContain(leakKey);
    });

    it("returns a non-zero exit code and stderr", async (ctx) => {
      const opened = ready(ctx);
      const result = await execInSession(opened, command(["-c", "echo boom >&2; exit 3"]));
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("boom");
    });
  });
}
