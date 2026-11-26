import assert from "node:assert/strict";
import { test } from "node:test";
import { BULK_DOCUMENTS_MAX, createDocSlurpClient, DocSlurpBulkDocumentsPartialError } from "../dist/index.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const estimate = { pages: 3, documents: 1, billing: "disabled", credits: null, seconds: { low: 1, high: 2 }, basis: "test" };
const job = { id: "j1", kind: "reindex", status: "queued", queue: { position: 1, ahead: 0 }, runIds: [], estimate, statusUrl: "/v1/jobs/j1" };

function recorder(respond = () => json({ estimate, billing: "disabled" })) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url).replace("https://x.test", ""), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return respond(calls.at(-1));
  };
  return { calls, client: createDocSlurpClient({ apiUrl: "https://x.test", apiKey: "k", project: "ws1", fetch }) };
}

test("estimate methods hit their *-estimate routes with the mutation body", async () => {
  const { calls, client } = recorder();
  await client.updateProjectEstimate(undefined, { pipeline: { chunking: "x" }, apply: "reindex" });
  await client.updateProjectEstimate("other", { retainDocumentVersions: 3 });
  await client.updateSearchSettingsEstimate("ws1", { reranker: "on" });
  await client.reprocessEstimate("run/1", { stages: ["embed"] });
  await client.fullIndexEstimate({ documentId: "d1" });
  await client.fullIndexEstimate({ documentIds: ["d1", "d2"] });
  await client.rebuildGraphEstimate({ project: "g" });
  await client.uploadEstimate({ files: [{ name: "a.pdf", size: 10, pages: 4 }] });
  await client.setIndexingModeEstimate("map");
  await client.uploadEstimate({ files: [{ name: "b.pdf", size: 5 }], project: "Legal Contracts" });
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ["POST", "/v1/projects/ws1/estimate"],
    ["POST", "/v1/projects/other/estimate"],
    ["POST", "/v1/projects/ws1/search-settings/estimate"],
    ["POST", "/v1/runs/run%2F1/reprocess/estimate"],
    ["POST", "/v1/documents/d1/full-index/estimate"],
    ["POST", "/v1/projects/ws1/full-index/estimate"],
    ["POST", "/v1/projects/g/graph/jobs/estimate"],
    ["POST", "/v1/uploads/estimate"],
    ["POST", "/v1/projects/ws1/indexing-mode/estimate"],
    ["POST", "/v1/uploads/estimate"],
  ]);
  assert.deepEqual(calls[0].body, { pipeline: { chunking: "x" }, apply: "reindex" });
  assert.deepEqual(calls[5].body, { documentIds: ["d1", "d2"] });
  // The project selects the route and never leaks into the graph estimate body.
  assert.deepEqual(calls[6].body, {});
  // Upload estimates default to the client project; a per-call project (ID, slug or name) wins.
  assert.deepEqual(calls[7].body, { files: [{ name: "a.pdf", size: 10, pages: 4 }], project: "ws1" });
  assert.deepEqual(calls[8].body, { mode: "map" });
  assert.deepEqual(calls[9].body, { files: [{ name: "b.pdf", size: 5 }], project: "Legal Contracts" });
});

test("mutations expose the queued job", async () => {
  const { calls, client } = recorder(() => json({ project: { id: "ws1" }, job }));
  const result = await client.updateProject(undefined, { autoConfirmReindex: true, apply: "reindex" });
  assert.equal(result.job?.id, "j1");
  await client.updateSearchSettings("ws1", { x: 1 });
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [["PATCH", "/v1/projects/ws1"], ["PATCH", "/v1/projects/ws1/search-settings"]]);
  assert.deepEqual(calls[0].body, { autoConfirmReindex: true, apply: "reindex" });
});

test("setRetention targets org or project and validates the range", async () => {
  const { calls, client } = recorder(() => json({}));
  await client.setRetention({ orgId: "o 1" }, 5);
  await client.setRetention({ project: "w" }, null);
  await client.setRetention({}, 2);
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [
    ["PATCH", "/v1/organizations/o%201", { retainDocumentVersions: 5 }],
    ["PATCH", "/v1/projects/w", { retainDocumentVersions: null }],
    ["PATCH", "/v1/projects/ws1", { retainDocumentVersions: 2 }],
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

test("content updates hit their routes and reprocessRun returns one shape for started and deferred runs", async () => {
  const run = { id: "run-2", status: "queued" };
  let deferred = false;
  const { calls, client } = recorder((call) => call.url.endsWith("/reprocess")
    ? json(deferred ? { run, warnings: ["Temporal unavailable"], job } : { ...run, job }, 201)
    : json({ ok: true }));
  assert.deepEqual(await client.reprocessRun("run/1", { stageFrom: "extract-markdown" }), { run, job, warnings: [] });
  deferred = true;
  assert.deepEqual(await client.reprocessRun("run/1"), { run, job, warnings: ["Temporal unavailable"] });
  await client.setDocumentTags("d/1", ["docs"]);
  await client.bulkDocuments({ action: "delete", documentIds: ["d1", "d2"] });
  await client.reprocessIngestRecommendation(undefined, { recommendationId: "vision-all-pages" });
  await client.applyIngestRecommendation("other", { recommendationId: "preserve-tables", runId: "r1" });
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [
    ["POST", "/v1/runs/run%2F1/reprocess", { stageFrom: "extract-markdown" }],
    ["POST", "/v1/runs/run%2F1/reprocess", {}],
    ["PUT", "/v1/documents/d%2F1/tags", { tags: ["docs"] }],
    ["POST", "/v1/documents/bulk", { action: "delete", documentIds: ["d1", "d2"] }],
    ["POST", "/v1/projects/ws1/ingest-report/reprocess", { recommendationId: "vision-all-pages" }],
    ["POST", "/v1/projects/other/ingest-report/apply", { recommendationId: "preserve-tables", runId: "r1" }],
  ]);
});

test("reindexProject and its estimate hit the reindex routes; a locked update surfaces the re-index details", async () => {
  const signature = "b".repeat(64);
  const { calls, client } = recorder((call) => call.url.endsWith("/reindex")
    ? json({ project: { id: "ws1" }, changedSettings: ["embedding"], impact: { kind: "reindex-required", stages: ["embed"], reasons: [], documents: 1, pages: 3 }, estimate, runIds: ["r1"], job })
    : call.method === "PATCH"
      ? json({ error: { code: "reindex_required", message: "Locked index settings changed: embedding.", details: { reindex: { lockedSettings: ["embedding"], documents: 1, pages: 3, credits: null, signature, reindexUrl: "/v1/projects/ws1/reindex" } }, requestId: "q1" } }, 409)
      : json({ estimate, billing: "disabled", lockedSettings: ["embedding"], signature }));
  const priced = await client.reindexProjectEstimate(undefined, { pipeline: { embedding: { profile: "fastest-local" } } });
  assert.equal(priced.signature, signature);
  const result = await client.reindexProject(undefined, { pipeline: { embedding: { profile: "fastest-local" } }, confirmEstimate: signature });
  assert.deepEqual(result.runIds, ["r1"]);
  await client.reindexProject("other");
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ["POST", "/v1/projects/ws1/reindex/estimate"], ["POST", "/v1/projects/ws1/reindex"], ["POST", "/v1/projects/other/reindex"],
  ]);
  assert.deepEqual(calls[1].body, { pipeline: { embedding: { profile: "fastest-local" } }, confirmEstimate: signature });
  assert.deepEqual(calls[2].body, {});
  await assert.rejects(client.updateProject(undefined, { pipeline: { embedding: { profile: "fastest-local" } } }), (error) => {
    assert.equal(error.code, "reindex_required");
    assert.deepEqual(error.reindex?.lockedSettings, ["embedding"]);
    assert.equal(error.reindex?.signature, signature);
    return true;
  });
});

test("bulkDocuments splits deletes and tag changes into requests of at most 500 and merges them; reprocess over 500 is refused", async () => {
  const ids = Array.from({ length: 1_050 }, (_, i) => `d${i}`);
  const { calls, client } = recorder((call) => json({ deleted: call.body.documentIds.length, documentIds: call.body.documentIds }));
  assert.equal(BULK_DOCUMENTS_MAX, 500);
  assert.deepEqual(await client.bulkDocuments({ action: "delete", documentIds: ids }), { deleted: 1_050, documentIds: ids });
  assert.deepEqual(calls.map((call) => call.body.documentIds.length), [500, 500, 50]);
  // Up to the limit, one request as before.
  calls.length = 0;
  await client.bulkDocuments({ action: "delete", documentIds: ids.slice(0, 500) });
  assert.equal(calls.length, 1);
  // Reprocess and export cannot be merged across requests: refused before anything is sent.
  calls.length = 0;
  await assert.rejects(client.bulkDocuments({ action: "reprocess", documentIds: ids.slice(0, 501) }), RangeError);
  assert.equal(calls.length, 0);
});

test("a bulkDocuments request failing part-way reports what completed and what remains", async () => {
  const ids = Array.from({ length: 1_200 }, (_, i) => `d${i}`);
  let sent = 0;
  const { client } = recorder((call) => (sent++ === 1
    ? json({ error: { code: "unavailable", message: "busy", requestId: "q" } }, 503)
    : json({ updated: call.body.documentIds.length, documentIds: call.body.documentIds })));
  await assert.rejects(client.bulkDocuments({ action: "apply-tags", documentIds: ids, tags: ["t"] }), (error) => {
    assert.ok(error instanceof DocSlurpBulkDocumentsPartialError);
    assert.deepEqual(error.completed, { updated: 500, documentIds: ids.slice(0, 500) });
    assert.deepEqual(error.remainingDocumentIds, ids.slice(500));
    return true;
  });
});

test("a server-side partial delete in a later request counts its deleted ids, and a retry with remainingDocumentIds succeeds", async () => {
  const ids = Array.from({ length: 1_100 }, (_, i) => `d${i}`);
  const gone = new Set();
  let requests = 0;
  const { calls, client } = recorder((call) => {
    requests++;
    const asked = call.body.documentIds;
    // The second request deletes its first 200 documents, then stops (the server's bulk_delete_partial).
    if (requests === 2) {
      const deletedDocumentIds = asked.slice(0, 200);
      deletedDocumentIds.forEach((id) => gone.add(id));
      return json({ error: { code: "unavailable", message: "stopped", requestId: "q", details: {
        policy: "bulk_delete_partial", deleted: 200, deletedDocumentIds, remainingDocumentIds: asked.slice(200),
      } } }, 503);
    }
    // The server refuses any id it has already deleted (404), as the route does.
    if (asked.some((id) => gone.has(id))) return json({ error: { code: "not_found", message: "Document not found", requestId: "q" } }, 404);
    asked.forEach((id) => gone.add(id));
    return json({ deleted: asked.length, documentIds: asked });
  });
  let partial;
  await assert.rejects(client.bulkDocuments({ action: "delete", documentIds: ids }), (error) => {
    assert.ok(error instanceof DocSlurpBulkDocumentsPartialError);
    partial = error;
    return true;
  });
  // Done: the first request's 500 and the 200 the server reported; remaining: the server's 300 and the unsent 100.
  assert.equal(partial.completed.deleted, 700);
  assert.deepEqual(partial.completed.documentIds, [...ids.slice(0, 500), ...ids.slice(500, 700)]);
  assert.deepEqual(partial.remainingDocumentIds, ids.slice(700));
  assert.equal(calls.length, 2);
  // Retrying exactly the remaining ids deletes the rest; nothing already deleted is named again.
  const retried = await client.bulkDocuments({ action: "delete", documentIds: partial.remainingDocumentIds });
  assert.equal(retried.deleted, 400);
  assert.equal(gone.size, 1_100);
});
