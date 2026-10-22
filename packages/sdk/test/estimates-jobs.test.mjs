import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient } from "../dist/index.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const estimate = { pages: 3, documents: 1, billing: "disabled", credits: null, seconds: { low: 1, high: 2 }, basis: "test" };
const job = { id: "j1", kind: "reindex", status: "queued", queue: { position: 1, ahead: 0 }, runIds: [], estimate, statusUrl: "/v1/jobs/j1" };

function recorder(respond = () => json({ estimate, billing: "disabled" })) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url).replace("https://x.test", ""), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return respond(calls.at(-1));
  };
  return { calls, client: createDocSlurpClient({ apiUrl: "https://x.test", apiKey: "k", workspace: "ws1", fetch }) };
}

test("estimate methods hit their *-estimate routes with the mutation body", async () => {
  const { calls, client } = recorder();
  await client.updateWorkspaceEstimate(undefined, { pipeline: { chunking: "x" }, apply: "reindex" });
  await client.updateWorkspaceEstimate("other", { retainDocumentVersions: 3 });
  await client.updateSearchSettingsEstimate("ws1", { reranker: "on" });
  await client.reprocessEstimate("run/1", { stages: ["embed"] });
  await client.fullIndexEstimate({ documentId: "d1" });
  await client.fullIndexEstimate({ documentIds: ["d1", "d2"] });
  await client.rebuildGraphEstimate({ workspace: "g" });
  await client.uploadEstimate({ files: [{ name: "a.pdf", size: 10, pages: 4 }] });
  await client.setIndexingModeEstimate("map");
  await client.uploadEstimate({ files: [{ name: "b.pdf", size: 5 }], workspace: "Legal Contracts" });
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ["POST", "/v1/workspaces/ws1/estimate"],
    ["POST", "/v1/workspaces/other/estimate"],
    ["POST", "/v1/workspaces/ws1/search-settings/estimate"],
    ["POST", "/v1/runs/run%2F1/reprocess/estimate"],
    ["POST", "/v1/documents/d1/full-index/estimate"],
    ["POST", "/v1/workspaces/ws1/full-index/estimate"],
    ["POST", "/v1/workspaces/g/graph/jobs/estimate"],
    ["POST", "/v1/uploads/estimate"],
    ["POST", "/v1/workspaces/ws1/indexing-mode/estimate"],
    ["POST", "/v1/uploads/estimate"],
  ]);
  assert.deepEqual(calls[0].body, { pipeline: { chunking: "x" }, apply: "reindex" });
  assert.deepEqual(calls[5].body, { documentIds: ["d1", "d2"] });
  // The workspace selects the route and never leaks into the graph estimate body.
  assert.deepEqual(calls[6].body, {});
  // Upload estimates default to the client workspace; a per-call workspace (ID, slug or name) wins.
  assert.deepEqual(calls[7].body, { files: [{ name: "a.pdf", size: 10, pages: 4 }], workspace: "ws1" });
  assert.deepEqual(calls[8].body, { mode: "map" });
  assert.deepEqual(calls[9].body, { files: [{ name: "b.pdf", size: 5 }], workspace: "Legal Contracts" });
});

test("mutations expose the queued job", async () => {
  const { calls, client } = recorder(() => json({ workspace: { id: "ws1" }, job }));
  const result = await client.updateWorkspace(undefined, { autoConfirmReindex: true, apply: "reindex" });
  assert.equal(result.job?.id, "j1");
  await client.updateSearchSettings("ws1", { x: 1 });
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [["PATCH", "/v1/workspaces/ws1"], ["PATCH", "/v1/workspaces/ws1/search-settings"]]);
  assert.deepEqual(calls[0].body, { autoConfirmReindex: true, apply: "reindex" });
});

test("setRetention targets org or workspace and validates the range", async () => {
  const { calls, client } = recorder(() => json({}));
  await client.setRetention({ orgId: "o 1" }, 5);
  await client.setRetention({ workspace: "w" }, null);
  await client.setRetention({}, 2);
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [
    ["PATCH", "/v1/organizations/o%201", { retainDocumentVersions: 5 }],
    ["PATCH", "/v1/workspaces/w", { retainDocumentVersions: null }],
    ["PATCH", "/v1/workspaces/ws1", { retainDocumentVersions: 2 }],
  ]);
  assert.throws(() => client.setRetention({}, 0), RangeError);
  assert.throws(() => client.setRetention({}, 101), RangeError);
});

test("getJob reads /v1/jobs/:id", async () => {
  const { calls, client } = recorder(() => json(job));
  assert.equal((await client.getJob("j1")).status, "queued");
  assert.equal(calls[0].url, "/v1/jobs/j1");
});

test("streamJob follows SSE until done", async () => {
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  // The real wire format: `status` and `done` are the flat job, `progress` is `{ id, ...counts }`.
  const progress = { documents: 1, documentsTotal: 2, pages: 3, pagesTotal: 6 };
  const body = sse("status", { ...job, status: "processing" }) + sse("progress", { id: "j1", ...progress }) + sse("done", { ...job, status: "completed", progress });
  const { calls, client } = recorder(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const seen = [];
  for await (const e of client.streamJob("j1")) seen.push([e.event, e.job.status, e.job.progress]);
  assert.deepEqual(seen, [["status", "processing", undefined], ["progress", "processing", progress], ["done", "completed", progress]]);
  assert.equal(calls[0].url, "/v1/jobs/j1/events");
});

test("streamJob keeps the last progress across status frames and ignores unknown events", async () => {
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const progress = { documents: 1, documentsTotal: 2, pages: 3, pagesTotal: 6 };
  const body = sse("status", { ...job, status: "processing" }) + sse("progress", { id: "j1", ...progress })
    + sse("heartbeat", { at: 1 }) + sse("status", { ...job, status: "processing", runIds: ["r1"] }) + sse("done", { ...job, status: "completed" });
  const { client } = recorder(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const seen = [];
  for await (const e of client.streamJob("j1")) seen.push([e.event, e.job.status, e.job.progress]);
  assert.deepEqual(seen, [
    ["status", "processing", undefined], ["progress", "processing", progress],
    ["status", "processing", progress], ["done", "completed", progress],
  ]);
});

test("streamJob falls back to polling when the stream is unavailable", async () => {
  const states = ["queued", "queued", "processing", "completed"];
  let polls = 0;
  const { calls, client } = recorder(({ url }) => url.endsWith("/events") ? json({ error: "no" }, 404) : json({ ...job, status: states[polls++] }));
  const seen = [];
  for await (const e of client.streamJob("j1", { pollIntervalMs: 1 })) seen.push([e.event, e.job.status]);
  assert.deepEqual(seen, [["status", "queued"], ["status", "processing"], ["done", "completed"]]);
  assert.equal(calls[0].url, "/v1/jobs/j1/events");
  assert.equal(calls[1].url, "/v1/jobs/j1");
});

test("streamJob falls back to polling when SSE drops mid-stream", async () => {
  const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const { calls, client } = recorder(({ url }) => {
    if (!url.endsWith("/events")) return json({ ...job, status: "completed" });
    let sent = false;
    const stream = new ReadableStream({ pull(c) { if (sent) throw new Error("socket reset"); sent = true; c.enqueue(new TextEncoder().encode(sse("status", { job }))); } });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });
  const seen = [];
  for await (const e of client.streamJob("j1", { pollIntervalMs: 1 })) seen.push([e.event, e.job.status]);
  assert.deepEqual(seen, [["status", "queued"], ["done", "completed"]]);
  assert.equal(calls.at(-1).url, "/v1/jobs/j1");
});

test("streamJob aborts during polling and during SSE", async () => {
  const polling = recorder(({ url }) => url.endsWith("/events") ? json({}, 404) : json(job));
  const controller = new AbortController();
  const seen = [];
  await assert.rejects(async () => {
    for await (const e of polling.client.streamJob("j1", { signal: controller.signal, pollIntervalMs: 5 })) { seen.push(e); controller.abort(new Error("stop")); }
  }, /stop/);
  assert.equal(seen.length, 1);

  const sseAbort = new AbortController();
  const sse = recorder(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`event: status\ndata: ${JSON.stringify({ job })}\n\n`)); } }), { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(async () => {
    for await (const e of sse.client.streamJob("j1", { signal: sseAbort.signal })) sseAbort.abort(new Error("halt"));
  }, /halt/);
});

test("streamJob keeps waiting while blocked but times out otherwise", async () => {
  let polls = 0;
  const blocked = recorder(({ url }) => url.endsWith("/events") ? json({}, 404) : json({ ...job, status: ++polls < 6 ? "blocked" : "completed", reason: "credits" }));
  const seen = [];
  for await (const e of blocked.client.streamJob("j1", { pollIntervalMs: 5, timeoutMs: 20 })) seen.push(e.job.status);
  assert.deepEqual(seen, ["blocked", "completed"]);
  assert.ok(polls >= 6);

  const stuck = recorder(({ url }) => url.endsWith("/events") ? json({}, 404) : json(job));
  await assert.rejects(async () => { for await (const _ of stuck.client.streamJob("j1", { pollIntervalMs: 5, timeoutMs: 20 })); }, { name: "DocSlurpTimeoutError" });
});
