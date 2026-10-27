import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(new URL("../.github/workflows/cla.yml", import.meta.url), "utf8");
const step = workflow.split("- name: Classify organization-owned contributions")[1].split("# Organization members are exempt:")[0];
const script = step.split("        run: |\n")[1].split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
function check(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cla-exemption-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "output");
  writeFileSync(join(dir, "gh"), `#!/bin/sh
if [ "$FAKE_GH_FAIL" = 1 ]; then exit 1; fi
case "$2" in
  */commits) printf '%s' "$FAKE_COMMITS" ;;
  *) printf '%s' "$FAKE_COUNT" ;;
esac
`, { mode: 0o755 });
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { encoding: "utf8", env: {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output,
    GITHUB_EVENT_NAME: "pull_request_target", GITHUB_REPOSITORY: "example/repo", PR_NUMBER: "101",
    PR_AUTHOR: "dependabot[bot]", ASSOCIATION: "NONE", ORG_MEMBERS: "owner", FAKE_COUNT: "1", FAKE_COMMITS: JSON.stringify([[{ author: { login: "dependabot[bot]" } }]]), ...overrides,
  } });
  return { status: result.status, output: readFileSync(output, "utf8") };
}
test("known bot with only permitted commits needs no CLA secret", t => {
  assert.deepEqual(check(t), { status: 0, output: "exempt=false\nexempt=true\n" });
});
test("foreign author on any page retains CLA requirement", t => {
  assert.deepEqual(check(t, { FAKE_COUNT: "2", FAKE_COMMITS: JSON.stringify([[{ author: { login: "dependabot[bot]" } }], [{ author: { login: "external" } }]]) }), { status: 0, output: "exempt=false\n" });
});
test("unknown bot and human external contributors are not exempted", t => {
  for (const PR_AUTHOR of ["unknown[bot]", "external"]) assert.equal(check(t, { PR_AUTHOR }).output, "exempt=false\n");
});
test("GitHub inspection failure fails closed", t => {
  const result = check(t, { FAKE_GH_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(result.output, "exempt=false\n");
});

test("more than 250 commits or incomplete enumeration cannot be exempted", t => {
  for (const FAKE_COUNT of ["251", "2", "0"]) assert.equal(check(t, { FAKE_COUNT }).output, "exempt=false\n");
});
test("bot PR may include a configured org member, but not unknown authors", t => {
  assert.equal(check(t, { FAKE_COMMITS: JSON.stringify([[{ author: { login: "owner" } }]]) }).output, "exempt=false\nexempt=true\n");
  assert.equal(check(t, { FAKE_COMMITS: JSON.stringify([[{ author: null }]]) }).output, "exempt=false\n");
});
