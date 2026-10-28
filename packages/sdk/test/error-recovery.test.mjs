import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient, DocSlurpApiError } from "../dist/index.js";
const json = (body, status, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("a 60 second server wait exceeding the deadline returns timing without retrying", async () => {
  let calls = 0;
  const client = createDocSlurpClient({ apiUrl: "https://example.test", timeoutMs: 10000, fetch: async () => {
    calls++;
    return json({ error: { code: "rate_limited", message: "secret", requestId: "req-1" } }, 429, { "retry-after": "60" });
  } });
  await assert.rejects(client.getRun("run"), error => {
    assert.ok(error instanceof DocSlurpApiError);
    assert.equal(error.retryAfterSeconds, 60);
    assert.equal(error.requestId, "req-1");
    assert.equal(error.code, "rate_limited");
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  assert.equal(calls, 1);
});

test("known refusal codes supply reviewed copy while raw diagnostics remain available", () => {
  const body = { error: { code: "credit_exhausted", message: "secret provider text", requestId: "req-2", details: { secret: "private", retryAfterSeconds: 30 } } };
  const error = new DocSlurpApiError("fallback", 402, body);
  assert.match(error.message, /credits/);
  assert.doesNotMatch(error.message, /secret|temporarily/);
  assert.equal(error.body, body);
  assert.deepEqual(error.details, { retryAfterSeconds: 30 });
  assert.equal(new DocSlurpApiError("fallback", 403, { error: { code: "mfa_required" } }).message.includes("authenticator"), true);
  const unknown = new DocSlurpApiError("fallback", 503, { error: { code: "secret", message: "secret", requestId: "secret\nline" } });
  assert.doesNotMatch(unknown.message, /secret/);
  assert.equal(unknown.requestId, undefined);
});

test("a server wait that fits the deadline is never shortened to five seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const client = createDocSlurpClient({ apiUrl: "https://example.test", timeoutMs: 120000, fetch: async () => {
    calls++;
    return calls === 1 ? json({}, 429, { "retry-after": "60" }) : json({ run: { id: "run" } }, 200);
  } });
  const pending = client.getRun("run");
  // Drain async fetch/body cancellation before moving the mock clock.
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  t.mock.timers.tick(55000);
  assert.equal((await pending).id, "run");
  assert.equal(calls, 2);
});

test("HTTP-date Retry-After remains actionable when its wait exceeds the deadline", async () => {
  let calls = 0;
  const client = createDocSlurpClient({ apiUrl: "https://example.test", timeoutMs: 10000, fetch: async () => {
    calls++;
    return json({}, 429, { "retry-after": new Date(Date.now() + 60000).toUTCString() });
  } });
  await assert.rejects(client.getRun("run"), error => {
    assert.ok(error instanceof DocSlurpApiError);
    assert.ok(error.retryAfterSeconds > 58 && error.retryAfterSeconds <= 60);
    return true;
  });
  assert.equal(calls, 1);
});

test("nonretryable AI refusals still expose the wait without replaying the call", async () => {
  let calls = 0;
  const client = createDocSlurpClient({ apiUrl: "https://example.test", fetch: async () => {
    calls++;
    return json({ error: { code: "rate_limited" } }, 429, { "retry-after": "60" });
  } });
  await assert.rejects(client.chat({ message: "question" }), error => {
    assert.ok(error instanceof DocSlurpApiError);
    assert.equal(error.retryAfterSeconds, 60);
    return true;
  });
  assert.equal(calls, 1);
});
