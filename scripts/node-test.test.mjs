import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
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
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /bail sentinel/);
      assert.equal(existsSync(marker), !ci, result.stdout);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
