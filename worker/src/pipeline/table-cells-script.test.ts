import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("still refuses an invalid batch without writing output", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "docslurp-html-tables-test-"));
    const input = path.join(dir, "in-0", "tables.json"), output = path.join(dir, "out-0", "cells.json");
    await mkdir(path.dirname(input));
    await writeFile(input, JSON.stringify({ not: "an array" }));
    await expect(run(process.execPath, [script, input, output])).rejects.toThrow(/invalid table batch/);
    expect(existsSync(output)).toBe(false);
  });
});
