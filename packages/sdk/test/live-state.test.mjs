import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createDocSlurpClient, DocSlurpApiError, DocSlurpTimeoutError } from "../dist/index.js";

const snapshot = (completed, status = "processing") => ({
  run: { id: "run/id", status, controlState: null, pagesTotal: 10, pagesProcessed: completed, totalDocuments: 1, processedDocuments: status === "completed" ? 1 : 0 }, stages: [], recentEvents: [], temporal: null, stats: {}, artifacts: {},
  progress: { lifecycleStatus: status, percentComplete: completed * 10, pageRollup: { completed, total: 10, byStage: { extract: completed }, byDocument: {} }, usageTotals: { inputTokens: completed * 100, outputTokens: completed, costCents: completed / 10 }, resourceTotals: { elapsedMs: completed * 1000, cpuUserMs: 0, cpuSystemMs: 0, cpuTotalMs: 0, rssDeltaBytes: 0, peakRssBytes: 0 }, stageRollups: [], phases: [] },
});
async function http(handler, task) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = createDocSlurpClient({ apiUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "fixture", workspaceId: "work/id" });
  try { await task(client); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
function json(response, body, status = 200) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
function frame(response, value) { response.write(`event: snapshot\ndata: ${JSON.stringify(value)}\n\n`); }

test("progress HTTP stream yields live page, usage and resource snapshots and closes at terminal state", async () => {
  let disconnected = false;
  await http((request, response) => {
    assert.equal(request.url, "/v1/runs/run%2Fid/progress/stream");
    assert.equal(request.headers.authorization, "Bearer fixture");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.on("close", () => { disconnected = true; });
    response.write('event: heartbeat\ndata: {}\n\n');
    frame(response, snapshot(2));
    setTimeout(() => frame(response, snapshot(10, "completed")), 15);
  }, async client => {
    const values = [];
    for await (const value of client.streamProgress("run/id")) values.push(value);
    assert.deepEqual(values.map(value => value.progress.pageRollup.completed), [2, 10]);
    assert.equal(values[1].progress.usageTotals.inputTokens, 1000);
    assert.equal(values[1].progress.resourceTotals.elapsedMs, 10000);
    for (let i = 0; !disconnected && i < 20; i++) await delay(10);
    assert.equal(disconnected, true);
  });
});

test("auto progress recovers disconnect through authoritative polling without duplicate snapshots", async () => {
  let polls = 0;
  await http((request, response) => {
    if (request.url.endsWith("/stream")) {
      response.writeHead(200, { "content-type": "text/event-stream" }); frame(response, snapshot(2)); response.end();
    } else { assert.equal(request.url, "/v1/runs/run%2Fid/progress"); json(response, ++polls === 1 ? snapshot(2) : snapshot(10, "completed")); }
  }, async client => {
    const values = [];
    for await (const value of client.streamProgress("run/id", { pollIntervalMs: 1 })) values.push(value);
    assert.deepEqual(values.map(value => value.progress.pageRollup.completed), [2, 10]);
    assert.equal(polls, 2);
  });
});

test("unsupported SSE uses polling; explicit SSE and auth or malformed payload do not fall back", async () => {
  for (const [status, body, fallback] of [[405, "unsupported", true], [403, "forbidden", false], [404, "missing", false], [200, "broken", false]]) {
    let polls = 0;
    await http((request, response) => {
      if (!request.url.endsWith("/stream")) { polls++; json(response, snapshot(10, "completed")); return; }
      if (status === 200) { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`event: snapshot\ndata: ${JSON.stringify({ run: {} })}\n\n`); }
      else json(response, { error: body }, status);
    }, async client => {
      const collect = async () => { for await (const _ of client.streamProgress("run/id")) {} };
      if (fallback) await collect(); else await assert.rejects(collect);
      assert.equal(polls, fallback ? 1 : 0);
    });
  }
  await http((_, response) => json(response, { error: "unsupported" }, 405), async client => {
    await assert.rejects(async () => { for await (const _ of client.streamProgress("run/id", { transport: "sse" })) {} }, error => error instanceof DocSlurpApiError && error.status === 405);
  });
});

test("progress early return, cancellation and overall timeout close idle HTTP readers", async () => {
  for (const mode of ["return", "abort", "timeout"]) {
    let disconnected = false;
    await http((_, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" }); frame(response, snapshot(1));
      response.on("close", () => { disconnected = true; });
    }, async client => {
      const controller = new AbortController();
      const reason = new Error("stop");
      const iterator = client.streamProgress("run/id", { signal: controller.signal, timeoutMs: mode === "timeout" ? 50 : 1000 });
      assert.equal((await iterator.next()).value.progress.pageRollup.completed, 1);
      if (mode === "return") await iterator.return();
      else {
        const pending = iterator.next();
        if (mode === "abort") controller.abort(reason);
        await assert.rejects(pending, error => mode === "abort" ? error === reason : error instanceof DocSlurpTimeoutError);
      }
      for (let i = 0; !disconnected && i < 20; i++) await delay(10);
      assert.equal(disconnected, true);
    });
  }
});

test("paused stays observable and failed terminal snapshot is yielded without throwing", async () => {
  let polls = 0;
  await http((_, response) => { const state = snapshot(3, ++polls === 1 ? "processing" : "failed"); if (polls === 1) { state.run.controlState = "paused"; state.progress.lifecycleStatus = "paused"; } json(response, state); }, async client => {
    const values = [];
    for await (const value of client.streamProgress("run/id", { transport: "poll", pollIntervalMs: 1 })) values.push(value);
    assert.equal(values.length, 2); assert.equal(values[1].run.status, "failed");
  });
});

test("polling keeps a fixed rhythm and heartbeatMs re-yields the latest snapshot", async () => {
  let polls = 0;
  await http((_, response) => { polls++; json(response, snapshot(3)); }, async client => {
    const at = [];
    const started = Date.now();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("done")), 230);
    await assert.rejects(async () => {
      for await (const value of client.streamProgress("run/id", { transport: "poll", pollIntervalMs: 10, heartbeatMs: 50, signal: controller.signal })) {
        assert.equal(value.progress.pageRollup.completed, 3);
        at.push(Date.now() - started);
      }
    }, /done/);
    // Heartbeats re-yield the unchanged snapshot, and polling keeps running faster than the heartbeat.
    assert.ok(at.length >= 3, `yields at ${at}`);
    assert.ok(polls > at.length, `${polls} polls`);
  });
});

test("SSE heartbeatMs re-yields during quiet streams, and early return stops promptly", async () => {
  let disconnected = false;
  await http((_, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); frame(response, snapshot(4));
    const beat = setInterval(() => response.write("event: heartbeat\ndata: {}\n\n"), 10);
    const done = setTimeout(() => frame(response, snapshot(10, "completed")), 130);
    response.on("close", () => { clearInterval(beat); clearTimeout(done); disconnected = true; });
  }, async client => {
    const values = [];
    for await (const value of client.streamProgress("run/id", { transport: "sse", heartbeatMs: 40 })) values.push(value.progress.pageRollup.completed);
    assert.equal(values[0], 4);
    assert.equal(values.at(-1), 10);
    assert.ok(values.filter(value => value === 4).length >= 3, `values ${values}`);
  });
  await http((_, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" }); frame(response, snapshot(4));
    response.on("close", () => { disconnected = true; });
  }, async client => {
    disconnected = false;
    const iterator = client.streamProgress("run/id", { transport: "sse", heartbeatMs: 30, timeoutMs: 10_000 });
    assert.equal((await iterator.next()).value.progress.pageRollup.completed, 4);
    assert.equal((await iterator.next()).value.progress.pageRollup.completed, 4); // heartbeat
    const started = Date.now();
    await iterator.return();
    assert.ok(Date.now() - started < 500, "return did not wait for the stream deadline");
    for (let i = 0; !disconnected && i < 20; i++) await delay(10);
    assert.equal(disconnected, true);
  });
});

test("idleTimeoutMs stops a stream whose snapshots stop changing, even with heartbeats", async () => {
  for (const transport of ["sse", "poll"]) {
    let disconnected = false;
    await http((request, response) => {
      if (transport === "poll") { json(response, snapshot(3)); return; }
      response.writeHead(200, { "content-type": "text/event-stream" }); frame(response, snapshot(3));
      const beat = setInterval(() => { response.write("event: heartbeat\ndata: {}\n\n"); frame(response, snapshot(3)); }, 10);
      response.on("close", () => { clearInterval(beat); disconnected = true; });
    }, async client => {
      const values = [];
      const started = Date.now();
      await assert.rejects(async () => {
        for await (const value of client.streamProgress("run/id", { transport, idleTimeoutMs: 80, pollIntervalMs: 10, timeoutMs: 5_000 })) values.push(value);
      }, error => error instanceof DocSlurpTimeoutError && error.run?.id === "run/id");
      assert.equal(values.length, 1);
      assert.ok(Date.now() - started < 1_000, transport);
      if (transport === "sse") { for (let i = 0; !disconnected && i < 20; i++) await delay(10); assert.equal(disconnected, true); }
    });
  }
});

test("overall timeout retains the last run; bounds are validated", async () => {
  await http((_, response) => json(response, snapshot(3)), async client => {
    await assert.rejects(async () => { for await (const _ of client.streamProgress("run/id", { transport: "poll", pollIntervalMs: 5, timeoutMs: 400 })) {} },
      error => error instanceof DocSlurpTimeoutError && error.run?.pagesProcessed === 3);
    for (const options of [{ timeoutMs: 0 }, { idleTimeoutMs: -1 }, { pollIntervalMs: NaN }, { heartbeatMs: 0 }, { transport: "carrier-pigeon" }]) {
      await assert.rejects(async () => { for await (const _ of client.streamProgress("run/id", options)) {} }, RangeError);
    }
  });
});

test("workspace state uses configured workspace and validates bounded window", async () => {
  await http((request, response) => { assert.equal(request.url, "/v1/workspaces/work%2Fid/state?recentWindowHours=48"); json(response, { pages: { total: 10, indexed: 7, notIndexed: 3 }, storage: { sourceMb: 2.5 } }); }, async client => {
    const value = await client.getWorkspaceState(undefined, { recentWindowHours: 48 }); assert.equal(value.pages.notIndexed, 3); assert.equal(value.storage.sourceMb, 2.5);
    for (const hours of [0, 721, 1.5, NaN]) assert.throws(() => client.getWorkspaceState(undefined, { recentWindowHours: hours }), RangeError);
  });
});

test("ingest report uses the configured workspace and passes run and document scope", async () => {
  const urls = [];
  await http((request, response) => { urls.push(request.url); json(response, { workspaceId: "work/id", files: { total: 2 }, recommendations: [] }); }, async client => {
    const value = await client.getIngestReport(undefined, { runId: "run 1", documentIds: ["a", "b"] });
    assert.equal(value.files.total, 2);
    await client.getIngestReport("other");
    assert.throws(() => client.getIngestReport(undefined, { documentIds: Array.from({ length: 101 }, (_, i) => `d${i}`) }), RangeError);
  });
  assert.deepEqual(urls, ["/v1/workspaces/work%2Fid/ingest-report?runId=run+1&documentIds=a%2Cb", "/v1/workspaces/other/ingest-report"]);
});

test("organization wrappers preserve encoded tenant paths, bodies and response semantics", async () => {
  const calls = [];
  await http(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : null });
    if (request.url === "/v1/organizations" && request.method === "GET") json(response, { organizations: [{ id: "org/id" }] });
    else if (request.url.endsWith("/members") && request.method === "GET") json(response, { memberships: [{ userId: "user/id", email: "member@example.test" }] });
    else if (request.url.endsWith("/api-keys")) json(response, { keys: [{ id: "key" }], revokedCount: 1 });
    else json(response, { id: "org/id", ok: true, counts: { members: 2 }, capabilities: { manageMembers: true } });
  }, async client => {
    assert.equal((await client.listOrganizations())[0].id, "org/id");
    await client.getOrganization("org/id"); await client.getOrganizationDetails("org/id"); await client.getOrganizationAccess("org/id");
    await client.createOrganization({ name: "Team", slug: "team" }); await client.updateOrganization("org/id", { slug: null });
    assert.equal((await client.listOrganizationMembers("org/id"))[0].email, "member@example.test");
    await client.inviteOrganizationMember("org/id", { email: "new@example.test", role: "member" });
    await client.revokeOrganizationInvite("org/id", "invite/id");
    await client.updateOrganizationMemberRole("org/id", "user/id", "billing"); await client.removeOrganizationMember("org/id", "user/id"); await client.leaveOrganization("org/id");
    assert.equal((await client.listOrganizationApiKeys("org/id"))[0].id, "key"); assert.equal((await client.revokeOrganizationApiKeys("org/id")).revokedCount, 1);
    assert.deepEqual(calls.find(call => call.method === "PATCH" && call.path.endsWith("user%2Fid")).body, { role: "billing" });
    assert.deepEqual(calls.find(call => call.method === "PATCH" && call.path === "/v1/organizations/org%2Fid").body, { slug: null });
    assert.equal(calls.filter(call => call.method === "POST" && call.path.endsWith("/leave")).length, 1);
    assert.deepEqual(calls.find(call => call.method === "POST" && call.path === "/v1/organizations/org%2Fid/invites").body, { email: "new@example.test", role: "member" });
    assert.equal(calls.filter(call => call.method === "DELETE" && call.path === "/v1/organizations/org%2Fid/invites/invite%2Fid").length, 1);
  });
});

test("document reads retain the actual nested viewer envelope over HTTP", async () => {
  const viewer = {
    document: { id: "doc/id", filename: "policy.pdf", status: "completed", pageCount: 2, tags: ["hr"] },
    tags: ["hr"], versions: [],
    changelog: { available: false, summary: ["No earlier version is available yet."] },
    stages: [{ stage_name: "extract", status: "completed", attempts: 1, artifact_uri: "s3://fixture/extracted.md", stats: { pages: 2 }, error: null, updated_at: "2026-10-06T18:00:00.000Z" }],
    artifacts: [{ slot: "markdown", uri: "s3://fixture/extracted.md", url: "https://files.example/extracted.md" }],
    source: { key: "original.pdf", url: "https://files.example/original.pdf", filename: "policy.pdf", mimeType: "application/pdf", category: "other", previewable: false },
    pageStats: { pageCount: 2, chunkCount: 4, pageTextCount: 2 }, run: null,
    usage: { document: { inputTokens: 500, outputTokens: 50, costCents: 0.01, events: 2 }, run: null, estimatedDocument: { inputTokens: 500, outputTokens: 50, costCents: 0.01, basis: "document-events" } },
  };
  await http((request, response) => {
    assert.equal(request.url, "/v1/documents/doc%2Fid");
    assert.equal(request.headers.authorization, "Bearer fixture");
    json(response, viewer);
  }, async client => {
    const actual = await client.getDocument("doc/id");
    assert.deepEqual(actual, viewer);
    assert.equal(actual.document.filename, "policy.pdf");
    assert.equal(actual.pageStats.chunkCount, 4);
    assert.equal(actual.usage.estimatedDocument.basis, "document-events");
    assert.equal(actual.stages[0].stage_name, "extract");
    assert.equal(actual.filename, undefined, "the server record is nested, never flattened");
  });
});
