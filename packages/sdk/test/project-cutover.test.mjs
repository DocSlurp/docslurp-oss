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
  ["createCapability", (client,input) => client.createCapability(input)],
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
  for (const field of ["workspace","workspaces","workspaceId","workspaceIds","workspaceName","newWorkspace","workspace_id","workspace_ids"]) {
    await assert.rejects(async()=>call(client,{[field]:"intended-project"}),/Legacy workspace selection/);
    await assert.rejects(async()=>call(client,{project:"mine",[field]:"intended-project"}),/Legacy workspace selection/);
  }
  assert.equal(requests,0);
});

test("inherited legacy selectors are refused instead of becoming an implicit default", async () => {
  const client=createDocSlurpClient({project:"default-project",fetch:()=>{throw new Error("network must not run");}});
  for (const [,call] of selectorCalls) {
    await assert.rejects(async()=>call(client,Object.create({workspace:"intended-project"})),/Legacy workspace selection/);
  }
});

for (const method of ["upload","extract"]) test(`${method} validates original input/options before copies, fetch or source reads`, async () => {
  let requests=0,reads=0;
  const client=createDocSlurpClient({project:"client-default",fetch:async()=>{requests++;throw new Error("network must not run");}});
  const withSelector=(base,style)=>{
    if(style==="inherited") return Object.assign(Object.create({workspace:"intended-project"}),base);
    Object.defineProperty(base,"workspace",{value:"intended-project",enumerable:style!=="non-enumerable"});
    return base;
  };
  for (const style of ["own","inherited","non-enumerable"]) {
    await assert.rejects(()=>client[method](withSelector({urls:["https://example.test/a.pdf"]},style)),/Legacy workspace selection/);
    await assert.rejects(()=>client[method]({urls:["https://example.test/a.pdf"]},withSelector({},style)),/Legacy workspace selection/);
    await assert.rejects(()=>client[method](withSelector({files:[new Blob(["test"])]},style)),/Legacy workspace selection/);
    await assert.rejects(()=>client[method]([new Blob(["test"])],withSelector({},style)),/Legacy workspace selection/);
    const source={async *[Symbol.asyncIterator](){reads++;yield new Uint8Array([1]);}};
    await assert.rejects(()=>client[method](source,withSelector({},style)),/Legacy workspace selection/);
  }
  assert.equal(requests,0);
  assert.equal(reads,0);
});

test("batch search validates outer selectors before constructing its envelope", async () => {
  let requests=0;
  const client=createDocSlurpClient({project:"default-project",fetch:()=>{requests++;throw new Error("network must not run");}});
  await assert.rejects(async()=>client.search({queries:[{q:"question"}],workspace:"intended"}),/Legacy workspace selection/);
  await assert.rejects(async()=>client.search(Object.assign(Object.create({workspace:"intended"}),{queries:[{q:"question"}]})),/Legacy workspace selection/);
  assert.equal(requests,0);
});
test("activity streaming does not discard a legacy project filter", async () => {
  let requests=0;
  const client=createDocSlurpClient({fetch:()=>{requests++;throw new Error("network must not run");}});
  await assert.rejects(()=>client.streamActivity({workspaceId:"intended"}).next(),/Legacy workspace selection/);
  await assert.rejects(()=>client.streamActivity(Object.create({workspaceId:"intended"})).next(),/Legacy workspace selection/);
  assert.equal(requests,0);
});

for (const method of ["upload", "extract"]) test(`${method} rejects intake selectors that copying would erase`, async () => {
  let requests = 0, reads = 0;
  const client = createDocSlurpClient({ project: "client-default", fetch: async () => { requests++; throw new Error("network must not run"); } });
  for (const key of ["project", "newProject", "templateKey", "orgId"]) {
    for (const style of ["inherited", "non-enumerable"]) {
      const selected = (base) => style === "inherited"
        ? Object.assign(Object.create({ [key]: key === "newProject" ? true : "intended" }), base)
        : Object.defineProperty(base, key, { value: key === "newProject" ? true : "intended", enumerable: false });
      await assert.rejects(() => client[method](selected({ urls: ["https://example.test/a.pdf"] })), /must be an enumerable own property/);
      await assert.rejects(() => client[method](selected({ files: [new Blob(["test"])] })), /must be an enumerable own property/);
      await assert.rejects(() => client[method]({ urls: ["https://example.test/a.pdf"] }, selected({})), /must be an enumerable own property/);
      const source = { async *[Symbol.asyncIterator]() { reads++; yield new Uint8Array([1]); } };
      await assert.rejects(() => client[method](source, selected({})), /must be an enumerable own property/);
    }
  }
  assert.equal(requests, 0);
  assert.equal(reads, 0);
});

for (const method of ["upload", "extract"]) test(`${method} refuses scope fields attached to direct files or streams`, async () => {
  let requests = 0, reads = 0;
  const client = createDocSlurpClient({ project: "client-default", fetch: async () => { requests++; throw new Error("network must not run"); } });
  const fileFactories = [
    () => new Blob(["test"]),
    () => ({ data: new Blob(["test"]), filename: "a.pdf" }),
    () => ({ async *[Symbol.asyncIterator]() { reads++; yield new Uint8Array([1]); } }),
    () => ({ data: new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 }), filename: "a.pdf" }),
  ];
  for (const key of ["project", "newProject", "templateKey", "orgId"]) {
    for (const make of fileFactories) {
      for (const directUpload of [false, true]) {
        const input = Object.assign(make(), { [key]: key === "newProject" ? true : "intended" });
        await assert.rejects(() => client[method](input, { directUpload, project: "explicit-options" }), /Pass intake selection/);
      }
    }
    const file = Object.assign(new Blob(["test"]), { [key]: key === "newProject" ? true : "intended" });
    await assert.rejects(() => client[method]([file]), /Pass intake selection/);
    await assert.rejects(() => client[method]({ files: [file] }), /Pass intake selection/);
    await assert.rejects(() => client[method](Object.assign([new Blob(["test"])], { [key]: key === "newProject" ? true : "intended" })), /Pass intake selection/);
  }
  const staleFile = Object.assign(new Blob(["test"]), { workspace: "intended" });
  await assert.rejects(() => client[method]({ files: [staleFile] }), /Legacy workspace selection/);
  assert.equal(requests, 0);
  assert.equal(reads, 0);
});

for (const method of ["upload", "extract"]) test(`${method} rejects arrays masquerading as scope envelopes`, async () => {
  let requests = 0;
  const client = createDocSlurpClient({ project: "client-default", fetch: async () => { requests++; throw new Error("network must not run"); } });
  for (const envelope of [{ files: [] }, { urls: ["https://example.test/a.pdf"] }, { files: [], urls: [] }]) {
    for (const directUpload of [false, true]) {
      const input = Object.assign([new Blob(["secret"])], envelope, { project: "intended", orgId: "intended-org", newProject: true, templateKey: "intended-template" });
      await assert.rejects(() => client[method](input, { directUpload }), /arrays cannot also be/);
    }
  }
  assert.equal(requests, 0);
});

test("all public intake entrypoints refuse organization scope erased by copying", async () => {
  let requests = 0;
  const client = createDocSlurpClient({ project: "client-default", fetch: async () => { requests++; throw new Error("network must not run"); } });
  for (const style of ["inherited", "non-enumerable"]) {
    const selected = (base) => style === "inherited"
      ? Object.assign(Object.create({ orgId: "intended-org" }), base)
      : Object.defineProperty(base, "orgId", { value: "intended-org", enumerable: false });
    await assert.rejects(async () => client.createUploadSession(selected({ files: [{ filename: "x", sizeBytes: 1, mimeType: "text/plain" }] })), /must be an enumerable own property/);
    await assert.rejects(async () => client.uploadUrls(selected({ urls: ["https://example.test/a.pdf"] })), /must be an enumerable own property/);
    await assert.rejects(async () => client.ingestUrls(selected({ urls: ["https://example.test/a.pdf"] })), /must be an enumerable own property/);
  }
  await assert.rejects(async () => client.createUploadSession({ files: [{ filename: "x", sizeBytes: 1, mimeType: "text/plain", project: "misplaced" }] }), /Pass intake selection/);
  assert.equal(requests, 0);
});

for (const method of ["upload", "extract"]) test(`${method} undefined scope options preserve explicit envelope scope`, async () => {
  for (const kind of ["urls", "files"]) {
    for (const directUpload of [true, false]) {
      for (const named of [true, false]) {
        let captured;
        const client = createDocSlurpClient({ project: "client-default", fetch: async (_url, init) => {
          captured = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body);
          throw new Error("captured request");
        } });
        const input = { ...(kind === "urls" ? { urls: ["https://example.test/a.pdf"] } : { files: [new Blob(["x"])] }),
          ...(named ? { project: "intended-project" } : { newProject: true, templateKey: "intended-template" }), orgId: "intended-org" };
        await assert.rejects(() => client[method](input, { directUpload, project: undefined, orgId: undefined, newProject: undefined, templateKey: undefined }), /captured request/);
        assert.equal(captured.orgId, "intended-org");
        if (named) assert.equal(captured.project, "intended-project");
        else {
          assert.ok(captured.newProject === true || captured.newProject === "true");
          assert.equal(captured.templateKey, "intended-template");
          assert.equal(captured.project, undefined);
        }
      }
    }
  }
});


test("capability restrictions cannot disappear during serialization", async () => {
  let requests = 0;
  const client = createDocSlurpClient({ fetch: async () => { requests++; throw new Error("network must not run"); } });
  for (const [key, value] of Object.entries({ projectIds: ["restricted-project"], policy: { allowAgentDiscovery: false }, ttlSeconds: 60, boundClientKeyId: "client", allowedOrigins: ["https://example.test"] })) {
    for (const input of [Object.create({ [key]: value }), Object.defineProperty({}, key, { value })]) {
      await assert.rejects(async () => client.createCapability(input), /must be an enumerable own property/);
    }
  }
  for (const policy of [Object.create({ allowAgentDiscovery: false }), Object.defineProperty({}, "maxCreditsPerQuery", { value: 1 })]) {
    await assert.rejects(async () => client.createCapability({ projectIds: ["restricted"], policy }), /must be an enumerable own property/);
  }
  assert.equal(requests, 0);
});

test("capability requests retain explicit restrictions despite custom serialization", async () => {
  let captured;
  const client = createDocSlurpClient({ fetch: async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ token: "sealed", expiresAt: "later" }), { headers: { "content-type": "application/json" } });
  } });
  const projectIds = Object.assign(["restricted-project"], { toJSON: () => undefined });
  const allowedOrigins = Object.assign(["https://example.test"], { toJSON: () => undefined });
  await client.createCapability({ projectIds, allowedOrigins, policy: { allowAgentDiscovery: false, toJSON: () => ({}) }, ttlSeconds: 60, boundClientKeyId: "client", toJSON: () => ({}) });
  assert.deepEqual(captured, { projectIds: ["restricted-project"], allowedOrigins: ["https://example.test"], policy: { allowAgentDiscovery: false }, ttlSeconds: 60, boundClientKeyId: "client" });
});


test("request serialization hooks cannot erase explicit project or organization scope", async () => {
  let requests = 0;
  const client = createDocSlurpClient({ project: "client-default", fetch: async () => { requests++; throw new Error("network must not run"); } });
  const calls = [
    input => client.createUploadSession({ files: [{ filename: "x", sizeBytes: 1, mimeType: "text/plain" }], ...input }),
    input => client.search({ q: "question", ...input }),
    input => client.search({ queries: [{ q: "question", ...input }] }),
    input => client.chat({ q: "question", ...input }),
    async input => { for await (const _ of client.chatStream({ q: "question", ...input })) {} },
    input => client.upload({ urls: ["https://example.test/a.pdf"], ...input }),
    input => client.extract({ urls: ["https://example.test/a.pdf"], ...input }),
  ];
  for (const call of calls) {
    await assert.rejects(async () => call({ project: "intended", orgId: "intended-org", toJSON: () => ({}) }), /custom toJSON serialization/);
  }
  assert.equal(requests, 0);
});

test("selection and capability restrictions require stable protocol values", async () => {
  let requests = 0;
  let reads = 0;
  const client = createDocSlurpClient({ project: "client-default", fetch: async () => { requests++; throw new Error("network must not run"); } });
  const erased = { toJSON: () => undefined };
  for (const value of [erased, null, 42, ["org"]]) {
    await assert.rejects(async () => client.createUploadSession({ files: [{ filename: "x", sizeBytes: 1, mimeType: "text/plain" }], project: "intended", orgId: value }), /invalid value type/);
    await assert.rejects(async () => client.search({ q: "question", project: "intended", orgId: value }), /invalid value type/);
  }
  const input = { q: "question" };
  Object.defineProperty(input, "project", { enumerable: true, get() { reads++; return reads === 1 ? "intended" : "default"; } });
  await assert.rejects(async () => client.search(input), /must be a data property/);
  for (const key of ["project", "orgId", "projectIds", "newProject", "templateKey"]) {
    await assert.rejects(async () => client.search({ queries: [{ q: "question" }], [key]: "intended" }), /batch search selections in each query/);
  }
  for (const input of [
    { boundClientKeyId: erased }, { ttlSeconds: erased }, { allowedOrigins: [erased] },
    { projectIds: [erased] }, { policy: { maxCreditsPerQuery: erased } },
    { policy: { allowAgentDiscovery: erased } }, { policy: { mapRouter: erased } },
  ]) await assert.rejects(async () => client.createCapability({ projectIds: ["restricted"], ...input }), /must be|must contain|invalid value type/);
  const policy = {};
  Object.defineProperty(policy, "maxCreditsPerQuery", { enumerable: true, get() { reads++; return 1; } });
  await assert.rejects(async () => client.createCapability({ projectIds: ["restricted"], policy }), /must be a data property/);
  assert.equal(reads, 0);
  assert.equal(requests, 0);
});

test("capability arrays use validated data slots rather than custom iterators", async () => {
  let captured;
  const client = createDocSlurpClient({ fetch: async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response(JSON.stringify({ token: "sealed", expiresAt: "later" }), { headers: { "content-type": "application/json" } });
  } });
  const projectIds = ["restricted"];
  projectIds[Symbol.iterator] = function* () { yield "broader"; };
  await client.createCapability({ projectIds });
  assert.deepEqual(captured.projectIds, ["restricted"]);
});
