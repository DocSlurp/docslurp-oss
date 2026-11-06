import assert from "node:assert/strict";
import { test } from "node:test";

import { createDocSlurpClient, DocSlurpApiError } from "../dist/index.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const uploadResult = { workspace: { id: "workspace" }, run: { id: "run" }, documents: [] };

/** What the server does to a filename (server/src/lib/filenames.ts), so descriptors carry the sanitized name. */
const sanitize = (name) => name.replace(/[<>:"|?*]/g, "-").replace(/\s+/g, " ").trim().replace(/^-+/, "");

/** A fake server with idempotent session create, per-file rejection and index/clientId echo. */
function server({ dropFirstCreateResponse = false, reject = () => false } = {}) {
  const calls = [];
  const sessions = new Map();
  const puts = [];
  let created = 0;
  let dropped = false;
  const fetch = async (url, init = {}) => {
    const href = String(url);
    const headers = new Headers(init.headers);
    calls.push({ url: href, method: init.method ?? "GET", key: headers.get("idempotency-key") });
    if (href.endsWith("/v1/uploads/direct/sessions") && init.method === "POST") {
      const key = headers.get("idempotency-key");
      assert.ok(key, "session create must carry an Idempotency-Key");
      let session = sessions.get(key);
      if (!session) {
        const request = JSON.parse(init.body);
        const rejected = [];
        const files = [];
        request.files.forEach((file, index) => {
          if (reject(file)) rejected.push({ index, clientId: file.clientId, filename: sanitize(file.filename), statusCode: 415, code: "unsupported_type", message: `Unsupported file type for ${file.filename}` });
          else files.push({ index, clientId: file.clientId, id: `f${index}`, filename: sanitize(file.filename), mimeType: file.mimeType, sizeBytes: file.sizeBytes, mode: "single", putUrl: `https://storage.invalid/put/${index}` });
        });
        session = { sessionId: "s1", files, ...(rejected.length ? { rejected } : {}) };
        sessions.set(key, session);
        created++;
      }
      if (dropFirstCreateResponse && !dropped) { dropped = true; throw new TypeError("fetch failed"); }
      return json(session, 201);
    }
    if (href.startsWith("https://storage.invalid/")) { puts.push({ url: href, body: init.body }); return new Response(null, { status: 200 }); }
    if (href.endsWith("/s1?statusOnly=true")) return json({ status: "completed", result: uploadResult });
    if (href.endsWith("/abort")) return json({ ok: true });
    return json({ error: "unexpected" }, 500);
  };
  return { fetch, calls, puts, created: () => created };
}

test("files whose names the server sanitizes still upload their own bytes (matched by index, not name)", async () => {
  const api = server();
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });
  const files = [
    { data: new Blob(["rag"], { type: "application/pdf" }), filename: "What is RAG?.pdf" },
    { data: new Blob(["scan"], { type: "application/pdf" }), filename: "Scan  001.pdf" },
    { data: new Blob(["draft"], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), filename: "-draft.docx" },
  ];
  const result = await client.upload({ files });
  assert.equal(result.run.id, "run");
  assert.deepEqual(await Promise.all(api.puts.map((put) => put.body.text())), ["rag", "scan", "draft"]);
});

test("two files that sanitize to the same name still go to their own storage URLs", async () => {
  const api = server();
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });
  await client.upload({ files: [{ data: new Blob(["first"]), filename: "a?.txt" }, { data: new Blob(["second!"]), filename: "a*.txt" }] });
  assert.deepEqual(api.puts.map((put) => put.url), ["https://storage.invalid/put/0", "https://storage.invalid/put/1"]);
  assert.deepEqual(await Promise.all(api.puts.map((put) => put.body.text())), ["first", "second!"]);
});

test("a session create whose response is lost is retried with the same key and makes one session", async () => {
  const api = server({ dropFirstCreateResponse: true });
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });
  const result = await client.upload(new Blob(["hello"], { type: "text/plain" }), { filename: "a.txt" });
  assert.equal(result.run.id, "run");
  const creates = api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/direct/sessions"));
  assert.equal(creates.length, 2);
  assert.equal(creates[0].key, creates[1].key);
  assert.equal(api.created(), 1);
});

test("a caller-supplied idempotencyKey is the one sent", async () => {
  const api = server();
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });
  await client.upload({ files: [new Blob(["x"])], idempotencyKey: "my-key-1" });
  assert.equal(api.calls.find((call) => call.method === "POST").key, "my-key-1");
});

test("one unsupported file in a batch of three: the other two upload and the rejection names the caller's file", async () => {
  const api = server({ reject: (file) => file.filename.endsWith(".exe") });
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });
  const result = await client.upload({ files: [
    { data: new Blob(["one"]), filename: "one.pdf" },
    { data: new Blob(["MZ"]), filename: "tool?.exe" },
    { data: new Blob(["three"]), filename: "three.pdf" },
  ] });
  assert.deepEqual(await Promise.all(api.puts.map((put) => put.body.text())), ["one", "three"]);
  assert.deepEqual(result.rejected?.map((file) => [file.index, file.filename, file.statusCode, file.code]), [[1, "tool?.exe", 415, "unsupported_type"]]);
});

test("a failed part resumes from the server's pendingParts instead of re-sending finished parts", async () => {
  const calls = [];
  let part2Failures = 0;
  const fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push(`${init.method ?? "GET"} ${href}`);
    if (href.endsWith("/direct/sessions") && init.method === "POST") {
      return json({ sessionId: "s1", files: [{ index: 0, clientId: "0", id: "f0", filename: "ten.txt", mimeType: "text/plain", sizeBytes: 10, mode: "multipart", partSize: 4, pendingParts: [
        { partNumber: 1, sizeBytes: 4, url: "https://storage.invalid/a/1" }, { partNumber: 2, sizeBytes: 4, url: "https://storage.invalid/a/2" }, { partNumber: 3, sizeBytes: 2, url: "https://storage.invalid/a/3" }] }] }, 201);
    }
    if (href.endsWith("/v1/uploads/direct/sessions/s1")) {
      // Storage holds part 1; parts 2 and 3 come back with fresh URLs.
      return json({ sessionId: "s1", status: "pending", files: [{ index: 0, clientId: "0", id: "f0", filename: "ten.txt", mimeType: "text/plain", sizeBytes: 10, mode: "multipart", partSize: 4, status: "pending", pendingParts: [
        { partNumber: 2, sizeBytes: 4, url: "https://storage.invalid/b/2" }, { partNumber: 3, sizeBytes: 2, url: "https://storage.invalid/b/3" }] }] });
    }
    if (href === "https://storage.invalid/a/2") { part2Failures++; return new Response("busy", { status: 503 }); }
    if (href.startsWith("https://storage.invalid/")) return new Response(null, { status: 200 });
    if (href.endsWith("?statusOnly=true")) return json({ status: "completed", result: uploadResult });
    return json({ error: "unexpected" }, 500);
  };
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch });
  await client.upload(new Blob(["0123456789"]), { directUpload: true, filename: "ten.txt" });
  assert.ok(part2Failures >= 3, "part 2 exhausted its own retries first");
  assert.equal(calls.filter((call) => call.endsWith("storage.invalid/a/1")).length, 1);
  assert.ok(calls.includes("PUT https://storage.invalid/b/2"));
  assert.ok(calls.includes("PUT https://storage.invalid/b/3"));
  assert.ok(!calls.includes("PUT https://storage.invalid/a/3"));
});


test("a coded in-flight 409 is retried with the same key until the first request's session comes back", async () => {
  const api = server();
  let inFlight = 2;
  const fetch = async (url, init = {}) => {
    if (String(url).endsWith("/v1/uploads/direct/sessions") && init.method === "POST" && inFlight-- > 0) {
      return json({ error: { code: "idempotency_in_flight", message: "A request with this Idempotency-Key is still being processed." } }, 409);
    }
    return api.fetch(url, init);
  };
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch });
  const result = await client.upload(new Blob(["hello"], { type: "text/plain" }), { filename: "a.txt", idempotencyKey: "raced-key" });
  assert.equal(result.run.id, "run");
  const creates = api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/direct/sessions"));
  assert.deepEqual(creates.map((call) => call.key), ["raced-key"]);
  assert.equal(api.created(), 1);
});

test("an in-flight 409 that outlasts the request timeout is reported, and other 409s are never retried", async () => {
  let calls = 0;
  const stuck = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", timeoutMs: 700, fetch: async () => {
    calls++;
    return json({ error: { code: "idempotency_in_flight", message: "busy" } }, 409);
  } });
  await assert.rejects(stuck.upload(new Blob(["x"]), { filename: "a.txt" }), (error) => error instanceof DocSlurpApiError && error.status === 409 && error.code === "idempotency_in_flight");
  assert.ok(calls >= 2 && calls <= 5, `retried a bounded number of times, got ${calls}`);

  for (const code of ["idempotency_key_reused", "upload_session_closed", "conflict"]) {
    let attempts = 0;
    const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: async () => { attempts++; return json({ error: { code, message: "no" } }, 409); } });
    await assert.rejects(client.upload(new Blob(["x"]), { filename: "a.txt" }), (error) => error instanceof DocSlurpApiError && error.code === code);
    assert.equal(attempts, 1, `${code} must not be retried`);
  }
});
