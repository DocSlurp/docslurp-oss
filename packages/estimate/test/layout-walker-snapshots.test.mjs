// The layout walker's recorded facts (tests/layout-walker/*.json), which the Rust cross-check (tests/layout_walker.rs)
// holds the profiler to, must be what the core walker (worker/scripts/pdf_layout_facts.py) computes today: a walker change
// fails here until `node scripts/layout-walker-snapshots.mjs` re-records them and the profiler follows. Needs python3 and
// Poppler's pdfimages; skipped without them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { walkerFacts, walkerFixtures } from "../scripts/layout-walker-snapshots.mjs";

const have = (command, args) => {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const tools = have("python3", ["--version"]) && have("pdfimages", ["-v"]);
const snapshots = fileURLToPath(new URL("../tests/layout-walker/", import.meta.url));

describe("layout walker snapshots", () => {
  it("cover every routing fixture with a recorded Doppler run", () => {
    const names = walkerFixtures();
    assert.ok(names.length >= 10);
    for (const name of names) assert.ok(existsSync(join(snapshots, `${name}.json`)), `${name}: no snapshot`);
  });

  it("match what the walker computes now", { skip: !tools && "python3 or pdfimages missing" }, () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "layout-walker-"));
    try {
      for (const name of walkerFixtures()) {
        const recorded = JSON.parse(readFileSync(join(snapshots, `${name}.json`), "utf8"));
        assert.deepEqual(walkerFacts(name, scratch), recorded, `${name}: re-record with node scripts/layout-walker-snapshots.mjs`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
