import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient } from "../dist/index.js";

test("legacy client selectors fail before network access", () => {
  for (const key of ["workspace", "workspaceId", "workspaceIds", "newWorkspace"]) {
    assert.throws(() => createDocSlurpClient({ [key]: "foreign", fetch: () => { throw new Error("network must not run"); } }), /Legacy workspace selection/);
  }
});
test("legacy per-call selectors cannot become the default project", async () => {
  const client = createDocSlurpClient({ project: "mine", fetch: () => { throw new Error("network must not run"); } });
  await assert.rejects(async () => client.search({ q: "question", workspace: "foreign" }), /Legacy workspace selection/);
});
