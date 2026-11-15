import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./node-test.mjs", import.meta.url));
for (const ci of [true, false]) {
  test(`Node runner ${ci ? "bails in CI" : "collects local failures"}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "node-test-bail-"));
    try {
      const marker = join(dir, "second-ran");
      const first = join(dir, "first.test.mjs");
      const second = join(dir, "second.test.mjs");
      writeFileSync(first, 'import { test } from "node:test"; test("deliberate failure", () => { throw new Error("bail sentinel"); });');
      writeFileSync(second, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`);
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      if (ci) env.CI = "true"; else delete env.CI;
      const result = spawnSync(process.execPath, [runner, first, second], { env, encoding: "utf8", timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /bail sentinel/);
      assert.equal(existsSync(marker), !ci, result.stdout);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const [url, accepted] of [
  ["postgres://tester:guard-secret@127.0.0.1/dbtest_runner", true],
  ["postgres://tester:guard-secret@remote.example.test/dbtest_runner", false],
  ["postgres://tester:guard-secret@localhost/docslurp", false],
]) {
  test(`runner validates database selection before test execution (${accepted ? "safe" : "unsafe"} ${new URL(url).hostname})`, () => {
    const dir = mkdtempSync(join(tmpdir(), "node-test-guard-"));
    try {
      const marker = join(dir, "ran"); const fixture = join(dir, "guard.test.mjs");
      writeFileSync(fixture, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`);
      const env = { ...process.env, TEST_DATABASE_URL: url }; delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [runner, fixture], { env, encoding: "utf8", timeout: 10000 });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, accepted ? 0 : 1, result.stdout + result.stderr);
      if (!accepted) assert.match(result.stderr, /UnsafeTestDatabaseError.*(?:loopback|does not look disposable)/s);
      assert.equal(existsSync(marker), accepted);
      assert.ok(!(result.stdout + result.stderr).includes("guard-secret"));
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });
}
test("missing compiled database guard refuses before a test can run", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-test-no-build-"));
  try {
    mkdirSync(join(dir, "scripts")); const copiedRunner = join(dir, "scripts/node-test.mjs");
    copyFileSync(runner, copiedRunner);
    const marker = join(dir, "ran"); const fixture = join(dir, "guard.test.mjs");
    writeFileSync(fixture, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`);
    const env = {...process.env, TEST_DATABASE_URL:"postgres://tester:guard-secret@127.0.0.1/dbtest_runner"}; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [copiedRunner, fixture], {env,encoding:"utf8",timeout:10000});
    assert.ifError(result.error); assert.equal(result.signal, null);
    assert.equal(result.status,1); assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.equal(existsSync(marker),false);
    assert.ok(!(result.stdout + result.stderr).includes("guard-secret"));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
