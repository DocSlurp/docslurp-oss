import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSandboxCommand, stageClamDefinitions } from "./runner.js";

// Real-Modal P1: the ClamAV definitions are staged once per content, not per document, and travel as a read-only asset.
describe("ClamAV definitions staging", () => {
  let source: string;
  beforeEach(async () => {
    source = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "clam-db-source-"));
    await writeFile(path.join(source, "daily.cvd"), "daily v1");
    await writeFile(path.join(source, "main.cvd"), "main v1");
    await writeFile(path.join(source, "freshclam.conf"), "never copied");
  });
  afterEach(async () => { await rm(source, { recursive: true, force: true }); });

  it("reuses one content-named, read-only copy until the definitions change, then replaces it", async () => {
    const first = await stageClamDefinitions(source);
    const again = await stageClamDefinitions(source);
    expect(again.dir).toBe(first.dir);
    expect(path.basename(first.dir)).toMatch(/^docslurp-clam-definitions-[0-9a-f]{32}$/);
    expect((await readdir(first.dir)).sort()).toEqual(["daily.cvd", "main.cvd"]);
    expect((await stat(first.files[0]!)).mode & 0o777).toBe(0o444);
    // The updater rewrites daily.cvd: a new directory, and the old one goes.
    await writeFile(path.join(source, "daily.cvd"), "daily v2");
    await utimes(path.join(source, "daily.cvd"), new Date(), new Date(Date.now() + 5_000));
    const next = await stageClamDefinitions(source);
    expect(next.dir).not.toBe(first.dir);
    expect(existsSync(first.dir)).toBe(false);
    await rm(next.dir, { recursive: true, force: true });
  });

  it("a command with read-only assets reads them but never uploads them into its job tree", async () => {
    const staged = await stageClamDefinitions(source);
    const command = buildSandboxCommand({
      plan: { binary: "/usr/bin/clamscan", args: ["--database", staged.files[0]!, "--no-summary"], available: true, readOnlyInputs: true, readOnlyAssetDir: staged.dir },
      venvBin: "/nonexistent/venv/bin", scriptsDir: path.resolve("scripts"), scratchRoot: path.join(tmpdir(), "docslurp-parser-sandbox"),
      configuredWritablePaths: [], limits: { timeoutMs: 1_000 },
    });
    expect(command.readOnlyAssetDir).toBe(staged.dir);
    expect(command.inputPaths.some((p) => p.startsWith(staged.dir))).toBe(false);
    expect(command.readablePaths).toContain(staged.dir);
    expect(command.writablePaths.some((p) => p.startsWith(staged.dir))).toBe(false);
    await rm(staged.dir, { recursive: true, force: true });
  });
});
