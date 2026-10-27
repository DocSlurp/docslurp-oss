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
