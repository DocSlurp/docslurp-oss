import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient, formatSearchContext, DocSlurpApiError } from "../dist/index.js";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

test("search iterates ordered hits and shares one request with metadata reads", async () => {
  let calls = 0;
  const response = { results: [{ text: "first" }, { text: "second" }], availability: { status: "partial" }, sessionId: "session", usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7, costCents: 0.001, currency: "USD", costSource: "provider", scope: "retrieval" } };
  const client = createDocSlurpClient({ workspaceId: "workspace", fetch: async () => { calls++; return json(response); } });
  const search = client.search({ q: "question" });
  const hits = [];
  for await (const hit of search) hits.push(hit);
  assert.deepEqual(hits, response.results);
  assert.deepEqual(await search, response);
  const replay = [];
  for await (const hit of search) replay.push(hit);
  assert.deepEqual(replay, hits);
  assert.equal(calls, 1);
});

test("search supports direct iteration, empty results, and early exit", async () => {
  const client = createDocSlurpClient({ workspaceId: "workspace", fetch: async () => json({ results: [{ text: "first" }, { text: "second" }] }) });
  let count = 0;
  for await (const hit of client.search({ q: "question" })) {
    assert.equal(hit.text, "first");
    count++;
    break;
  }
  assert.equal(count, 1);
  const empty = createDocSlurpClient({ workspaceId: "workspace", fetch: async () => json({ results: [] }) });
  for await (const _hit of empty.search({ q: "question" })) assert.fail("Unexpected hit");
});

test("search iteration propagates failure and cancellation without retrying", async () => {
  const consume = async (search) => { for await (const _hit of search) assert.fail("Unexpected hit"); };
  let calls = 0;
  const client = createDocSlurpClient({ workspaceId: "workspace", fetch: async () => { calls++; return json({ error: "Unavailable" }, 503); } });
  await assert.rejects(consume(client.search({ q: "question" })), DocSlurpApiError);
  assert.equal(calls, 1);
  const controller = new AbortController();
  const reason = new Error("Stop retrieval");
  const cancelled = createDocSlurpClient({ workspaceId: "workspace", fetch: async (_url, init) => {
    controller.abort(reason);
    init.signal.throwIfAborted();
  } });
  await assert.rejects(consume(cancelled.search({ q: "question" }, { signal: controller.signal })), error => error === reason);
});

test("search and chat use constructor workspace defaults and per-call overrides", async () => {
  const requests = [];
  const client = createDocSlurpClient({ apiUrl: "https://example.test", apiKey: "key", workspaceId: "default", fetch: async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return json({ answer: "answer", results: [], sessionId: "session", citations: [] });
  } });
  await client.search({ q: "first" });
  await client.chat({ q: "second", workspaceId: "override", sessionId: "session" });
  assert.deepEqual(requests.map(({ body }) => body), [{ q: "first", workspaceId: "default" }, { q: "second", workspaceId: "override", sessionId: "session" }]);
});

test("batch sends bounded parallel requests once and preserves ordered failures", async () => {
  let calls = 0;
  const outcomes = { results: [{ ok: true, data: { results: [], sessionId: "first", availability: null } }, { ok: false, error: { status: 403, code: "forbidden", message: "Forbidden" } }] };
  const client = createDocSlurpClient({ apiUrl: "https://example.test", workspaceId: "default", fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://example.test/v1/search");
    assert.deepEqual(JSON.parse(init.body), { queries: [{ q: "first", workspaceId: "default" }, { q: "second", workspaceId: "other" }], concurrency: 3 });
    return json(outcomes);
  } });
  assert.deepEqual(await client.search({ queries: [{ q: "first" }, { q: "second", workspaceId: "other" }], concurrency: 3 }), outcomes);
  assert.equal(calls, 1);
  for (const inputs of [[], Array.from({ length: 21 }, () => ({ q: "question" }))]) assert.throws(() => client.search({ queries: inputs }), RangeError);
  for (const concurrency of [0, 5, 1.5, NaN]) assert.throws(() => client.search({ queries: [{ q: "question" }], concurrency }), RangeError);
  assert.equal(calls, 1);
});

test("batch honors abort signals and never retries AI-backed failures", async () => {
  const controller = new AbortController();
  const reason = new Error("Stop retrieval");
  const client = createDocSlurpClient({ workspaceId: "workspace", fetch: async (_url, init) => {
    controller.abort(reason);
    init.signal.throwIfAborted();
  } });
  await assert.rejects(client.search({ queries: [{ q: "question" }] }, { signal: controller.signal }), (error) => error === reason);
  let calls = 0;
  const failing = createDocSlurpClient({ workspaceId: "workspace", fetch: async () => { calls++; return json({ error: "Unavailable" }, 503); } });
  await assert.rejects(failing.search({ queries: [{ q: "question" }] }), DocSlurpApiError);
  assert.equal(calls, 1);
});

test("portable context retains complete source text and citations without requiring an LLM SDK", () => {
  const text = "Full passage\n" + "Evidence ".repeat(100);
  const result = formatSearchContext({ availability: null, sessionId: "s", results: [{ score: 1, text, citation: { documentId: "doc", filename: "policy.pdf", pageNumbers: [2, 3] } }] });
  assert.ok(result.includes(text));
  assert.ok(result.includes("policy.pdf"));
  assert.equal(formatSearchContext({ results: [], sessionId: "s", availability: null }), "");
});


test("lists workspace tags with counts using the client workspace default", async () => {
  const client = createDocSlurpClient({ workspaceId: "my-workspace", fetch: async (url) => {
    assert.ok(String(url).endsWith("/v1/workspaces/my-workspace/tags"));
    return json({ tags: [{ tag: "finance", documentCount: 3 }] });
  } });
  assert.deepEqual(await client.listWorkspaceTags(), [{ tag: "finance", documentCount: 3 }]);
});
