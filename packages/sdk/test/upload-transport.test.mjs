import assert from "node:assert/strict";
import { test } from "node:test";

import { createDocSlurpClient, DocSlurpApiError } from "../dist/index.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const uploadResult = { project: { id: "project" }, run: { id: "run" }, documents: [] };

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
    if (href.endsWith("/v1/uploads/direct/sessions/s1?fileId=f0")) {
      // The resume reads only the file it wants. Storage holds part 1; parts 2 and 3 come back with fresh URLs.
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

test("session calls wait out a busy session or a rate limit, honouring Retry-After", async () => {
  const { createDocSlurpClient } = await import("../dist/index.js");
  const answers = { sign: [409, 429], complete: [409], batch: [409], read: [409] };
  const seen = [];
  const busy = (status) => new Response(JSON.stringify({ error: status === 409
    ? { code: "upload_session_busy", message: "Upload session is being finalized; retry shortly" }
    : { code: "rate_limited", message: "Too many requests" } }), { status, headers: { "content-type": "application/json", "retry-after": "0" } });
  const fetch = async (url, init = {}) => {
    const href = String(url);
    const kind = href.includes("/parts/sign") ? "sign" : href.endsWith("/files/complete") ? (String(init.body).includes('"files"') ? "batch" : "complete") : "read";
    seen.push(kind);
    const next = answers[kind].shift();
    if (next) return busy(next);
    if (kind === "sign") return new Response(JSON.stringify({ parts: [{ partNumber: 1, url: "https://storage.invalid/p1" }] }), { headers: { "content-type": "application/json" } });
    if (kind === "batch") return new Response(JSON.stringify({ ok: true, completedCount: 1, failedCount: 0, sessionComplete: true, files: [{ fileId: "f1", status: "completed" }] }), { headers: { "content-type": "application/json" } });
    if (kind === "complete") return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ sessionId: "s1", status: "pending", files: [] }), { headers: { "content-type": "application/json" } });
  };
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch });
  assert.deepEqual((await client.signUploadParts("s1", "f1", [1])).parts.map(part => part.partNumber), [1]);
  assert.deepEqual(await client.completeUploadFile("s1", { fileId: "f1" }), { ok: true });
  assert.equal((await client.completeUploadFiles("s1", [{ fileId: "f1" }])).completedCount, 1);
  assert.equal((await client.getUploadSession("s1")).sessionId, "s1");
  assert.deepEqual(seen, ["sign", "sign", "sign", "complete", "complete", "batch", "batch", "read", "read"]);
});

test("a stream upload whose complete stays busy for its own ~2 min deadline closes its session (the server cannot finish a stream) and names it", async () => {
  const { createDocSlurpClient } = await import("../dist/index.js");
  const { mock } = await import("node:test");
  const calls = [];
  const completeTimes = [];
  const fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push(`${init.method ?? "GET"} ${href}`);
    if (href.endsWith("/files/complete")) completeTimes.push(Date.now());
    if (href.endsWith("/direct/sessions") && init.method === "POST") {
      return new Response(JSON.stringify({ sessionId: "s1", files: [{ id: "f1", filename: "stream.bin", mimeType: "application/octet-stream", mode: "multipart", partSize: 4 }] }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/parts/sign")) return new Response(JSON.stringify({ parts: [{ partNumber: 1, url: "https://storage.invalid/p1" }] }), { headers: { "content-type": "application/json" } });
    if (href.startsWith("https://storage.invalid/")) return new Response(null, { status: 200, headers: { etag: '"e1"' } });
    if (href.endsWith("/abort")) return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    // Every complete finds the session busy.
    if (href.endsWith("/files/complete")) return new Response(JSON.stringify({ error: { code: "upload_session_busy", message: "busy" } }), { status: 409, headers: { "content-type": "application/json", "retry-after": "0" } });
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500, headers: { "content-type": "application/json" } });
  };
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch });
    async function* chunks() { yield new TextEncoder().encode("abc"); }
    let settled = null;
    const uploading = client.upload(chunks(), { filename: "stream.bin", timeoutMs: 600_000 }).then(() => { settled = { ok: true }; }, (error) => { settled = { error }; });
    // Drive the backoff waits on fake time.
    for (let i = 0; i < 1000 && !settled; i++) { await new Promise((resolve) => setImmediate(resolve)); mock.timers.tick(500); }
    await uploading;
    assert.equal(settled.error?.status, 409);
    assert.equal(settled.error.sessionId, "s1");
    // The final complete is waited out for about two minutes (not the usual few retries) before the session is closed.
    const span = completeTimes.at(-1) - completeTimes[0];
    assert.ok(span >= 100_000 && span <= 120_000, `final complete retried for ${span} ms`);
    assert.ok(calls.filter(call => call.endsWith("/files/complete")).length > 1, "the busy complete was retried");
    assert.equal(calls.filter(call => call.endsWith("/abort")).length, 1, "the unfinishable stream session is closed");
  } finally { mock.timers.reset(); }
});

test("parts the session describes without a URL are signed through parts/sign before they are sent", async () => {
  const { createDocSlurpClient } = await import("../dist/index.js");
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ method: init.method ?? "GET", href, body: init.body ? String(init.body) : "" });
    if (href.endsWith("/direct/sessions") && init.method === "POST") {
      // The server's part-URL budget ran out: part 1 carries its URL, parts 2 and 3 do not.
      return json({ sessionId: "s1", files: [{ index: 0, clientId: "0", id: "f0", filename: "ten.txt", mimeType: "text/plain", sizeBytes: 10, mode: "multipart", partSize: 4, partUrlsOmitted: true, pendingParts: [
        { partNumber: 1, sizeBytes: 4, url: "https://storage.invalid/a/1" }, { partNumber: 2, sizeBytes: 4 }, { partNumber: 3, sizeBytes: 2 }] }] }, 201);
    }
    if (href.endsWith("/files/f0/parts/sign")) {
      const { partNumbers } = JSON.parse(String(init.body));
      return json({ parts: partNumbers.map((partNumber) => ({ partNumber, url: `https://storage.invalid/signed/${partNumber}` })) });
    }
    if (href.startsWith("https://storage.invalid/")) return new Response(null, { status: 200 });
    if (href.endsWith("?statusOnly=true")) return json({ status: "completed", result: { run: { id: "r1" }, project: { id: "p1" }, documents: [] } });
    return json({ error: "unexpected" }, 500);
  };
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch });
  await client.upload(new Blob(["0123456789"]), { directUpload: true, filename: "ten.txt" });
  const sign = calls.filter((call) => call.href.endsWith("/parts/sign"));
  assert.equal(sign.length, 1);
  assert.deepEqual(JSON.parse(sign[0].body).partNumbers, [2, 3]);
  const puts = calls.filter((call) => call.method === "PUT").map((call) => call.href);
  assert.deepEqual(puts, ["https://storage.invalid/a/1", "https://storage.invalid/signed/2", "https://storage.invalid/signed/3"]);
});

test("uninspected files are completed in one batch and only the coded-missing ones are read (once) and sent", async () => {
  const { createDocSlurpClient } = await import("../dist/index.js");
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ method: init.method ?? "GET", href, body: init.body ? String(init.body) : "" });
    if (href.endsWith("/direct/sessions") && init.method === "POST") {
      // A replayed create on a large session: none of these four files was inspected by the read.
      return json({ sessionId: "s1", files: [
        { index: 0, clientId: "0", id: "assembled", filename: "a.bin", mimeType: "application/octet-stream", sizeBytes: 10, mode: "multipart", partSize: 4, inspected: false, transferState: "unknown" },
        { index: 1, clientId: "1", id: "stored", filename: "b.txt", mimeType: "text/plain", sizeBytes: 3, mode: "single", inspected: false, putUrl: "https://storage.invalid/b" },
        { index: 2, clientId: "2", id: "missing", filename: "c.txt", mimeType: "text/plain", sizeBytes: 3, mode: "single", inspected: false, putUrl: "https://storage.invalid/c-stale" },
        { index: 3, clientId: "3", id: "parts", filename: "d.bin", mimeType: "application/octet-stream", sizeBytes: 6, mode: "multipart", partSize: 4, inspected: false, transferState: "unknown" },
      ] }, 200);
    }
    if (href.endsWith("/files/complete")) {
      const { files } = JSON.parse(String(init.body));
      return json({ sessionComplete: false, files: files.map(({ fileId }) => fileId === "missing"
        ? { fileId, status: "failed", error: { statusCode: 400, code: "upload_object_missing", message: "missing", retryable: false, action: "reupload", blocksSession: false } }
        : fileId === "parts"
          ? { fileId, status: "failed", error: { statusCode: 409, code: "upload_parts_incomplete", message: "parts", retryable: false, action: "reupload", blocksSession: false } }
          : { fileId, status: "completed" }) });
    }
    if (href.includes("?fileId=")) {
      return json({ sessionId: "s1", status: "pending", files: [
        { index: 2, clientId: "2", id: "missing", filename: "c.txt", mimeType: "text/plain", sizeBytes: 3, mode: "single", status: "pending", putUrl: "https://storage.invalid/c-fresh" },
        { index: 3, clientId: "3", id: "parts", filename: "d.bin", mimeType: "application/octet-stream", sizeBytes: 6, mode: "multipart", status: "pending", partSize: 4, pendingParts: [{ partNumber: 2, sizeBytes: 2, url: "https://storage.invalid/d-2" }] },
      ] });
    }
    if (href.startsWith("https://storage.invalid/")) return new Response(null, { status: 200, headers: { etag: '"e"' } });
    if (href.endsWith("?statusOnly=true")) return json({ status: "completed", result: { run: { id: "r1" }, project: { id: "p1" }, documents: [] } });
    return json({ error: "unexpected" }, 500);
  };
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch });
  await client.upload([new Blob(["0123456789"]), new Blob(["abc"]), new Blob(["xyz"]), new Blob(["abcdef"])], { directUpload: true, filenames: ["a.bin", "b.txt", "c.txt", "d.bin"] });
  // One batch complete for all four, one read naming the two coded-missing files, and only their bytes are sent.
  const completes = calls.filter((call) => call.href.endsWith("/files/complete"));
  assert.equal(completes.length, 1);
  assert.deepEqual(JSON.parse(completes[0].body).files.map((file) => file.fileId), ["assembled", "stored", "missing", "parts"]);
  const reads = calls.filter((call) => call.href.includes("?fileId="));
  assert.equal(reads.length, 1);
  assert.ok(reads[0].href.endsWith("?fileId=missing&fileId=parts"));
  assert.deepEqual(calls.filter((call) => call.method === "PUT").map((call) => call.href), ["https://storage.invalid/c-fresh", "https://storage.invalid/d-2"]);
});

test("an uninspected file's other failures are not taken for a missing object: a coded busy keeps the session, anything else closes it", async () => {
  const { createDocSlurpClient } = await import("../dist/index.js");
  const { mock } = await import("node:test");
  for (const [label, reply] of [
    ["busy", { status: 409, body: { error: { code: "upload_session_busy", message: "busy" } } }],
    ["uncoded 409", { status: 409, body: { error: { code: "conflict", message: "Upload parts are incomplete" } } }],
  ]) {
    const calls = [];
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "retry-after": "0" } });
    const fetch = async (url, init = {}) => {
      const href = String(url);
      calls.push(`${init.method ?? "GET"} ${href}`);
      if (href.endsWith("/direct/sessions") && init.method === "POST") {
        return json({ sessionId: "s1", files: [{ index: 0, clientId: "0", id: "f", filename: "c.txt", mimeType: "text/plain", sizeBytes: 3, mode: "single", inspected: false, putUrl: "https://storage.invalid/c" }] });
      }
      if (href.endsWith("/files/complete")) return json(reply.body, reply.status);
      if (href.endsWith("/abort")) return json({ ok: true });
      return json({ error: "unexpected" }, 500);
    };
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    try {
      const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch });
      let settled = null;
      const uploading = client.upload([new Blob(["xyz"])], { directUpload: true, filenames: ["c.txt"] }).then(() => { settled = { ok: true }; }, (error) => { settled = { error }; });
      for (let i = 0; i < 400 && !settled; i++) { await new Promise((resolve) => setImmediate(resolve)); mock.timers.tick(500); }
      await uploading;
      assert.ok(settled.error, label);
      assert.equal(settled.error.sessionId, "s1", label);
      assert.equal(calls.filter((call) => call.startsWith("PUT ")).length, 0, `${label}: no bytes are sent`);
      assert.equal(calls.filter((call) => call.endsWith("/abort")).length, label === "busy" ? 0 : 1, `${label}: abort`);
      assert.equal(calls.filter((call) => call.includes("?fileId=")).length, 0, `${label}: no refresh read`);
    } finally { mock.timers.reset(); }
  }
});

test("a busy retry is not sent once the deadline has passed during its wait: the last busy answer is returned", async () => {
  const { createDocSlurpClient } = await import("../dist/index.js");
  const { mock } = await import("node:test");
  const sent = [];
  const fetch = async () => {
    sent.push(Date.now());
    return new Response(JSON.stringify({ error: { code: "upload_session_busy", message: "busy" } }), { status: 409, headers: { "content-type": "application/json", "retry-after": "1" } });
  };
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch });
    let settled = null;
    const call = client.completeUploadFile("s1", { fileId: "f1" }, { timeoutMs: 5_000 }).then((value) => { settled = { value }; }, (error) => { settled = { error }; });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    // The wait overruns (a suspended process): the clock jumps past the deadline, then the timer fires.
    mock.timers.setTime(Date.now() + 10_000);
    for (let i = 0; i < 20 && !settled; i++) { mock.timers.tick(1_000); await new Promise((resolve) => setImmediate(resolve)); }
    await call;
    assert.equal(settled.error?.status, 409);
    assert.equal(settled.error.code, "upload_session_busy");
    assert.equal(sent.length, 1);
  } finally { mock.timers.reset(); }
});

test("a session call keeps one deadline across retries and honours a Retry-After above the backoff cap when it fits", async () => {
  const { createDocSlurpClient } = await import("../dist/index.js");
  const { mock } = await import("node:test");
  const sent = [];
  const fetch = async () => {
    sent.push(Date.now());
    if (sent.length === 1) return new Response(JSON.stringify({ error: { code: "upload_session_busy", message: "busy" } }), { status: 409, headers: { "content-type": "application/json", "retry-after": "8" } });
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  };
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch });
    let done = false;
    const call = client.completeUploadFile("s1", { fileId: "f1" }, { timeoutMs: 20_000 }).then((value) => { done = true; return value; });
    for (let i = 0; i < 100 && !done; i++) { await new Promise((resolve) => setImmediate(resolve)); mock.timers.tick(500); }
    assert.deepEqual(await call, { ok: true });
    assert.ok(sent[1] - sent[0] >= 8_000, `waited the server's 8 s (${sent[1] - sent[0]} ms)`);
    // A Retry-After that does not fit before the deadline ends the call with the busy answer.
    sent.length = 0;
    await assert.rejects(client.completeUploadFile("s1", { fileId: "f1" }, { timeoutMs: 5_000 }), (error) => error.status === 409 && error.retryAfterSeconds === 8);
    assert.equal(sent.length, 1);
  } finally { mock.timers.reset(); }
});
