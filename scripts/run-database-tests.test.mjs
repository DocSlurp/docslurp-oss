import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { GATED, NOT_RUN, findGatedTestFiles, unregisteredGatedFiles } from "./run-database-tests.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every test file gated on a database or Redis URL is registered", () => {
  assert.deepEqual(unregisteredGatedFiles(findGatedTestFiles()), []);
});

test("registered gated files exist and name the variables they read", async () => {
  const { readFileSync } = await import("node:fs");
  for (const [file, { db = [], redis = [] }] of Object.entries(GATED)) {
    assert.ok(existsSync(path.join(root, file)), `${file} is registered but missing`);
    const source = readFileSync(path.join(root, file), "utf8");
    for (const variable of [...db, ...redis]) assert.ok(source.includes(variable), `${file} no longer reads ${variable}`);
  }
  for (const file of Object.keys(NOT_RUN)) assert.ok(existsSync(path.join(root, file)), `${file} is listed in NOT_RUN but missing`);
});

test("an unregistered gated file is reported", () => {
  assert.deepEqual(unregisteredGatedFiles(["server/src/__tests__/new-thing.db.test.ts"]), ["server/src/__tests__/new-thing.db.test.ts"]);
});
