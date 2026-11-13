import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient, DocSlurpApiError, emptySearchStreamView, foldSearchStream, mergeSearchStream, searchResultId } from "../dist/index.js";

const enc = new TextEncoder();
const hit = (documentId, chunkIndex, text = documentId) => ({ score: 1, text, citation: { documentId, chunkIndex, filename: "f.pdf", pageNumber: 1, source: "document", headingPath: [] } });
const id = (r) => searchResultId(r);
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

test("a drop after search.started is an error and never issues a second search", async () => {
  for (const make_ of [
    () => sseResponse([sse(frames.slice(0, 2))], { fail: true }),
    () => sseResponse([sse(frames.slice(0, 2))]),
    () => sseResponse([sse(frames.slice(0, 1)) + "event: search.hits\ndata: {not json\n\n"]),
    () => sseResponse([sse(frames.slice(0, 1)) + "event: search.hits\ndata: [1]\n\n"]),
  ]) {
    const urls = [];
    const client = make(async (url) => { urls.push(url.replace(/^.*\/v1/, "/v1")); return make_(); });
    const stream = client.searchStream({ q: "x" });
    await assert.rejects(collect(stream), (e) => e instanceof DocSlurpApiError && e.code === "stream_interrupted");
    await assert.rejects(stream.response, (e) => e instanceof DocSlurpApiError && e.code === "stream_interrupted");
    assert.deepEqual(urls, ["/v1/search/stream"]);
  }
  // A connection failure before any response still falls back once.
  const urls = [];
  const down = make(async (url) => { urls.push(url.replace(/^.*\/v1/, "/v1")); if (urls.length === 1) throw new TypeError("fetch failed"); return json(finalBody); });
  const events = await collect(down.searchStream({ q: "x" }));
  assert.deepEqual(urls, ["/v1/search/stream", "/v1/search"]);
  assert.deepEqual(events.map(e => e.type), ["search.started", "search.results", "search.done"]);
  assert.equal("projectId" in events[0] && events[0].projectId, "p");
  // A 5xx from the stream endpoint is an answer, not a missing endpoint.
  let calls = 0;
  const failing = make(async () => { calls++; return json({ error: { code: "boom" } }, 500); });
  await assert.rejects(collect(failing.searchStream({ q: "x" })), (e) => e instanceof DocSlurpApiError && e.status === 500);
  assert.equal(calls, 1);
  // A drop after search.results keeps the answer.
  let late_calls = 0;
  const late = make(async () => { late_calls++; return sseResponse([sse(frames.slice(0, 4))], { fail: true }); });
  const stream = late.searchStream({ q: "x" });
  assert.equal((await collect(stream)).at(-1).type, "search.results");
  assert.equal((await stream.response).sessionId, "sess");
  assert.equal(late_calls, 1);
});

test("response and iteration work in either order, together, and alone", async () => {
  const client = make(async () => sseResponse([sse(frames)]));
  const types = frames.map(f => f.type);
  // response first, then iterate: nothing is lost.
  let s = client.searchStream({ q: "x" });
  let p = s.response;
  assert.deepEqual((await collect(s)).map(e => e.type), types);
  assert.equal((await p).sessionId, "sess");
  // iterate first, then response.
  s = client.searchStream({ q: "x" });
  assert.deepEqual((await collect(s)).map(e => e.type), types);
  assert.equal((await s.response).sessionId, "sess");
  // both together.
  s = client.searchStream({ q: "x" });
  const [events, body] = await Promise.all([collect(s), s.response]);
  assert.deepEqual(events.map(e => e.type), types);
  assert.equal(body.sessionId, "sess");
  // response only, iterate only.
  assert.equal((await client.searchStream({ q: "x" }).response).sessionId, "sess");
  assert.deepEqual((await collect(client.searchStream({ q: "x" }))).map(e => e.seq), [0, 1, 2, 3, 4]);
  // A second iterator is refused.
  s = client.searchStream({ q: "x" });
  await collect(s);
  assert.throws(() => s[Symbol.asyncIterator](), /once/);
  // Breaking out of iteration while response is wanted still resolves the answer.
  s = client.searchStream({ q: "x" });
  p = s.response;
  for await (const _e of s) break;
  assert.equal((await p).sessionId, "sess");
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

test("mergeSearchStream handles body-less hits, keys legs and phases by sub-search, and ids include the stage", () => {
  const page = { ...hit("a", 0), retrieval: { stage: "page-text" } };
  assert.notEqual(searchResultId(page), searchResultId(A));
  assert.equal(searchResultId(page), "document:a:page-text:0");
  assert.equal(searchResultId({ ...A, retrieval: { stage: "chunk" } }), searchResultId(A));
  let view = foldSearchStream([
    frames[0],
    { ...env(1), type: "search.phase", phase: "embed", stats: { ms: 5 } },
    { ...env(2), type: "search.phase", phase: "embed", subSearch: 1, stats: { ms: 9 } },
    { ...env(3), type: "search.hits", leg: "vector", hits: [{ id: id(A), legRank: 0, result: A }], truncated: false, stats: { ms: 10 } },
    { ...env(4), type: "search.hits", leg: "vector", subSearch: 1, hits: [{ id: id(A), legRank: 2 }, { id: "document:zz:9", legRank: 3 }], truncated: false, stats: { ms: 30 } },
    { ...env(5), type: "search.hits", leg: "lexical", hits: [{ id: id(A), legRank: 1 }], truncated: false },
  ]);
  assert.deepEqual(view.hits.map(h => h.id), [id(A)]);
  assert.equal(view.hits[0].result, A);
  assert.deepEqual(view.hits[0].legs, ["vector", "lexical"]);
  assert.deepEqual(view.hits[0].legRanks, { vector: 0, lexical: 1 });
  assert.equal(view.phases.embed.ms, 5);
  assert.equal(view.subSearches[1].phases.embed.ms, 9);
  assert.equal(view.legs.vector.ms, 10);
  assert.equal(view.subSearches[1].legs.vector.ms, 30);
  assert.equal(view.subSearches[1].legs.vector.hits, 2);
});

// Drift guard: the SDK keeps hand-copied types, so events built the SDK's way must parse with the shared contract.
// The SDK does not depend on @docslurp/shared; this reads its built output by path and skips when it is not built.
const shared = await import("../../shared/dist/search-stream.js").catch(() => undefined);

test("SDK events and ids match the shared search stream contract", { skip: shared ? false : "build @docslurp/shared first" }, async () => {
  const { searchStreamEventSchema, searchResultId: sharedId } = shared;
  const results = [
    A,
    { ...hit("p", 3), retrieval: { stage: "page-text" } },
    { ...hit("c", 1), retrieval: { stage: "chunk" } },
    { ...hit("g", 2), citation: { documentId: "g", chunkIndex: 2, filename: "g", source: "community_summary", headingPath: [] } },
    { ...hit("w", 0), citation: { documentId: "https://example.com/q", chunkIndex: 0, filename: "web", source: "web", headingPath: [] } },
  ];
  for (const r of results) assert.equal(searchResultId(r), sharedId(r));
  // Events from the real client (SSE and JSON fallback) and from the documented shapes all parse.
  const withBodyless = [
    ...frames.slice(0, 3),
    { ...env(9), type: "search.hits", leg: "graph", subSearch: 1, hits: [{ id: id(A), legRank: 0 }], truncated: true, stats: { ms: 3, candidates: 4, timedOut: false } },
    { ...env(10), type: "search.phase", phase: "rerank", subSearch: 0, stats: { ms: 2 } },
    ...frames.slice(3),
  ];
  for (const e of withBodyless) assert.ok(searchStreamEventSchema.safeParse(e).success, JSON.stringify(searchStreamEventSchema.safeParse(e).error?.issues));
  const fallback = await collect(make(async (url) => url.endsWith("/stream") ? json({}, 404) : json({ ...finalBody, results: results })).searchStream({ q: "x" }));
  for (const e of fallback) assert.ok(searchStreamEventSchema.safeParse(e).success, JSON.stringify(searchStreamEventSchema.safeParse(e).error?.issues));
  assert.deepEqual(fallback.find(e => e.type === "search.results").ids, results.map(sharedId));
  // The SDK view is folded from shared-parsed events without loss.
  const parsed = withBodyless.map(e => searchStreamEventSchema.parse(e));
  assert.equal(foldSearchStream(parsed).status, "complete");
});

test("searchStream accepts a search.results frame larger than 1 MiB", async () => {
  const big = { ...A, text: "x".repeat(3 * 1_048_576) };
  const body = { results: [big], sessionId: "sess", usage: {}, availability: null };
  const events = [frames[0], { ...env(1), type: "search.results", ids: [id(big)], response: body }, { ...env(2), type: "search.done", sessionId: "sess", resultCount: 1 }];
  const text = sse(events);
  const chunks = []; for (let i = 0; i < text.length; i += 65536) chunks.push(text.slice(i, i + 65536));
  const stream = make(async () => sseResponse(chunks)).searchStream({ q: "x" });
  assert.deepEqual((await collect(stream)).map(e => e.type), ["search.started", "search.results", "search.done"]);
  assert.equal((await stream.response).results[0].text.length, 3 * 1_048_576);
});
