import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient } from "../dist/index.js";
test("chat and reprocessing serialize choices without inventing defaults", async () => {
  const bodies = [];
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return Response.json({ run: { id: "run" } }); } });
  await client.chat({ q: "question" });
  await client.chat({ q: "question", speedBoost: true });
  await client.chat({ q: "question", speedBoost: false });
  await client.reprocessRun("run", { speedBoost: true });
  assert.equal(Object.hasOwn(bodies[0], "speedBoost"), false);
  assert.deepEqual(bodies.slice(1).map(b => b.speedBoost), [true, false, true]);
});
test("chat stream carries explicit choice", async () => {
  let url;
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: async input => {
    url = new URL(input); return new Response('event: done\ndata: {}\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  for await (const _event of client.chatStream({ q: "question", speedBoost: true })) {}
  assert.equal(url.searchParams.get("speedBoost"), "true");
});
test("URL and multipart uploads retain true and false independently of quality", async () => {
  const calls = [];
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: async (_url, init) => { calls.push(init.body); return Response.json({ documents: [], run: { id: "run" } }); } });
  await client.upload({ urls: ["https://example.com/document"], speedBoost: true });
  await client.upload(new Blob(["document"]), { filename: "doc.txt", directUpload: false, speedBoost: false });
  assert.equal(JSON.parse(calls[0]).speedBoost, true);
  assert.equal(calls[1].get("speedBoost"), "false");
});

test("full-index mutation and estimate transports preserve all opt-in states", async () => {
  const bodies = [];
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return Response.json({}); } });
  for (const speedBoost of [undefined, false, true]) {
    const input = speedBoost === undefined ? {} : { speedBoost };
    await client.fullIndex(input);
    await client.fullIndexDocument("doc", input);
    await client.fullIndexEstimate(input);
    await client.fullIndexEstimate({ documentId: "doc", ...input });
    for (const body of bodies.splice(0)) {
      assert.equal(body.speedBoost, speedBoost);
      assert.equal(Object.hasOwn(body, "speedBoost"), speedBoost !== undefined);
    }
  }
});
