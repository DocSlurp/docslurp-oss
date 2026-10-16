import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shims, buildShims } from "./build.mjs";

test("every retired package name has a shim that points at a current package", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "shims-")), "out");
  try {
    const names = buildShims(dir, "9.9.9");
    assert.deepEqual(names.sort(), Object.keys(shims).sort());
    for (const name of names) {
      const manifest = JSON.parse(readFileSync(join(dir, name.split("/")[1], "package.json"), "utf8"));
      assert.equal(manifest.name, name);
      assert.match(Object.keys(manifest.dependencies)[0], /^@docslurp\/(contrib-|sdk)/);
    }
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});
