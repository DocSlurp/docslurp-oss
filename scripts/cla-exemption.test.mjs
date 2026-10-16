import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

// Execute the shipped workflow classifier. Its only network dependency is the
// GitHub commit-author query; substitute that response, never PR-owned code.
const workflow = readFileSync(new URL("../.github/workflows/cla.yml", import.meta.url), "utf8");
const block = workflow.match(/- name: Classify organization-owned contributions[\s\S]*?        run: \|\n([\s\S]*?)(?=      # Organization members)/)?.[1];
assert.ok(block, "CLA workflow classifier must remain testable");
const script = block.split("\n").map((line) => line.replace(/^          /, "")).join("\n");
for (const scenario of [
  { name: "payload organization member", association: "MEMBER", members: "", foreign: "0", expected: "true" },
  { name: "private member from verified list", association: "CONTRIBUTOR", members: "member,other", foreign: "0", expected: "true" },
  { name: "external author", association: "CONTRIBUTOR", members: "other", foreign: "0", expected: "false" },
  { name: "missing list fails closed", association: "CONTRIBUTOR", members: "", foreign: "0", expected: "false" },
  { name: "partial username is not a member", association: "CONTRIBUTOR", members: "member-extra", foreign: "0", expected: "false" },
  { name: "foreign commit author fails closed", association: "MEMBER", members: "member", foreign: "1", expected: "false" },
  { name: "manual verification fetches trusted metadata", association: "CONTRIBUTOR", members: "member", event: "workflow_dispatch", foreign: "0", expected: "true" },
  { name: "manual verification keeps external authors gated", association: "CONTRIBUTOR", members: "other", event: "workflow_dispatch", foreign: "0", expected: "false" },
  { name: "other event requires CLA service", association: "MEMBER", members: "member", event: "issue_comment", foreign: "0", expected: "false" },
]) {
  test(scenario.name, () => {
    const dir = mkdtempSync(join(tmpdir(), "cla-exemption-"));
    try {
      writeFileSync(join(dir, "gh"), `#!/bin/sh
case "$*" in
  *".user.login"*) printf '%s\\n' member ;;
  *".author_association"*) printf '%s\\n' CONTRIBUTOR ;;
  *) printf '%s\\n' "$MOCK_FOREIGN_COMMITS" ;;
esac
`, { mode: 0o700 });
      const output = join(dir, "output");
      execFileSync("bash", ["-e", "-c", script], { env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output,
        GITHUB_EVENT_NAME: scenario.event ?? "pull_request_target", GITHUB_REPOSITORY: "example/core",
        PR_NUMBER: "1", PR_AUTHOR: "member", ASSOCIATION: scenario.association,
        ORG_MEMBERS: scenario.members, MOCK_FOREIGN_COMMITS: scenario.foreign,
      } });
      const result = readFileSync(output, "utf8").trim().split("\n").at(-1);
      assert.equal(result, `exempt=${scenario.expected}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
