import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { NOT_RUN, classifyTestSource, gatedFiles, scanTestFiles, unsupportedGatedFiles } from "./run-database-tests.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("no test file is gated on a database or Redis variable the runner never sets", () => {
  assert.deepEqual(unsupportedGatedFiles(scanTestFiles()), []);
});

test("the runner finds the gated database and Redis test files", () => {
  const gated = gatedFiles(scanTestFiles());
  const byFile = Object.fromEntries(gated.map((entry) => [entry.file, entry]));
  assert.ok(gated.length > 10, `expected the gated suite, found ${gated.length} file(s)`);
  assert.deepEqual(byFile["server/src/__tests__/billing-credits.db.test.ts"], { file: "server/src/__tests__/billing-credits.db.test.ts", db: true, redis: false, other: [] });
  assert.deepEqual(byFile["server/src/__tests__/rate-limit.redis.test.ts"], { file: "server/src/__tests__/rate-limit.redis.test.ts", db: false, redis: true, other: [] });
  assert.deepEqual(byFile["server/src/agent-runtime/runtime.integration.test.ts"], { file: "server/src/agent-runtime/runtime.integration.test.ts", db: true, redis: true, other: [] });
  for (const file of Object.keys(NOT_RUN)) {
    assert.ok(existsSync(path.join(root, file)), `${file} is listed in NOT_RUN but missing`);
    assert.ok(!byFile[file], `${file} is in NOT_RUN but would run`);
  }
});

test("classifies a test file by the variables it reads", () => {
  assert.deepEqual(classifyTestSource("const url = process.env.TEST_DATABASE_URL;"), { db: true, redis: false, other: [] });
  assert.deepEqual(classifyTestSource("it.runIf(!!process.env.TEST_REDIS_URL)"), { db: false, redis: true, other: [] });
  assert.deepEqual(classifyTestSource("process.env.TEST_DATABASE_URL; process.env.TEST_REDIS_URL"), { db: true, redis: true, other: [] });
  assert.deepEqual(classifyTestSource("process.env.DATABASE_URL"), { db: false, redis: false, other: [] });
  assert.deepEqual(classifyTestSource("const x = 1;"), { db: false, redis: false, other: [] });
});

test("a test gated on its own variable is reported, since the runner would never set it", () => {
  const scanned = [{ file: "server/src/__tests__/new-thing.db.test.ts", ...classifyTestSource("process.env.NEW_THING_TEST_DATABASE_URL; process.env.OTHER_PG_URL") }];
  assert.equal(scanned[0].db, false, "a prefixed name is not TEST_DATABASE_URL");
  assert.deepEqual(unsupportedGatedFiles(scanned), ["server/src/__tests__/new-thing.db.test.ts (NEW_THING_TEST_DATABASE_URL, OTHER_PG_URL)"]);
  assert.deepEqual(gatedFiles(scanned), []);
});

test("bracket and destructured reads of a foreign gate variable are reported too", () => {
  for (const source of [
    'process.env["NEW_THING_DATABASE_URL"]',
    "process.env['NEW_THING_DATABASE_URL']",
    "process.env[ `NEW_THING_DATABASE_URL` ]",
    "const { NEW_THING_DATABASE_URL } = process.env;",
    "const { LOG_LEVEL, NEW_THING_DATABASE_URL: url = '' } = process.env;",
    "let {\n  NEW_THING_DATABASE_URL,\n} = process.env",
  ]) {
    assert.deepEqual(classifyTestSource(source).other, ["NEW_THING_DATABASE_URL"], source);
  }
  assert.deepEqual(classifyTestSource('const { TEST_DATABASE_URL } = process.env; process.env["TEST_REDIS_URL"]'), { db: true, redis: true, other: [] });
  assert.deepEqual(classifyTestSource("const { LOG_LEVEL } = process.env; process.env['HOME']").other, []);
});

test("server/db/tests scripts are scanned but never run directly", () => {
  const scanned = scanTestFiles();
  const scripts = Object.fromEntries(scanned.filter((entry) => entry.script).map((entry) => [entry.file, entry]));
  assert.deepEqual(scripts["server/db/tests/project-cutover-roles.mjs"]?.other, ["PROJECT_CUTOVER_DATABASE_URL"]);
  assert.ok(NOT_RUN["server/db/tests/project-cutover-roles.mjs"], "the cutover reproducer is listed with a reason");
  assert.equal(scripts["server/db/tests/run-control-admission.mjs"]?.db, true);
  assert.ok(!gatedFiles(scanned).some((entry) => entry.file.startsWith("server/db/tests/")), "scripts run through their wrappers");
  const unlisted = [{ file: "server/db/tests/new-script.mjs", script: true, ...classifyTestSource("process.env.NEW_SCRIPT_DATABASE_URL") }];
  assert.deepEqual(unsupportedGatedFiles(unlisted), ["server/db/tests/new-script.mjs (NEW_SCRIPT_DATABASE_URL)"]);
});

 test("aliases and optional reads cannot hide foreign database gates", () => {
  for (const source of [
    "const env = process.env; env.FOREIGN_DATABASE_URL",
    "const env = process.env; const next = env; next?.FOREIGN_DATABASE_URL",
    "process.env?.FOREIGN_DATABASE_URL",
    'process.env?.["FOREIGN_DATABASE_URL"]',
    'const env = process.env; env?.["FOREIGN_DATABASE_URL"]',
    'const env = process.env; const { FOREIGN_DATABASE_URL: url } = env;',
  ]) assert.deepEqual(classifyTestSource(source).other, ["FOREIGN_DATABASE_URL"], source);
});

test("discovers JavaScript and TSX package tests", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "database-discovery-"));
  try {
    for (const name of ["server/src", "worker/src", "packages/sample/src", "server/db/tests"]) mkdirSync(path.join(dir, name), { recursive: true });
    for (const ext of ["js", "tsx", "jsx", "cjs", "mts"]) writeFileSync(path.join(dir, `packages/sample/src/db.test.${ext}`), "process.env.TEST_DATABASE_URL");
    assert.equal(gatedFiles(scanTestFiles(dir)).length, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("typed, nested and destructured aliases report unsupported gates", () => {
  for (const source of [
    "const {env} = process; env.OTHER_DATABASE_URL",
    "const env = process.env as NodeJS.ProcessEnv; env.OTHER_DATABASE_URL",
    "const {env: {OTHER_DATABASE_URL: url}} = process;",
    "const p = process; const {env: environment} = p; const next = (environment!); next.OTHER_DATABASE_URL",
  ]) assert.deepEqual(classifyTestSource(source).other, ["OTHER_DATABASE_URL"], source);
});
