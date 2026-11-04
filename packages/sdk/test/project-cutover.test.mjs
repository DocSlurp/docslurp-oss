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

const selectorCalls = [
  ["fullIndex", (client,input) => client.fullIndex(input)],
  ["fullIndexEstimate", (client,input) => client.fullIndexEstimate(input)],
  ["setRetention", (client,input) => client.setRetention(input,1)],
  ["listDocuments", (client,input) => client.listDocuments(input)],
  ["rebuildGraphEstimate", (client,input) => client.rebuildGraphEstimate(input)],
  ["estimateIndexingMode", (client,input) => client.estimateIndexingMode("full",input)],
  ["setIndexingModeEstimate", (client,input) => client.setIndexingModeEstimate("full",input)],
];
for (const [name,call] of selectorCalls) test(`${name} rejects stale or mixed selectors before network or billed work`, async () => {
  let requests=0;
  const client=createDocSlurpClient({project:"default-project",fetch:async()=>{requests++;throw new Error("network must not run");}});
  for (const field of ["workspace","workspaceId","workspaceIds","workspaceName","newWorkspace"]) {
    await assert.rejects(async()=>call(client,{[field]:"intended-project"}),/Legacy workspace selection/);
    await assert.rejects(async()=>call(client,{project:"mine",[field]:"intended-project"}),/Legacy workspace selection/);
  }
  assert.equal(requests,0);
});
