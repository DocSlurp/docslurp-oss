import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient, DocSlurpApiError, emptySearchStreamView, foldSearchStream, mergeSearchStream, searchResultId } from "../dist/index.js";

const enc = new TextEncoder();
const hit = (documentId, chunkIndex, text = documentId) => ({ score: 1, text, citation: { documentId, chunkIndex, filename: "f.pdf", pageNumber: 1, source: "document" } });
const id = (r) => searchResultId(r.citation);
const env = (seq) => ({ searchId: "s1", seq, elapsedMs: seq * 10 });
const A = hit("a", 0), B = hit("b", 0), C = hit("c", 1);
const finalBody = { results: [B, A], sessionId: "sess", usage: {}, availability: null };
const frames = [
  { ...env(0), type: "search.started", protocol: 1, projectId: "p", cached: false },
  { ...env(1), type: "search.hits", leg: "vector", hits: [{ id: id(A), legRank: 0, result: A }, { id: id(C), legRank: 1, result: C }], truncated: false, stats: { ms: 40 } },
  { ...env(2), type: "search.hits", leg: "lexical", hits: [{ id: id(B), legRank: 0, result: B }, { id: id(A), legRank: 1, result: A }], truncated: false },
  { ...env(3), type: "search.results", ids: [id(B), id(A)], response: finalBody },
  { ...env(4), type: "search.done", sessionId: "sess", resultCount: 2 },
];
const sse = (events) => events.map(e => `event: ${e.type}\nid: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const sseResponse = (chunks, { fail } = {}) => {
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else if (fail) controller.error(new TypeError("terminated"));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const collect = async (stream) => { const out = []; for await (const e of stream) out.push(e); return out; };
const make = (fetch) => createDocSlurpClient({ project: "p", apiKey: "key", fetch });

test("searchStream parses events across arbitrary chunk boundaries, CRLF, comments and multi-line data", async () => {
  const text = ": heartbeat\n\n" + sse(frames).replace(/\n/g, "\r\n");
  for (const size of [1, 3, 7, 1000]) {
    const chunks = []; for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    const calls = [];
    const client = make(async (url, init) => { calls.push({ url, init }); return sseResponse(chunks); });
    const stream = client.searchStream({ q: "earnings beat", stats: true });
    const events = await collect(stream);
    assert.deepEqual(events.map(e => e.type), frames.map(f => f.type));
    assert.deepEqual((await stream.response).results, finalBody.results);
    assert.equal(stream.transport, "sse");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/v1/search/stream"));
    assert.equal(calls[0].init.method, "POST");
    assert.equal(new Headers(calls[0].init.headers).get("accept"), "text/event-stream");
    assert.deepEqual(JSON.parse(calls[0].init.body), { q: "earnings beat", project: "p", stats: true });
  }
  const multi = `event: search.hits\ndata: {"type":"search.hits","searchId":"s","seq":1,"elapsedMs":1,\ndata: "leg":"lexical","hits":[],"truncated":false}\n\n` + sse([frames[3]]);
  const events = await collect(make(async () => sseResponse([multi])).searchStream({ q: "x" }));
  assert.equal(events[0].leg, "lexical");
});

test("searchStream ignores unknown event types and fields", async () => {
  const unknown = { ...env(1), type: "search.future", extra: 1 };
  const withField = { ...frames[3], futureField: true };
  const events = await collect(make(async () => sseResponse([sse([frames[0], unknown, withField, frames[4]])])).searchStream({ q: "x" }));
  assert.deepEqual(events.map(e => e.type), ["search.started", "search.results", "search.done"]);
});

test("response resolves without iteration, and iteration may break early", async () => {
  const client = make(async () => sseResponse([sse(frames)]));
  assert.equal((await client.searchStream({ q: "x" }).response).sessionId, "sess");
  for await (const _event of client.searchStream({ q: "x" })) break;
});

test("searchStream falls back to the JSON endpoint on 404 and on a non-SSE content type", async () => {
  for (const first of [() => json({ error: { code: "not_found" } }, 404), () => json({ not: "sse" }), () => new Response("x", { status: 405 })]) {
    const urls = [];
    const client = make(async (url) => { urls.push(url.replace(/^.*\/v1/, "/v1")); return urls.length === 1 ? first() : json(finalBody); });
    const stream = client.searchStream({ q: "x" });
    const events = await collect(stream);
    assert.deepEqual(urls, ["/v1/search/stream", "/v1/search"]);
    assert.deepEqual(events.map(e => e.type), ["search.started", "search.results", "search.done"]);
    assert.deepEqual(events.map(e => e.seq), [0, 1, 2]);
    assert.equal(new Set(events.map(e => e.searchId)).size, 1);
    assert.deepEqual(events[1].ids, [id(B), id(A)]);
    assert.equal(stream.transport, "json");
    assert.deepEqual(await stream.response, finalBody);
  }
});

test("transport json skips the stream; transport sse never falls back", async () => {
  const urls = [];
  const events = await collect(make(async (url) => { urls.push(url); return json(finalBody); }).searchStream({ q: "x" }, { transport: "json" }));
  assert.equal(urls.length, 1);
  assert.equal(events.length, 3);
  const client = make(async () => json({}, 404));
  await assert.rejects(collect(client.searchStream({ q: "x" }, { transport: "sse" })), DocSlurpApiError);
});

test("searchStream does not fall back on 401, 402, 403, 422 or 429", async () => {
  for (const status of [401, 402, 403, 422, 429]) {
    let calls = 0;
    const client = make(async () => { calls++; return json({ error: { code: "x" } }, status); });
    const stream = client.searchStream({ q: "x" });
    await assert.rejects(collect(stream), (e) => e instanceof DocSlurpApiError && e.status === status);
    await assert.rejects(stream.response, DocSlurpApiError);
    assert.equal(calls, 1);
  }
});

test("a mid-stream drop before search.results falls back once; after results it does not", async () => {
  const urls = [];
  const client = make(async (url) => {
    urls.push(url.replace(/^.*\/v1/, "/v1"));
    return urls.length === 1 ? sseResponse([sse(frames.slice(0, 2))], { fail: true }) : json(finalBody);
  });
  const events = await collect(client.searchStream({ q: "x" }));
  assert.deepEqual(urls, ["/v1/search/stream", "/v1/search"]);
  assert.deepEqual(events.map(e => e.type), ["search.started", "search.hits", "search.results", "search.done"]);
  assert.deepEqual(events.map(e => e.seq), [0, 1, 2, 3]);
  // The fallback itself failing is not retried again.
  const urls2 = [];
  const failing = make(async (url) => { urls2.push(url); return urls2.length === 1 ? sseResponse([sse(frames.slice(0, 1))]) : json({}, 500); });
  await assert.rejects(collect(failing.searchStream({ q: "x" })), DocSlurpApiError);
  assert.equal(urls2.length, 2);
  // A drop after search.results keeps the answer.
  let calls = 0;
  const late = make(async () => { calls++; return sseResponse([sse(frames.slice(0, 4))], { fail: true }); });
  const stream = late.searchStream({ q: "x" });
  assert.equal((await collect(stream)).at(-1).type, "search.results");
  assert.equal((await stream.response).sessionId, "sess");
  assert.equal(calls, 1);
});

test("aborting stops the request and does not fall back", async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = make(async (_url, init) => {
    calls++;
    return new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode(sse(frames.slice(0, 1)))); init.signal.addEventListener("abort", () => c.error(init.signal.reason)); },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const stream = client.searchStream({ q: "x" }, { signal: controller.signal });
  const seen = [];
  await assert.rejects((async () => { for await (const e of stream) { seen.push(e.type); controller.abort(new Error("stop")); } })(), /stop/);
  assert.deepEqual(seen, ["search.started"]);
  await assert.rejects(stream.response, /stop/);
  assert.equal(calls, 1);
  // Aborted before the request starts.
  const pre = new AbortController(); pre.abort(new Error("early"));
  await assert.rejects(collect(client.searchStream({ q: "x" }, { signal: pre.signal })), /early/);
  assert.equal(calls, 1);
});

test("search.error rejects iteration and response with a typed error", async () => {
  const error = { ...env(1), type: "search.error", error: { code: "rate_limited", message: "raw internal text", status: 429 } };
  const client = make(async () => sseResponse([sse([frames[0], error])]));
  const stream = client.searchStream({ q: "x" });
  const seen = [];
  await assert.rejects((async () => { for await (const e of stream) seen.push(e.type); })(), (e) => e instanceof DocSlurpApiError && e.status === 429 && e.code === "rate_limited" && !e.message.includes("raw internal"));
  assert.deepEqual(seen, ["search.started"]);
  await assert.rejects(stream.response, (e) => e instanceof DocSlurpApiError && e.code === "rate_limited");
});

test("searchStream validates input", () => {
  const client = make(async () => json({}));
  assert.throws(() => client.searchStream({ q: ["a", "b"] }), TypeError);
  assert.throws(() => client.searchStream({ q: "x", queries: [] }), TypeError);
});

test("mergeSearchStream dedupes hits across legs and replaces them with the authoritative order", () => {
  let view = emptySearchStreamView();
  view = mergeSearchStream(view, frames[0]);
  assert.equal(view.status, "searching");
  view = mergeSearchStream(view, frames[1]);
  assert.deepEqual(view.hits.map(h => h.id), [id(A), id(C)]);
  const before = view;
  view = mergeSearchStream(view, frames[2]);
  assert.notEqual(view, before);
  assert.equal(before.hits.length, 2);
  assert.deepEqual(view.hits.map(h => h.id), [id(A), id(B), id(C)]);
  assert.deepEqual(view.hits[0].legs, ["vector", "lexical"]);
  assert.deepEqual(view.hits[0].legRanks, { vector: 0, lexical: 1 });
  assert.equal(view.legs.vector.ms, 40);
  assert.equal(view.final, false);
  view = mergeSearchStream(view, frames[3]);
  assert.equal(view.final, true);
  assert.deepEqual(view.hits.map(h => h.id), [id(B), id(A)]);
  assert.deepEqual(view.hits[1].legs, ["vector", "lexical"]);
  // Late hits never disturb the final list.
  view = mergeSearchStream(view, { ...env(9), type: "search.hits", leg: "graph", hits: [{ id: id(C), legRank: 0, result: C }], truncated: false });
  assert.deepEqual(view.hits.map(h => h.id), [id(B), id(A)]);
  view = mergeSearchStream(view, frames[4]);
  assert.equal(view.status, "complete");
  assert.equal(foldSearchStream(frames).status, "complete");
  const errored = mergeSearchStream(emptySearchStreamView(), { ...env(0), type: "search.error", error: { code: "x", message: "m", status: 500 } });
  assert.equal(errored.status, "error");
});
