import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createDocSlurpClient, DocSlurpApiError, DocSlurpTimeoutError } from "../dist/index.js";

const client = fetch => createDocSlurpClient({ apiUrl: "https://example.test", apiKey: "fixture", fetch });
const streamResponse = chunks => new Response(new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
}), { headers: { "content-type": "text/event-stream" } });

test("run streaming parses fragmented UTF-8, CRLF, comments and multiline data over actual HTTP", async () => {
  let disconnected = false;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/v1/runs/run%2Fid/events/stream");
    assert.equal(request.headers.authorization, "Bearer fixture");
    assert.equal(request.headers.accept, "text/event-stream");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.on("close", () => { disconnected = true; });
    response.write(": heartbeat\r\nevent: snapshot\r");
    const body = Buffer.from('\ndata: {"run":{"id":"run/id",\r\ndata: "status":"queued"},"label":"café"}\r\n\r\nid: event-1\nevent: run.progress\ndata: {"runId":"run/id"}\n\n');
    const split = body.indexOf(Buffer.from("é")) + 1;
    response.write(body.subarray(0, split));
    setImmediate(() => response.write(body.subarray(split)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const sdk = createDocSlurpClient({ apiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "fixture" });
    const frames = [];
    for await (const frame of sdk.streamRun("run/id")) {
      frames.push(frame);
      if (frames.length === 2) break;
    }
    assert.equal(frames[0].event, "snapshot");
    assert.equal(frames[0].data.run.status, "queued");
    assert.equal(frames[0].data.label, "café");
    assert.equal(frames[1].event, "run.progress");
    assert.equal(frames[1].id, "event-1");
    for (let tries = 0; !disconnected && tries < 20; tries++) await delay(10);
    assert.equal(disconnected, true, "breaking iteration closes the HTTP stream");
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("stream rejects auth failures without silently switching transport", async () => {
  const sdk = client(async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "content-type": "application/json" } }));
  await assert.rejects(async () => { for await (const _frame of sdk.streamRun("run")) {} }, error => error instanceof DocSlurpApiError && error.status === 403);
});

test("stream validates response types, JSON and bounded frame sizes", async () => {
  for (const response of [
    new Response("html"),
    streamResponse(['event: snapshot\ndata: nope\n\n']),
    streamResponse(['data: []\n\n']),
    streamResponse(['data: ' + 'x'.repeat(1_048_577)]),
  ]) {
    await assert.rejects(async () => { for await (const _frame of client(async () => response).streamRun("run")) {} });
  }
});

test("abort and timeout cancel idle readers, even when a custom fetch ignores signals", async () => {
  for (const aborted of [false, true]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const iterator = client(async () => response).streamRun("run", { timeoutMs: 50, signal: controller.signal });
    const pending = iterator.next();
    if (aborted) setTimeout(() => controller.abort(reason), 10);
    await assert.rejects(pending, error => aborted ? error === reason : error instanceof DocSlurpTimeoutError);
    assert.equal(cancelled, true);
  }
});

test("activity stream yields typed events filtered by type and workspace", async () => {
  const frames = [
    'event: activity\ndata: {"runs":[]}\n\n',
    'event: activity-run\ndata: {"id":"run-a","workspaceId":"ws-a"}\n\n',
    'id: e1\nevent: activity-event\ndata: {"type":"document.completed","runId":"run-a","documentId":"doc-new"}\n\n',
    'id: e2\nevent: activity-event\ndata: {"type":"document.replaced","runId":"run-a","documentId":"doc-new","progress":{"canonicalId":"/products","replacedDocumentIds":["doc-old"]}}\n\n',
    'event: activity-run\ndata: {"id":"run-b","workspaceId":"ws-b"}\n\n',
    'id: e3\nevent: activity-event\ndata: {"type":"document.replaced","runId":"run-b","documentId":"doc-b","progress":{}}\n\n',
  ];
  let requested;
  const sdk = client(async (url) => { requested = String(url); return streamResponse(frames); });
  const events = [];
  for await (const event of sdk.streamActivity({ types: ["document.replaced"], workspaceId: "ws-a" })) events.push(event);
  assert.match(requested, /\/v1\/runs\/activity\/stream$/);
  assert.equal(events.length, 1);
  assert.deepEqual(
    { type: events[0].type, id: events[0].id, workspaceId: events[0].workspaceId, documentId: events[0].documentId, progress: events[0].progress },
    { type: "document.replaced", id: "e2", workspaceId: "ws-a", documentId: "doc-new", progress: { canonicalId: "/products", replacedDocumentIds: ["doc-old"] } },
  );
});
