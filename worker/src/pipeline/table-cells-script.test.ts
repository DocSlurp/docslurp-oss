import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(workerRoot, "scripts/table-cells.mjs");
// The guest script imports the built worker (as the parser image does), so this runs where `pnpm build` has run.
const built = existsSync(path.join(workerRoot, "dist/pipeline/table-cells-guest.js"));
const run = promisify(execFile);

// CI builds the worker before the tests: there a missing build is a failure, never a silently skipped boundary test.
if (process.env.CI && !built) throw new Error("table-cells-script.test.ts needs the built worker (worker/dist)");

describe.skipIf(!built)("table-cells.mjs guest script", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  // A remote parser VM receives only the staged input files: the batch's empty output directory (html-table-vm.ts,
  // `out-<n>`) is not there. The script must create it, or every document with an HTML table fails in embed.
  it("writes its result when the output directory was not staged", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-html-tables-test-"));
    const input = path.join(dir, "in-0", "tables.json"), output = path.join(dir, "out-0", "cells.json");
    await mkdir(path.dirname(input));
    await writeFile(input, JSON.stringify(["<table><tr><th>Name</th><th>Plan</th></tr><tr><td>Northwind</td><td>42</td></tr></table>"]));
    await run(process.execPath, [script, input, output]);
    const result = JSON.parse(await readFile(output, "utf8")) as unknown[];
    expect(result).toHaveLength(1);
    expect(JSON.stringify(result[0])).toContain("Northwind");
  });

  it("returns a bounded fallback when a valid single table exceeds the output cap", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-html-tables-test-"));
    const input = path.join(dir, "tables.json");
    const output = path.join(dir, "out-0", "cells.json");
    await writeFile(input, JSON.stringify([`<table><tr><td>${"Project notes ".repeat(30)}</td></tr></table>`]));
    const result = await run(process.execPath, [script, input, output, "128"]);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual([null]);
    expect(result.stderr).toContain("output over single-table limit");
  });

  it("still refuses an invalid batch without writing output", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-html-tables-test-"));
    const input = path.join(dir, "in-0", "tables.json"), output = path.join(dir, "out-0", "cells.json");
    await mkdir(path.dirname(input));
    await writeFile(input, JSON.stringify({ not: "an array" }));
    await expect(run(process.execPath, [script, input, output])).rejects.toThrow(/invalid table batch/);
    expect(existsSync(output)).toBe(false);
    // Nothing is created before the batch is validated.
    expect(existsSync(path.dirname(output))).toBe(false);
  });

  it("refuses a batch with a non-string entry", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-html-tables-test-"));
    const input = path.join(dir, "in-0", "tables.json"), output = path.join(dir, "out-0", "cells.json");
    await mkdir(path.dirname(input));
    await writeFile(input, JSON.stringify(["<table><tr><td>1</td></tr></table>", 7]));
    await expect(run(process.execPath, [script, input, output])).rejects.toThrow(/invalid table batch/);
    expect(existsSync(path.dirname(output))).toBe(false);
  });

  // Local sandboxes bind the host's directories, so the output directory is already there.
  it("writes into an output directory that already exists, owner-only", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-html-tables-test-"));
    const input = path.join(dir, "in-0", "tables.json"), output = path.join(dir, "out-0", "cells.json");
    await mkdir(path.dirname(input));
    await mkdir(path.dirname(output), { mode: 0o700 });
    await writeFile(input, JSON.stringify(["<table><tr><td>Halcyon</td></tr></table>"]));
    await run(process.execPath, [script, input, output]);
    expect(await readFile(output, "utf8")).toContain("Halcyon");
    expect((await stat(output)).mode & 0o077).toBe(0);
  });

  it("does not build missing ancestors of the output directory", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-html-tables-test-"));
    const input = path.join(dir, "in-0", "tables.json"), output = path.join(dir, "gone", "out-0", "cells.json");
    await mkdir(path.dirname(input));
    await writeFile(input, JSON.stringify(["<table><tr><td>1</td></tr></table>"]));
    await expect(run(process.execPath, [script, input, output])).rejects.toThrow(/ENOENT/);
    expect(existsSync(path.join(dir, "gone"))).toBe(false);
  });
});
