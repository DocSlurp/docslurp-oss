import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient, DocSlurpApiError, DocSlurpTimeoutError } from "../dist/index.js";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});
const result = { project: { id: "project" }, run: { id: "accepted-run" }, documents: [] };
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(status) {
  const calls = [];
  let polls = 0;
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "test-key", fetch: async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, at: Date.now(), method: init.method ?? "GET", auth: new Headers(init.headers).get("authorization") });
    if (href.endsWith("/direct/sessions")) return json({ sessionId: "session", files: [{
      id: "file", clientId: "0", filename: "document.txt", mimeType: "text/plain", sizeBytes: 5,
      mode: "single", putUrl: "https://storage.invalid/document",
    }] }, 201);
    if (href === "https://storage.invalid/document") return new Response(null, { status: 200 });
    if (href.endsWith("?statusOnly=true")) return status(++polls, init);
    if (href.endsWith("/abort")) return json({ ok: true });
    throw new Error(`Unexpected request ${href}`);
  } });
  return { client, calls, polls: () => polls, upload: options => client.upload(new Blob(["hello"]), { directUpload: true, ...options }) };
}

function assertTransferredOnce(api) {
  assert.equal(api.calls.filter(call => call.method === "POST").length, 1, "one session, no abort/re-upload");
  assert.equal(api.calls.filter(call => call.method === "PUT").length, 1);
  assert.equal(api.calls.find(call => call.method === "PUT").auth, null, "storage receives no API credentials");
}

test("upload session status backs off exponentially and caps idle polling at five seconds", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const api = setup(count => json(count === 8 ? { status: "completed", result } : { status: "ingesting" }));
  const pending = api.upload();
  await flush();
  assert.equal(api.polls(), 1, "first status request is immediate");
  for (const delay of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
    const before = api.polls();
    t.mock.timers.tick(delay - 1);
    await flush();
    assert.equal(api.polls(), before);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(api.polls(), before + 1);
  }
  assert.equal((await pending).run.id, "accepted-run");
  assertTransferredOnce(api);
});

test("transient status 429 honors the full Retry-After and observes the same accepted session", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const api = setup(count => count === 1
    ? json({ error: { code: "rate_limited" } }, 429, { "retry-after": "60" })
    : json({ status: "completed", result }));
  const pending = api.upload({ timeoutMs: 120000 });
  await flush();
  t.mock.timers.tick(59999);
  await flush();
  assert.equal(api.polls(), 1);
  t.mock.timers.tick(1);
  assert.equal((await pending).run.id, "accepted-run");
  assert.equal(api.polls(), 2);
  assertTransferredOnce(api);
});

test("repeated 429 without Retry-After uses bounded backoff instead of aborting accepted work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const api = setup(count => count <= 4 ? json({}, 429) : json({ status: "completed", result }));
  const pending = api.upload();
  await flush();
  for (const delay of [250, 500, 1000, 2000]) { t.mock.timers.tick(delay); await flush(); }
  assert.equal((await pending).run.id, "accepted-run");
  assert.equal(api.polls(), 5);
  assertTransferredOnce(api);
});

test("a Retry-After longer than the remaining upload deadline times out without another request or abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const api = setup(() => json({}, 429, { "retry-after": "60" }));
  const rejected = assert.rejects(api.upload({ timeoutMs: 1000 }), error => error instanceof DocSlurpTimeoutError);
  await flush();
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(api.polls(), 1);
  assertTransferredOnce(api);
});

test("pending status requests share the original deadline rather than resetting it after every response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const api = setup(() => json({ status: "ingesting" }));
  const rejected = assert.rejects(api.upload({ timeoutMs: 1000 }), error => error instanceof DocSlurpTimeoutError);
  await flush();
  t.mock.timers.tick(250); await flush();
  t.mock.timers.tick(500); await flush();
  assert.equal(api.polls(), 3);
  t.mock.timers.tick(250);
  await rejected;
  assertTransferredOnce(api);
});

test("cancellation interrupts a rate-limit sleep without aborting the uploaded session", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const api = setup(() => json({}, 429, { "retry-after": "60" }));
  const controller = new AbortController();
  const reason = new Error("Caller cancelled observation");
  const rejected = assert.rejects(api.upload({ signal: controller.signal }), error => error === reason);
  await flush();
  controller.abort(reason);
  await rejected;
  assert.equal(api.polls(), 1);
  assertTransferredOnce(api);
});

test("cancellation reaches an in-flight status fetch and preserves accepted bytes", async () => {
  let statusSignal;
  const api = setup((_count, init) => new Promise((_resolve, reject) => {
    statusSignal = init.signal;
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const reason = new Error("Cancelled during fetch");
  const rejected = assert.rejects(api.upload({ signal: controller.signal }), error => error === reason);
  await flush();
  controller.abort(reason);
  await rejected;
  assert.equal(statusSignal.aborted, true);
  assertTransferredOnce(api);
});

test("authorization refusal while observing a session fails immediately without retry, re-upload or abort", async () => {
  const api = setup(() => json({ error: { code: "forbidden" } }, 403));
  await assert.rejects(api.upload(), error => error instanceof DocSlurpApiError && error.status === 403);
  assert.equal(api.polls(), 1);
  assertTransferredOnce(api);
});

test("terminal failed, aborted and expired sessions remain failures", async () => {
  for (const status of ["failed", "aborted", "expired"]) {
    const api = setup(() => json({ status }));
    await assert.rejects(api.upload(), new RegExp(`Upload session ${status}`));
    assert.equal(api.polls(), 1);
    assertTransferredOnce(api);
  }
});

test("an extremely long Retry-After stays bounded by the upload deadline without timer overflow", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const api = setup(() => json({}, 429, { "retry-after": "3000000000" }));
  const rejected = assert.rejects(api.upload({ timeoutMs: 1000 }), error => error instanceof DocSlurpTimeoutError);
  await flush();
  t.mock.timers.tick(999); await flush();
  assert.equal(api.polls(), 1);
  t.mock.timers.tick(1); await rejected;
  assertTransferredOnce(api);
});

test("status polling preserves two transient gateway retries and then surfaces the failure", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const api = setup(() => json({}, 503));
  const rejected = assert.rejects(api.upload(), error => error instanceof DocSlurpApiError && error.status === 503);
  await flush();
  t.mock.timers.tick(250); await flush();
  t.mock.timers.tick(500); await rejected;
  assert.equal(api.polls(), 3);
  assertTransferredOnce(api);
});

test("an unknown-size stream whose bytes were completed survives a status 429 without abort or replay", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls = [];
  let polls = 0;
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", fetch: async (url, init = {}) => {
    const href = String(url); calls.push({ url: href, method: init.method ?? "GET" });
    if (href.endsWith("/direct/sessions")) return json({ sessionId: "stream", files: [{ id: "file", mode: "multipart", partSize: 4 }] });
    if (href.endsWith("/parts/sign")) return json({ parts: [{ partNumber: 1, url: "https://storage.invalid/part" }] });
    if (href === "https://storage.invalid/part") return new Response(null, { headers: { etag: '"part"' } });
    if (href.endsWith("/files/complete")) return json({ ok: true });
    if (href.endsWith("?statusOnly=true")) return ++polls === 1 ? json({}, 429, { "retry-after": "2" }) : json({ status: "completed", result });
    throw new Error(`Unexpected request ${href}`);
  } });
  async function* source() { yield new TextEncoder().encode("abc"); }
  const pending = client.upload(source());
  await flush();
  t.mock.timers.tick(1999); await flush();
  assert.equal(polls, 1);
  t.mock.timers.tick(1);
  assert.equal((await pending).run.id, "accepted-run");
  assert.equal(calls.filter(call => call.url.endsWith("/direct/sessions")).length, 1);
  assert.equal(calls.filter(call => call.method === "PUT").length, 1);
  assert.equal(calls.some(call => call.url.endsWith("/abort")), false);
});

for (const status of [401, 403]) {
  test(`revoked or wrong-scope status ${status} is not retried after transfer`, async () => {
    const api = setup(() => json({ error: { code: status === 401 ? "unauthorized" : "project_scope_forbidden" } }, status));
    await assert.rejects(api.upload(), error => error instanceof DocSlurpApiError && error.status === status);
    assert.equal(api.polls(), 1);
    assertTransferredOnce(api);
  });
}

test("HTTP-date Retry-After delays observation of the same session", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const retryAt = new Date(Date.now() + 3000).toUTCString();
  const api = setup(count => count === 1 ? json({}, 429, { "retry-after": retryAt }) : json({ status: "completed", result }));
  const pending = api.upload();
  await flush();
  t.mock.timers.tick(2999); await flush();
  assert.equal(api.polls(), 1);
  t.mock.timers.tick(1);
  assert.equal((await pending).run.id, "accepted-run");
  assertTransferredOnce(api);
});

for (const retryAfter of ["invalid-delay", "-3", "Infinity"]) {
  test(`malformed Retry-After ${retryAfter} retains bounded polling backoff`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const api = setup(count => count === 1 ? json({}, 429, { "retry-after": retryAfter }) : json({ status: "completed", result }));
    const pending = api.upload();
    await flush();
    t.mock.timers.tick(249); await flush();
    assert.equal(api.polls(), 1);
    t.mock.timers.tick(1);
    assert.equal((await pending).run.id, "accepted-run");
    assertTransferredOnce(api);
  });
}
