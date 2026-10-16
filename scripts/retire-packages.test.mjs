import test from "node:test";
import assert from "node:assert/strict";
import { retiredPackages, versionsNeedingDeprecation } from "./retire-packages.mjs";
import { releasePackages } from "./package-release.mjs";
import { shims } from "./deprecated-shims/build.mjs";
import { readFileSync } from "node:fs";

test("only versions without the exact message need deprecating", () => {
  const packument = { versions: { "0.1.0": { deprecated: "old text" }, "0.2.0": { deprecated: "msg" }, "0.3.0": {} } };
  assert.deepEqual(versionsNeedingDeprecation(packument, "msg"), ["0.1.0", "0.3.0"]);
});

test("retired names match the shim generator and point at released packages", () => {
  assert.deepEqual(Object.keys(retiredPackages).sort(), Object.keys(shims).sort());
  const released = releasePackages.map((dir) => JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), "utf8")).name);
  for (const { replacement } of Object.values(retiredPackages)) assert.ok(released.includes(replacement), replacement);
  for (const name of Object.keys(retiredPackages)) assert.ok(!released.includes(name));
});
