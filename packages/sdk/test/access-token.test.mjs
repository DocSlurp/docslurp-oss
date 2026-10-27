import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient, DocSlurpApiError } from "../dist/index.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function withEnvironment(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve().then(run).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("a static access token is sent as the bearer and omits cookies", async () => {
  const seen = [];
  const client = createDocSlurpClient({ apiUrl: "https://example.test", accessToken: "dscli_static", fetch: async (_url, init) => {
    seen.push({ auth: init.headers.get("authorization"), credentials: init.credentials });
    return json({ run: { id: "run", status: "completed" } });
  } });
  await client.getRun("run");
  assert.deepEqual(seen, [{ auth: "Bearer dscli_static", credentials: "omit" }]);
});

test("a token provider is called per request and refreshed once after a 401", async () => {
  const calls = [];
  let token = "dscli_old";
  const provider = ({ forceRefresh }) => {
    calls.push(forceRefresh);
    if (forceRefresh) token = "dscli_new";
    return token;
  };
  const sent = [];
  const client = createDocSlurpClient({ apiUrl: "https://example.test", accessToken: provider, fetch: async (_url, init) => {
    const auth = init.headers.get("authorization");
    sent.push(auth);
    return auth === "Bearer dscli_old" ? json({ error: "expired" }, 401) : json({ run: { id: "run", status: "completed" } });
  } });
  await client.getRun("run");
  assert.deepEqual(sent, ["Bearer dscli_old", "Bearer dscli_new"]);
  assert.deepEqual(calls, [false, true]);
});

test("a second 401 after refresh surfaces the error without looping", async () => {
  let fetches = 0;
  const client = createDocSlurpClient({ apiUrl: "https://example.test", accessToken: () => "dscli_bad", fetch: async () => { fetches++; return json({ error: "nope" }, 401); } });
  await assert.rejects(client.getRun("run"), (error) => error instanceof DocSlurpApiError && error.status === 401 && !String(error.message).includes("dscli_bad"));
  assert.equal(fetches, 2);
});

test("precedence: apiKey option, then accessToken option, then DOCSLURP_API_KEY, then DOCSLURP_TOKEN", async () => {
  const header = async (options) => {
    let auth;
    const client = createDocSlurpClient({ apiUrl: "https://example.test", ...options, fetch: async (_url, init) => { auth = init.headers.get("authorization"); return json({ run: { id: "run" } }); } });
    await client.getRun("run");
    return auth;
  };
  await withEnvironment({ DOCSLURP_API_KEY: "env-key", DOCSLURP_TOKEN: "env-token" }, async () => {
    assert.equal(await header({ apiKey: "opt-key", accessToken: "opt-token" }), "Bearer opt-key");
    assert.equal(await header({ accessToken: "opt-token" }), "Bearer opt-token");
    assert.equal(await header({}), "Bearer env-key");
    assert.equal(await header({ apiKey: "" }), null);
  });
  await withEnvironment({ DOCSLURP_API_KEY: undefined, DOCSLURP_TOKEN: "env-token" }, async () => {
    assert.equal(await header({}), "Bearer env-token");
  });
});

test("concurrent 401s share one forced refresh", async () => {
  let forced = 0;
  let token = "dscli_old";
  const provider = async ({ forceRefresh }) => {
    if (forceRefresh) { forced++; await new Promise((resolve) => setTimeout(resolve, 20)); token = `dscli_new_${forced}`; }
    return token;
  };
  const client = createDocSlurpClient({ apiUrl: "https://example.test", accessToken: provider, fetch: async (_url, init) =>
    init.headers.get("authorization") === "Bearer dscli_old" ? json({}, 401) : json({ run: { id: "run" } }) });
  await Promise.all([client.getRun("a"), client.getRun("b"), client.getRun("c")]);
  assert.equal(forced, 1);
});

test("an SSE stream refused with 401 refreshes once and reconnects", async () => {
  const sent = [];
  const provider = ({ forceRefresh }) => (forceRefresh ? "dscli_new" : "dscli_old");
  const client = createDocSlurpClient({ apiUrl: "https://example.test", accessToken: provider, fetch: async (_url, init) => {
    const auth = init.headers.get("authorization");
    sent.push(auth);
    if (auth === "Bearer dscli_old") return json({}, 401);
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("event: activity-event\ndata: {\"type\":\"x\",\"runId\":\"r\"}\n\n")); controller.close(); } });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  } });
  const events = [];
  for await (const event of client.streamActivity({ timeoutMs: 1000 })) events.push(event);
  assert.deepEqual(sent, ["Bearer dscli_old", "Bearer dscli_new"]);
  assert.equal(events.length, 1);
});

test("a 401 refresh does not use up a 429/5xx retry", async () => {
  const statuses = [401, 503, 503];
  let calls = 0;
  const client = createDocSlurpClient({ apiUrl: "https://example.test", accessToken: ({ forceRefresh }) => (forceRefresh ? "dscli_new" : "dscli_old"), fetch: async () => {
    const status = statuses[calls++];
    return status ? json({}, status) : json({ run: { id: "run" } });
  } });
  await client.getRun("run");
  assert.equal(calls, 4, "one 401 refresh plus two 503 retries, then success");
});
