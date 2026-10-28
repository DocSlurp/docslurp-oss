import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import {
  createDocSlurpClient,
  DocSlurpApiError,
  DocSlurpRunError,
  DocSlurpTimeoutError,
} from "../dist/index.js";

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", ...headers },
});
const client = (fetch, options = {}) => createDocSlurpClient({ apiUrl: "https://example.test/", apiKey: "key", fetch, ...options });

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

test("zero-argument client reads server URL and key, captured at construction", async () => {
  await withEnvironment({ DOCSLURP_URL: " https://local.test/ ", DOCSLURP_API_KEY: "env-key" }, async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, init) => {
        assert.equal(url, "https://local.test/v1/runs/run/progress");
        assert.equal(init.headers.get("authorization"), "Bearer env-key");
        assert.equal(init.credentials, "omit");
        return json({ run: { id: "run", status: "completed" } });
      };
      const sdk = createDocSlurpClient();
      process.env.DOCSLURP_API_KEY = "changed";
      process.env.DOCSLURP_URL = "https://changed.test";
      assert.equal((await sdk.getRun("run")).id, "run");
    } finally { globalThis.fetch = originalFetch; }
  });
});

test("missing or blank URL environment defaults to the hosted service", async () => {
  for (const apiUrl of [undefined, "   "]) {
    await withEnvironment({ DOCSLURP_URL: apiUrl, DOCSLURP_API_KEY: undefined }, async () => {
      const sdk = createDocSlurpClient({
        apiKey: "key",
        fetch: async (url, init) => {
          assert.equal(url, "https://docslurp.io/v1/runs/run/progress");
          assert.equal(init.headers.get("authorization"), "Bearer key");
          return json({ run: { id: "run", status: "completed" } });
        },
      });
      assert.equal((await sdk.getRun("run")).id, "run");
    });
  }
});

test("explicit URL and key override environment, including cookie-session opt-out", async () => {
  await withEnvironment({ DOCSLURP_URL: "https://env.test", DOCSLURP_API_KEY: "env-key" }, async () => {
    for (const apiKey of ["explicit", ""]) {
      const sdk = createDocSlurpClient({ apiUrl: "", apiKey, fetch: async (url, init) => {
        assert.equal(url, "/v1/runs/run/progress");
        assert.equal(init.headers.get("authorization"), apiKey ? "Bearer explicit" : null);
        assert.equal(init.credentials, apiKey ? "omit" : "include");
        return json({ run: { id: "run", status: "completed" } });
      } });
      await sdk.getRun("run");
    }
  });
});

test("browser use needs no process global and ignores browser process shims", async () => {
  const compiled = (await readFile(new URL("../dist/sse.js", import.meta.url), "utf8")
    + await readFile(new URL("../dist/keys.js", import.meta.url), "utf8")
    + await readFile(new URL("../dist/index.js", import.meta.url), "utf8"))
    .replace(/^import .*$/gm, "").replace(/^export \{[^}]*\} from .*$/gm, "").replace(/^export /gm, "");
  for (const globals of [
    {},
    { window: {}, process: { env: { DOCSLURP_URL: "https://private.test", DOCSLURP_API_KEY: "private-key", DOCSLURP_WORKSPACE: "private-workspace" } } },
  ]) {
    const factory = runInNewContext(`${compiled}\ncreateDocSlurpClient`, {
      ...globals, URL, Headers, FormData, AbortController, setTimeout, clearTimeout,
      fetch: async (url, init) => {
        assert.equal(url, init.method === "POST" ? "https://docslurp.io/v1/uploads/bulk" : "https://docslurp.io/v1/runs/run/progress");
        // Browser shims never leak DOCSLURP_WORKSPACE; the default workspace is used.
        if (init.method === "POST") assert.equal(init.body.get("workspace"), "default");
        assert.equal(init.headers.has("authorization"), false);
        assert.equal(init.credentials, "include");
        return json({ run: { id: "run", status: "completed" } });
      },
    });
    const sdk = factory();
    await sdk.getRun("run");
    await sdk.upload({ files: [new File(["text"], "note.txt")] }, { directUpload: false });
  }
});

test("ingestion workspace precedence is per-call, client, environment, then the default workspace", async () => {
  for (const environmentWorkspace of [undefined, "env-workspace"]) {
    await withEnvironment({ DOCSLURP_WORKSPACE: environmentWorkspace }, async () => {
      for (const configuredWorkspace of [undefined, "client-workspace", ""]) {
        for (const perCallWorkspace of [undefined, "call-workspace", ""]) {
          const expected = perCallWorkspace || configuredWorkspace || environmentWorkspace || "default";
          const sdk = client(async (url, init) => {
            if (url.endsWith("/bulk")) assert.equal(init.body.get("workspace"), expected ?? null);
            else assert.equal(JSON.parse(init.body).workspace, expected);
            return json({ workspace: { id: "returned-workspace" }, run: { id: "run", status: "queued" } });
          }, { workspace: configuredWorkspace });
          // Repeat calls to prove returned workspaces do not become implicit defaults.
          for (let attempt = 0; attempt < 2; attempt++) {
            await sdk.upload({ files: [new File(["text"], "note.txt")], workspace: perCallWorkspace }, { directUpload: false });
            await sdk.ingestUrls({ urls: ["https://example.test/note.txt"], workspace: perCallWorkspace });
          }
        }
      }
    });
  }
});

test("a named workspace is sent as workspace; templateKey or newWorkspace without one asks for a new workspace", async () => {
  const cases = [
    // The server finds a workspace by ID, slug or name, or creates one from the name.
    [{ workspace: "Legal contracts" }, { newWorkspace: false, workspace: "Legal contracts" }],
    [{ templateKey: "legal-contracts" }, { newWorkspace: true, workspace: undefined }],
    [{ newWorkspace: true }, { newWorkspace: true, workspace: undefined }],
    // An explicit workspace wins over newWorkspace and templateKey.
    [{ newWorkspace: true, workspace: "ws-1" }, { newWorkspace: false, workspace: "ws-1" }],
    [{ templateKey: "legal-contracts", workspace: "Legal contracts" }, { newWorkspace: false, workspace: "Legal contracts" }],
    [{ workspace: "   " }, { newWorkspace: false, workspace: "client-workspace" }],
    [{}, { newWorkspace: false, workspace: "client-workspace" }],
  ];
  for (const [options, expected] of cases) {
    const seen = [];
    const sdk = client(async (url, init) => {
      if (url.endsWith("/bulk")) {
        assert.equal(init.body.has("workspaceName"), false);
        seen.push({ newWorkspace: init.body.get("newWorkspace") === "true", workspace: init.body.get("workspace") ?? undefined });
      } else {
        const body = JSON.parse(init.body);
        assert.equal("workspaceName" in body, false);
        seen.push({ newWorkspace: Boolean(body.newWorkspace), workspace: body.workspace });
      }
      return json({ workspace: { id: "returned-workspace" }, run: { id: "run", status: "queued" } });
    }, { workspace: "client-workspace" });
    await sdk.upload({ files: [new File(["text"], "note.txt")], ...options }, { directUpload: false });
    await sdk.upload(new Blob(["text"]), { ...options, directUpload: false });
    await sdk.ingestUrls({ urls: ["https://example.test/note.txt"], ...options });
    assert.deepEqual(seen, [expected, expected, expected], JSON.stringify(options));
  }
});

test("upload sends named file, bearer key and workspace without pipeline options", async () => {
  const sdk = client(async (url, init) => {
    assert.equal(url, "https://example.test/v1/uploads/bulk");
    assert.equal(init.headers.get("authorization"), "Bearer key");
    assert.equal(init.credentials, "omit");
    assert.equal(init.body.get("files").name, "policy.pdf");
    assert.equal(await init.body.get("files").text(), "PDF bytes");
    assert.equal(init.body.get("workspace"), "workspace");
    assert.equal(init.body.has("pipeline"), false);
    return json({ run: { id: "run", status: "queued" }, workspace: { id: "workspace" } });
  });
  const result = await sdk.upload({ files: [{ filename: "policy.pdf", data: new Blob(["PDF bytes"]) }], workspace: "workspace" }, { directUpload: false });
  assert.equal(result.run.id, "run");
});

test("upload accepts a file array, a single file input and streamed data", async () => {
  const uploads = [];
  const sdk = client(async (_url, init) => {
    uploads.push(await Promise.all(init.body.getAll("files").map(async (f) => [f.name, await f.text()])));
    return json({ run: { id: "run" } });
  });
  await sdk.upload([new Blob(["a"]), { filename: "b.txt", data: new Blob(["b"]) }], { directUpload: false });
  await sdk.upload({ filename: "c.txt", data: new Blob(["c"]) }, { directUpload: false });
  await sdk.upload({ filename: "d.txt", data: new Blob(["streamed"]).stream() }, { directUpload: false });
  assert.deepEqual(uploads, [
    [["document-1", "a"], ["b.txt", "b"]],
    [["c.txt", "c"]],
    [["d.txt", "streamed"]],
  ]);
});

test("wait polls progress and returns the completed run", async () => {
  let calls = 0;
  const sdk = client(async (url) => {
    assert.equal(url, "https://example.test/v1/runs/run%2Fid/progress");
    return json({ run: { id: "run/id", status: ++calls === 1 ? "queued" : "completed" } });
  });
  assert.equal((await sdk.waitForRun("run/id", { pollIntervalMs: 1 })).status, "completed");
  assert.equal(calls, 2);
});

test("wait rejects failed and controlled runs with the last run", async () => {
  for (const run of [
    { id: "run", status: "failed", error: "Bad document" },
    { id: "run", status: "queued", controlState: "paused" },
    { id: "run", status: "failed", controlState: "cancelled" },
  ]) {
    await assert.rejects(client(async () => json({ run })).waitForRun("run"), (error) => {
      assert.ok(error instanceof DocSlurpRunError);
      assert.deepEqual(error.run, run);
      return true;
    });
  }
});

test("deferred queued processing has a bounded wait and retains state", async () => {
  const sdk = client(async () => json({ run: { id: "run", status: "queued" }, temporal: null }));
  await assert.rejects(sdk.waitForRun("run", { timeoutMs: 15, pollIntervalMs: 100 }), (error) => {
    assert.ok(error instanceof DocSlurpTimeoutError);
    assert.equal(error.run.status, "queued");
    return true;
  });
});

test("timeout aborts an in-flight request", async () => {
  const sdk = client((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  await assert.rejects(sdk.getRun("run", { timeoutMs: 10 }), DocSlurpTimeoutError);
});

test("wait cancellation interrupts polling and preserves caller reason", async () => {
  const controller = new AbortController();
  const reason = new Error("Stop waiting");
  const sdk = client(async () => {
    setTimeout(() => controller.abort(reason), 5);
    return json({ run: { id: "run", status: "queued" } });
  });
  await assert.rejects(sdk.waitForRun("run", { signal: controller.signal }), (error) => error === reason);
});

test("GET retries bounded transient responses", async () => {
  let calls = 0;
  const sdk = client(async () => ++calls < 3 ? json({ error: "Busy" }, 503, { "retry-after": "0" }) : json({ run: { id: "run", status: "completed" } }));
  assert.equal((await sdk.getRun("run")).status, "completed");
  assert.equal(calls, 3);
});

test("permanent errors and exhausted retries preserve status and body", async () => {
  for (const status of [403, 503]) {
    let calls = 0;
    const sdk = client(async () => { calls++; return json({ error: "Unavailable" }, status, { "retry-after": "0" }); });
    await assert.rejects(sdk.getRun("run"), (error) => {
      assert.ok(error instanceof DocSlurpApiError);
      assert.equal(error.status, status);
      assert.deepEqual(error.body, { error: "Unavailable" });
      return true;
    });
    assert.equal(calls, status === 403 ? 1 : 3);
  }
});

test("DocSlurpApiError exposes the native envelope code and request id", async () => {
  const envelope = { error: { code: "chat_disabled", message: "Chat is turned off.", requestId: "req-1" } };
  const sdk = client(async () => json(envelope, 403));
  await assert.rejects(sdk.chat({ workspace: "workspace", q: "question" }), (error) => {
    assert.ok(error instanceof DocSlurpApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, "chat_disabled");
    assert.equal(error.requestId, "req-1");
    assert.deepEqual(error.body, envelope);
    return true;
  });
});

test("DocSlurpApiError exposes buy-credits, auto top-up and billing links from 402 details", async () => {
  const links = { billing: "https://docslurp.io/app/billing", buyCredits: "https://docslurp.io/app/billing#bl-topup", autoTopUp: "https://docslurp.io/app/billing#bl-auto-topup", upgrade: "https://docslurp.io/pricing", docs: "javascript:alert(1)" };
  const envelope = { error: { code: "credit_exhausted", message: "Out of credits.", details: { links }, requestId: "req-2" } };
  const sdk = client(async () => json(envelope, 402));
  await assert.rejects(sdk.chat({ workspace: "workspace", q: "question" }), (error) => {
    assert.ok(error instanceof DocSlurpApiError);
    assert.equal(error.code, "credit_exhausted");
    assert.deepEqual(error.links, { billing: links.billing, buyCredits: links.buyCredits, autoTopUp: links.autoTopUp });
    return true;
  });
});

test("DocSlurpApiError leaves code undefined for legacy and non-JSON bodies", async () => {
  for (const response of [() => json({ error: "Forbidden" }, 403), () => json({ error: { issues: [] } }, 403), () => new Response("<h1>bad gateway</h1>", { status: 403 })]) {
    const sdk = client(async () => response());
    await assert.rejects(sdk.getRun("run"), (error) => {
      assert.ok(error instanceof DocSlurpApiError);
      assert.equal(error.code, undefined);
      assert.equal(error.requestId, undefined);
      return true;
    });
  }
});

test("AI calls and unkeyed uploads never retry; keyed upload can retry", async () => {
  for (const method of ["chat", "search", "upload", "ingestUrls"]) {
    let calls = 0;
    const sdk = client(async () => { calls++; return json({ error: "Busy" }, 503, { "retry-after": "0" }); });
    const input = method === "upload" ? { files: [new Blob(["data"])] } : { workspace: "workspace", q: "question", urls: ["https://example.test/doc"] };
    await assert.rejects(sdk[method](input), DocSlurpApiError);
    assert.equal(calls, 1, method);
  }
  let calls = 0;
  const sdk = client(async (_url, init) => {
    assert.equal(init.headers.get("idempotency-key"), "once");
    return ++calls === 1 ? json({}, 503, { "retry-after": "0" }) : json({ run: { id: "run" } });
  });
  await sdk.upload({ files: [new Blob(["data"])], idempotencyKey: "once" }, { directUpload: false });
  assert.equal(calls, 2);
});

test("cookie sessions and JSON chat transport remain usable", async () => {
  const sdk = createDocSlurpClient({ apiUrl: "https://example.test", apiKey: "", fetch: async (_url, init) => {
    assert.equal(init.credentials, "include");
    assert.equal(init.headers.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(init.body), { workspace: "workspace", q: "question" });
    return json({ answer: "answer", citations: [] });
  } });
  assert.equal((await sdk.chat({ workspace: "workspace", q: "question" })).answer, "answer");
});

test("invalid durations fail immediately", async () => {
  assert.throws(() => client(async () => json({}), { timeoutMs: 0 }), RangeError);
  await assert.rejects(client(async () => json({})).waitForRun("run", { timeoutMs: Infinity }), RangeError);
});

// The homepage lives in the private frontend; the open-source export has no such file, so skip there.
const homepageSource = new URL("../../../app/src/pages/index.astro", import.meta.url);
test("the actual homepage example uploads, waits and searches over HTTP", { skip: !existsSync(homepageSource) && "homepage source is not part of this checkout" }, async () => {
  const homepage = await readFile(homepageSource, "utf8");
  const snippet = homepage.match(/const integrationCode = `([\s\S]*?)`;/)?.[1];
  assert.ok(snippet, "Homepage must expose its integration example");
  const source = snippet.replace(/^import .*;\n/gm, "");
  const requests = [];
  const citation = { documentId: "document", filename: "handbook.pdf", pageNumbers: [3] };
  let polls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() });
    let body;
    if (request.url === "/v1/uploads/bulk" && request.method === "POST") {
      body = { workspace: { id: "workspace", name: "Handbook" }, run: { id: "run", status: "queued" }, documents: [] };
    } else if (request.url === "/v1/runs/run/progress") {
      body = { run: { id: "run", status: ++polls === 1 ? "processing" : "completed" } };
    } else if (request.url === "/v1/search" && request.method === "POST") {
      body = { results: [{ text: "Parental leave policy", citation }], availability: { status: "complete" }, sessionId: "session" };
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await withEnvironment({ DOCSLURP_URL: undefined, DOCSLURP_API_KEY: "test-key", DOCSLURP_WORKSPACE: undefined }, async () => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await new AsyncFunction("createDocSlurpClient", "createReadStream", "console", source)(
        (options) => createDocSlurpClient({
          ...options,
          fetch: (url, init) => {
            const target = new URL(url);
            assert.equal(target.origin, "https://docslurp.io");
            return fetch(`http://127.0.0.1:${server.address().port}${target.pathname}${target.search}`, init);
          },
        }),
        (filename) => { assert.equal(filename, "handbook.pdf"); return Object.assign(Readable.from([Buffer.from("Source document bytes")]), { path: filename }); },
        { log: () => {} },
      );
      assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
        "POST /v1/uploads/bulk", "GET /v1/runs/run/progress", "GET /v1/runs/run/progress", "POST /v1/search",
      ]);
      assert.ok(requests.every((request) => request.authorization === "Bearer test-key"));
      assert.match(requests[0].body, /filename="handbook.pdf"/);
      assert.match(requests[0].body, /Source document bytes/);
      assert.match(requests[0].body, /name="workspace"\r\n\r\ndefault\r\n/);
      // Upload and search both target the default workspace with no configuration.
      assert.equal(JSON.parse(requests.at(-1).body).workspace, "default");
    });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("public API error messages hide provider billing and proxy details while retaining the body", async () => {
  const raw = { error: "OpenRouter insufficient credits; postgres://private-host/db" };
  const sdk = client(async () => json(raw, 402));
  await assert.rejects(sdk.getRun("run"), error => {
    assert.equal(error.status, 402);
    assert.deepEqual(error.body, raw);
    assert.match(error.message, /temporarily unavailable/);
    assert.doesNotMatch(error.message, /OpenRouter|credits|postgres/);
    return true;
  });
  const malformed = client(async () => new Response("<html>private gateway</html>", { status: 400, headers: { "content-type": "application/json" } }));
  await assert.rejects(malformed.getRun("run"), error => {
    assert.ok(error instanceof DocSlurpApiError);
    assert.equal(error.body, "<html>private gateway</html>");
    assert.doesNotMatch(error.message, /gateway|html/);
    return true;
  });
});

test("server runtimes label requests with the X-DocSlurp-Client analytics tag", async () => {
  let seen;
  const sdk = client(async (_url, init) => {
    seen = new Headers(init.headers);
    return new Response(JSON.stringify({ workspaces: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  await sdk.listWorkspaces().catch(() => {});
  assert.equal(seen.get("x-docslurp-client"), "sdk");
  assert.equal(seen.get("authorization"), "Bearer key");
});
