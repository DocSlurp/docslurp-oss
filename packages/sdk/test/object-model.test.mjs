import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient } from "../dist/index.js";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const sse = chunks => new Response(new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
}), { headers: { "content-type": "text/event-stream" } });

test("listRuns lists the caller's runs", async () => {
  let url;
  const client = createDocSlurpClient({ apiUrl: "https://example.test", fetch: async requestUrl => {
    url = requestUrl;
    return json({ runs: [{ id: "run-1", status: "completed" }] });
  } });
  assert.deepEqual(await client.listRuns(), [{ id: "run-1", status: "completed" }]);
  assert.equal(url, "https://example.test/v1/runs");
});

test("listDocuments scopes to the client workspace and forwards filters", async () => {
  let url;
  const client = createDocSlurpClient({ apiUrl: "https://example.test", workspaceId: "manuals", fetch: async requestUrl => {
    url = requestUrl;
    return json({ documents: [{ id: "doc-1", filename: "a.pdf", status: "completed" }] });
  } });
  const documents = await client.listDocuments({ runId: "run-9", tags: "a,b" });
  assert.equal(documents[0].filename, "a.pdf");
  assert.equal(url, "https://example.test/v1/documents?workspaceId=manuals&runId=run-9&tags=a%2Cb");
});

test("deleteDocument sends DELETE and returns the removed identities", async () => {
  let seen;
  const client = createDocSlurpClient({ apiUrl: "https://example.test", fetch: async (url, init) => {
    seen = { url, method: init.method };
    return json({ documentId: "doc/1", filename: "a.pdf" });
  } });
  const deleted = await client.deleteDocument("doc/1");
  assert.equal(seen.method, "DELETE");
  assert.equal(seen.url, "https://example.test/v1/documents/doc%2F1");
  assert.equal(deleted.filename, "a.pdf");
});

test("chatStream streams status, the answer, then done from the legacy SSE route", async () => {
  let url, accept;
  const client = createDocSlurpClient({ apiUrl: "https://example.test", workspaceId: "manuals", fetch: async (requestUrl, init) => {
    url = requestUrl;
    accept = new Headers(init.headers).get("Accept");
    return sse([
      'event: status\ndata: {"stage":"retrieval","message":"Retrieving workspace context"}\n\n',
      'event: message\ndata: {"id":"chat-1","sessionId":"s1","searchSessionId":null,"answer":"Hi","citations":[],"availability":null,"usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2},"runtime":{"startedAt":"t","completedAt":"t","totalMs":0}}\n\n',
      'event: done\ndata: {"id":"chat-1","sessionId":"s1","searchSessionId":null}\n\n',
    ]);
  } });
  const events = [];
  for await (const event of client.chatStream({ q: "hi", sessionId: "s1", model: "workspace:manuals" })) events.push(event);
  assert.deepEqual(events.map(event => event.event), ["status", "message", "done"]);
  assert.equal(events[1].data.answer, "Hi");
  assert.equal(events[2].data.sessionId, "s1");
  assert.equal(url, "https://example.test/v1/search/chat/stream?q=hi&workspaceId=manuals&sessionId=s1&model=workspace%3Amanuals");
  assert.equal(accept, "text/event-stream");
});

test("chatStream throws when the stream ends before done", async () => {
  const client = createDocSlurpClient({ apiUrl: "https://example.test", workspaceId: "manuals", fetch: async () => sse([
    'event: status\ndata: {"stage":"retrieval","message":"Retrieving workspace context"}\n\n',
  ]) });
  await assert.rejects(
    async () => { for await (const _event of client.chatStream({ q: "hi" })) {} },
    /ended before completion/,
  );
});

test("chatStream surfaces auth failures instead of finishing quietly", async () => {
  const client = createDocSlurpClient({ apiUrl: "https://example.test", apiKey: "fixture", fetch: async () => json({ error: "Forbidden" }, 403) });
  await assert.rejects(
    async () => { for await (const _event of client.chatStream({ q: "hi" })) {} },
    error => error.status === 403,
  );
});
