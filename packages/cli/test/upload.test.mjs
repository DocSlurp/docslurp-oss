import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs the built CLI against a local server. `respond` sees every request (with its raw body) and may delay or fail it. */
async function invoke(args, respond, { killAfterMs = 15_000 } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ url: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks) });
    const result = respond(requests.at(-1), requests.length, `http://127.0.0.1:${server.address().port}`);
    if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    response.writeHead(result.status ?? 200, { "content-type": "application/json", ...(result.headers ?? {}) });
    response.end(JSON.stringify(result.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, ["dist/index.js", ...args, "--api-url", `${url}/`], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", DOCSLURP_API_KEY: "test-key", DOCSLURP_URL: "https://ignored-env.test", DOCSLURP_PROJECT: "" },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const kill = setTimeout(() => child.kill(), killAfterMs);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(kill);
    return { code, stdout, stderr, requests };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const sanitize = (name) => name.replace(/[<>:"|?*]/g, "-").replace(/\s+/g, " ").trim().replace(/^-+/, "");
const intakeResult = { project: { id: "w", name: "Default", slug: "default" }, run: { id: "run" }, documents: [{ id: "d" }] };

test("direct uploads match session files by index: names the server sanitizes still carry their own bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const big = join(dir, "What is RAG?.pdf");
    const small = join(dir, "Scan  001.pdf");
    await writeFile(big, Buffer.alloc(21 * 1024 * 1024, 0x41));
    await writeFile(small, "scan-bytes");
    const result = await invoke(["upload", big, small], (request, count, base) => {
      if (request.url === "/v1/uploads/direct/sessions") {
        const body = JSON.parse(request.body.toString());
        return { status: 201, body: { sessionId: "s1", files: body.files.map((file, index) => ({
          index, clientId: file.clientId, id: `f${index}`, filename: sanitize(file.filename), mimeType: file.mimeType, sizeBytes: file.sizeBytes, mode: "single", putUrl: `${base}/storage/${index}`,
        })) } };
      }
      if (request.url.startsWith("/storage/")) return { headers: { etag: '"e"' }, body: {} };
      if (request.url.endsWith("/files/complete")) return { body: { ok: true } };
      if (request.url.endsWith("/confirm")) return { status: 201, body: intakeResult };
      return { status: 404, body: {} };
    });
    assert.equal(result.code, 0, result.stderr);
    const create = result.requests.find((request) => request.url === "/v1/uploads/direct/sessions");
    assert.ok(create.headers["idempotency-key"], "session create carries an Idempotency-Key");
    assert.deepEqual(JSON.parse(create.body.toString()).files.map((file) => file.clientId), ["0", "1"]);
    // Files upload in parallel, so match each PUT by its signed URL rather than by arrival order.
    const put = (index) => result.requests.find((request) => request.url === `/storage/${index}`);
    assert.equal(put(0).body.length, 21 * 1024 * 1024);
    assert.equal(put(1).body.toString(), "scan-bytes");
    assert.match(result.stdout, /Run ID:\s+run/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** A direct session that answers every file as a single PUT; `onComplete` decides each files/complete reply. */
/**
 * A direct session that answers every file as a single PUT; `onComplete` decides each file's complete. `batch: false` is a
 * server without batch completion (it refuses `{ files }` with 400); `batch: true` answers per file.
 */
function directSessionServer({ putDelayMs = 0, completeDelayMs = 0, onComplete, sessionStatus = "uploading", batch = false }) {
  const live = { put: 0, maxPut: 0, complete: 0, maxComplete: 0 };
  const files = [];
  const done = new Set();
  const settle = (key, ms) => setTimeout(() => { live[key]--; }, ms);
  const respond = (request, count, base) => {
    if (request.url === "/v1/uploads/direct/sessions") {
      const body = JSON.parse(request.body.toString());
      files.splice(0, files.length, ...body.files.map((file, index) => ({
        index, clientId: file.clientId, id: `f${index}`, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, mode: "single", putUrl: `${base}/storage/${index}`,
      })));
      return { status: 201, body: { sessionId: "s1", files } };
    }
    if (request.method === "GET" && request.url.startsWith("/v1/uploads/direct/sessions/s1")) {
      // Like the server: a `fileId` filter describes only the files it names.
      const asked = new URL(request.url, "http://local").searchParams.getAll("fileId");
      const described = asked.length ? files.filter((file) => asked.includes(file.id)) : files;
      return { body: { sessionId: "s1", status: sessionStatus, files: described.map((file) => ({ ...file, status: done.has(file.id) ? "completed" : "pending" })) } };
    }
    if (request.url.startsWith("/storage/")) {
      live.put++; live.maxPut = Math.max(live.maxPut, live.put); settle("put", putDelayMs);
      return { delayMs: putDelayMs, headers: { etag: '"e"' }, body: {} };
    }
    if (request.url.endsWith("/files/complete")) {
      live.complete++; live.maxComplete = Math.max(live.maxComplete, live.complete); settle("complete", completeDelayMs);
      const sent = JSON.parse(request.body.toString());
      if (sent.files && !batch) return { delayMs: completeDelayMs, status: 400, body: { error: { code: "invalid_request", message: "Check your request and try again." } } };
      if (sent.files) {
        const files = sent.files.map((file) => {
          const reply = onComplete(file);
          if ((reply.status ?? 200) < 300) { done.add(file.fileId); return { fileId: file.fileId, status: "completed" }; }
          if (reply.status === 409 && reply.body?.error?.code === "upload_session_busy") return { busy: true };
          return { fileId: file.fileId, status: "failed", error: { statusCode: reply.status, code: reply.body?.error?.code, message: "failed", retryable: reply.status === 503 } };
        });
        if (files.some((file) => file.busy)) return { delayMs: completeDelayMs, status: 409, body: { error: { code: "upload_session_busy", message: "Check your request and try again." } } };
        return { delayMs: completeDelayMs, body: { ok: files.every((file) => file.status === "completed"), files, sessionComplete: done.size === files.length } };
      }
      const reply = onComplete(JSON.parse(request.body.toString()));
      if ((reply.status ?? 200) < 300) done.add(JSON.parse(request.body.toString()).fileId);
      return { delayMs: completeDelayMs, ...reply };
    }
    if (request.url.endsWith("/confirm")) return { status: 201, body: intakeResult };
    return { status: 404, body: {} };
  };
  return { live, respond };
}

async function directFiles(dir, count) {
  const files = [join(dir, "big.pdf")];
  await writeFile(files[0], Buffer.alloc(21 * 1024 * 1024, 0x41));
  for (let i = 1; i < count; i++) { files.push(join(dir, `f${i}.pdf`)); await writeFile(files[i], `bytes-${i}`); }
  return files;
}

test("direct uploads send files in parallel but complete them one at a time, waiting out a busy session lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const files = await directFiles(dir, 6);
    let busy = 2;
    const completed = new Set();
    const { live, respond } = directSessionServer({ putDelayMs: 150, completeDelayMs: 30, onComplete: ({ fileId }) => {
      // The reconciler holds the lock: an older server's uncoded reply, then the coded one.
      // Production replaces the message with a generic public one, so only the code (and the session's state) can tell.
      if (busy-- > 0) return { status: 409, body: { error: { code: busy === 1 ? "conflict" : "upload_session_busy", message: "Check your request and try again." } } };
      completed.add(fileId);
      return { body: { ok: true } };
    } });
    const result = await invoke(["upload", ...files], respond);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(live.maxPut > 1, `storage PUTs overlapped (max ${live.maxPut})`);
    assert.ok(live.maxPut <= 6, `at most the default limit in flight (max ${live.maxPut})`);
    assert.equal(live.maxComplete, 1, "files/complete never overlaps within one upload");
    assert.equal(completed.size, files.length);
    assert.equal(result.requests.filter((request) => request.url.endsWith("/abort")).length, 0);
    // A body-less POST goes out as JSON `{}` (the production API refuses an upload-path POST with no content type).
    const confirm = result.requests.find((request) => request.url.endsWith("/confirm"));
    assert.match(confirm.headers["content-type"], /application\/json/);
    assert.equal(confirm.body.toString(), "{}");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an uncoded conflict on a closed session still fails the upload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const files = await directFiles(dir, 2);
    const { respond } = directSessionServer({ sessionStatus: "aborted", onComplete: () => ({ status: 409, body: { error: { code: "conflict", message: "Check your request and try again." } } }) });
    const result = await invoke(["upload", ...files], respond);
    assert.notEqual(result.code, 0);
    const completes = result.requests.filter((request) => request.url.endsWith("/files/complete")).map((request) => JSON.parse(request.body.toString()).fileId);
    assert.ok(completes.length >= 1);
    assert.equal(new Set(completes).size, completes.length, "no file's complete is retried");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an uncoded 409 for a file the reconciler already finalized counts as done; a rate-limited complete is repeated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const files = await directFiles(dir, 3);
    let calls = 0;
    const server = directSessionServer({ onComplete: ({ fileId }) => {
      if (fileId === "f2" && calls++ === 0) return { status: 429, headers: { "retry-after": "0" }, body: { error: { code: "rate_limited", message: "slow down" } } };
      if (fileId === "f1") { server.finalizedByReconciler = true; return { status: 409, body: { error: { code: "conflict", message: "Check your request and try again." } } }; }
      return { body: { ok: true } };
    } });
    const result = await invoke(["upload", ...files], (request, count, base) => {
      // The reconciler finalized f1 while it held the lock: the session reports it completed.
      if (request.method === "GET" && request.url.startsWith("/v1/uploads/direct/sessions/s1") && server.finalizedByReconciler) {
        const reply = server.respond(request, count, base);
        reply.body.files = reply.body.files.map((file) => (file.id === "f1" ? { ...file, status: "completed" } : file));
        return reply;
      }
      return server.respond(request, count, base);
    });
    assert.equal(result.code, 0, result.stderr);
    const f1 = result.requests.filter((request) => request.url.endsWith("/files/complete") && JSON.parse(request.body.toString()).fileId === "f1");
    assert.equal(f1.length, 1, "not repeated once the session says it is completed");
    const f2 = result.requests.filter((request) => request.url.endsWith("/files/complete") && JSON.parse(request.body.toString()).fileId === "f2");
    assert.equal(f2.length, 2, "the rate-limited complete is sent again");
    assert.equal(result.requests.filter((request) => request.url.endsWith("/abort")).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("against a server with batch completion, finished files are completed together and a retryable file is sent again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const files = await directFiles(dir, 40);
    let outage = 1;
    const { respond } = directSessionServer({ batch: true, putDelayMs: 20, completeDelayMs: 150, onComplete: ({ fileId }) => (
      fileId === "f7" && outage-- > 0 ? { status: 503, body: { error: { code: "upload_storage_unavailable", message: "x" } } } : { body: { ok: true } }
    ) });
    const result = await invoke(["upload", ...files], respond);
    assert.equal(result.code, 0, result.stderr);
    const completes = result.requests.filter((request) => request.url.endsWith("/files/complete")).map((request) => JSON.parse(request.body.toString()));
    assert.ok(completes.every((body) => Array.isArray(body.files)), "every call is a batch");
    assert.ok(completes.length < 20, `files finished during a call share the next one (${completes.length} calls for 40 files)`);
    const sent = completes.flatMap((body) => body.files.map((file) => file.fileId));
    assert.equal(sent.filter((id) => id === "f7").length, 2, "the retryable file is sent again");
    assert.equal(new Set(sent).size, 40);
    assert.ok(completes.every((body) => body.files.every((file) => !("parts" in file))), "batch entries carry no part lists");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a file the batch reports as failed for good fails the upload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const files = await directFiles(dir, 3);
    const { respond } = directSessionServer({ batch: true, onComplete: ({ fileId }) => (
      fileId === "f2" ? { status: 409, body: { error: { code: "conflict", message: "x" } } } : { body: { ok: true } }
    ) });
    const result = await invoke(["upload", ...files], respond);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /f2/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a rate-limited session read while checking an uncoded 409 is retried, not taken as failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const files = await directFiles(dir, 2);
    let conflicts = 1, limited = 1;
    const server = directSessionServer({ onComplete: () => (
      conflicts-- > 0 ? { status: 409, body: { error: { code: "conflict", message: "Check your request and try again." } } } : { body: { ok: true } }
    ) });
    const result = await invoke(["upload", ...files], (request, count, base) => (
      request.method === "GET" && request.url.startsWith("/v1/uploads/direct/sessions/s1") && limited-- > 0
        ? { status: 429, headers: { "retry-after": "0" }, body: { error: { code: "rate_limited", message: "slow down" } } }
        : server.respond(request, count, base)
    ));
    assert.equal(result.code, 0, result.stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an older server's generic 400 on complete (a storage hiccup) is retried a few times while the file is pending", async () => {
  for (const [failures, expectOk] of [[1, true], [10, false]]) {
    const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
    try {
      const files = await directFiles(dir, 2);
      let left = failures;
      const { respond } = directSessionServer({ onComplete: ({ fileId }) => (
        fileId === "f1" && left-- > 0 ? { status: 400, body: { error: { code: "invalid_request", message: "Please check the information you entered and try again." } } } : { body: { ok: true } }
      ) });
      const result = await invoke(["upload", ...files], respond, { killAfterMs: 60_000 });
      assert.equal(result.code === 0, expectOk, result.stderr);
      const probes = result.requests.filter((request) => request.method === "GET" && request.url.includes("statusOnly=true"));
      assert.ok(probes.length >= 1, "the probe uses the lock-free status read");
      if (!expectOk) assert.equal(result.requests.filter((request) => request.url.endsWith("/files/complete") && JSON.parse(request.body.toString()).fileId === "f1").length, 4, "three retries, then fail");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("locked out past the wait while the session is open, the CLI leaves the files to the server and reports its run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const files = await directFiles(dir, 4);
    let reconciled = false;
    const server = directSessionServer({ onComplete: () => ({ status: 409, body: { error: { code: "upload_session_busy", message: "x" } } }) });
    const result = await invoke(["upload", ...files, "--timeout", "2"], (request, count, base) => {
      if (request.method === "GET" && request.url.includes("statusOnly=true")) {
        // The server's reconciler finishes the session a moment after the CLI hands over.
        const polls = result_polls.count++;
        if (polls >= 3) reconciled = true;
        return { body: { sessionId: "s1", status: reconciled ? "confirmed" : "pending", result: reconciled ? intakeResult : null, files: [] } };
      }
      return server.respond(request, count, base);
    }, { killAfterMs: 60_000 });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /leaving the remaining files to it/);
    assert.match(result.stdout, /Run ID:\s+run/);
    assert.equal(result.requests.filter((request) => request.url.endsWith("/confirm")).length, 0, "no confirm: the server confirms");
    assert.equal(result.requests.filter((request) => request.url.endsWith("/abort")).length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
const result_polls = { count: 0 };

test("more than 1,000 files go up as several sessions; a failed session does not stop the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const files = await directFiles(dir, 2001);
    let sessions = 0;
    const { respond: base } = directSessionServer({ onComplete: () => ({ body: { ok: true } }) });
    const result = await invoke(["upload", ...files, "--idempotency-key", "batch-key"], (request, count, url) => {
      if (request.url === "/v1/uploads/direct/sessions" && ++sessions === 2) return { status: 400, body: { error: { code: "bad_request", message: "refused" } } };
      return base(request, count, url);
    }, { killAfterMs: 60_000 });
    assert.equal(result.code, 0, result.stderr);
    const creates = result.requests.filter((request) => request.url === "/v1/uploads/direct/sessions");
    assert.deepEqual(creates.map((request) => JSON.parse(request.body.toString()).files.length), [1000, 1000, 1]);
    assert.deepEqual(creates.map((request) => request.headers["idempotency-key"]), ["batch-key.1", "batch-key.2", "batch-key.3"]);
    assert.equal(result.requests.filter((request) => request.url.startsWith("/storage/")).length, 1001, "the refused session's files are not sent");
    assert.match(result.stderr, /1 of 3 upload sessions failed/);
    assert.equal((result.stdout.match(/Run ID:/g) ?? []).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("when every session fails, the command fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const files = await directFiles(dir, 1001);
    const result = await invoke(["upload", ...files], (request) => (
      request.url === "/v1/uploads/direct/sessions" ? { status: 400, body: { error: { code: "bad_request", message: "refused" } } } : { status: 404, body: {} }
    ));
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /2 of 2 upload sessions failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a timed-out bulk upload is sent again with the same Idempotency-Key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const file = join(dir, "note.txt");
    await writeFile(file, "hello");
    const result = await invoke(["upload", file, "--timeout", "0.5"], (request, count) => (
      count === 1 ? { delayMs: 1500, status: 201, body: intakeResult } : { status: 201, body: intakeResult }
    ));
    assert.equal(result.code, 0, result.stderr);
    const bulk = result.requests.filter((request) => request.url === "/v1/uploads/bulk");
    assert.equal(bulk.length, 2);
    assert.ok(bulk[0].headers["idempotency-key"]);
    assert.equal(bulk[0].headers["idempotency-key"], bulk[1].headers["idempotency-key"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("direct session rejections are reported under the user's filenames while the rest uploads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const big = join(dir, "big.pdf");
    const bad = join(dir, "tool?.exe");
    await writeFile(big, Buffer.alloc(21 * 1024 * 1024, 0x41));
    await writeFile(bad, "MZ");
    const result = await invoke(["upload", big, bad], (request, count, base) => {
      if (request.url === "/v1/uploads/direct/sessions") {
        return { status: 201, body: { sessionId: "s1",
          files: [{ index: 0, clientId: "0", id: "f0", filename: "big.pdf", mimeType: "application/pdf", sizeBytes: 21 * 1024 * 1024, mode: "single", putUrl: `${base}/storage/0` }],
          rejected: [{ index: 1, clientId: "1", filename: "tool-.exe", statusCode: 415, code: "unsupported_type", message: "Unsupported file type for tool-.exe" }] } };
      }
      if (request.url.startsWith("/storage/")) return { headers: { etag: '"e"' } };
      if (request.url.endsWith("/files/complete")) return { body: { ok: true } };
      if (request.url.endsWith("/confirm")) return { status: 201, body: intakeResult };
      return { status: 404 };
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.filter((request) => request.url.startsWith("/storage/")).length, 1);
    assert.match(result.stderr, /tool\?\.exe/);
    assert.match(result.stderr, /1 of 2 files were not uploaded/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("--idempotency-key is the key a direct upload sends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    // Over the bulk transport's cap, so the upload goes through a direct session.
    const file = join(dir, "a.pdf");
    await writeFile(file, Buffer.alloc(21 * 1024 * 1024, 0x41));
    const result = await invoke(["upload", file, "--idempotency-key", "my-retry-key"], (request, count, base) => {
      if (request.url === "/v1/uploads/direct/sessions") {
        const body = JSON.parse(request.body.toString());
        return { status: 201, body: { sessionId: "s1", files: body.files.map((f, index) => ({ index, clientId: f.clientId, id: `f${index}`, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.sizeBytes, mode: "single", putUrl: `${base}/storage/${index}` })) } };
      }
      if (request.url.startsWith("/storage/")) return { headers: { etag: '"e"' }, body: {} };
      if (request.url.endsWith("/files/complete")) return { body: { ok: true } };
      if (request.url.endsWith("/confirm")) return { status: 201, body: intakeResult };
      return { status: 404, body: {} };
    });
    assert.equal(result.code, 0, result.stderr);
    const create = result.requests.find((request) => request.url === "/v1/uploads/direct/sessions");
    assert.equal(create.headers["idempotency-key"], "my-retry-key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a coded in-flight 409 on session create is retried with the same key instead of failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    // Over the bulk transport's cap, so the upload goes through a direct session.
    const file = join(dir, "a.pdf");
    await writeFile(file, Buffer.alloc(21 * 1024 * 1024, 0x41));
    let creates = 0;
    const result = await invoke(["upload", file], (request, count, base) => {
      if (request.url === "/v1/uploads/direct/sessions") {
        if (++creates <= 2) return { status: 409, body: { error: { code: "idempotency_in_flight", message: "still being processed" } } };
        const body = JSON.parse(request.body.toString());
        return { status: 201, body: { sessionId: "s1", files: body.files.map((f, index) => ({ index, clientId: f.clientId, id: `f${index}`, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.sizeBytes, mode: "single", putUrl: `${base}/storage/${index}` })) } };
      }
      if (request.url.startsWith("/storage/")) return { headers: { etag: '"e"' }, body: {} };
      if (request.url.endsWith("/files/complete")) return { body: { ok: true } };
      if (request.url.endsWith("/confirm")) return { status: 201, body: intakeResult };
      return { status: 404, body: {} };
    });
    assert.equal(result.code, 0, result.stderr);
    const attempts = result.requests.filter((request) => request.url === "/v1/uploads/direct/sessions");
    assert.equal(attempts.length, 3);
    assert.equal(new Set(attempts.map((request) => request.headers["idempotency-key"])).size, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("any other 409 on session create is reported at once, without a retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    // Over the bulk transport's cap, so the upload goes through a direct session.
    const file = join(dir, "a.pdf");
    await writeFile(file, Buffer.alloc(21 * 1024 * 1024, 0x41));
    const result = await invoke(["upload", file], (request) => (
      request.url === "/v1/uploads/direct/sessions" ? { status: 409, body: { error: { code: "idempotency_key_reused", message: "used for another request" } } } : { status: 404, body: {} }
    ));
    assert.notEqual(result.code, 0);
    assert.equal(result.requests.filter((request) => request.url === "/v1/uploads/direct/sessions").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resuming a file after an expired storage URL reads only that file from the session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    // A large first file makes this a direct upload session (small ones alone go up buffered).
    const files = await directFiles(dir, 2);
    const { respond } = directSessionServer({ onComplete: () => ({ body: { ok: true } }) });
    let expired = 1;
    const result = await invoke(["upload", ...files], (request, count, base) => {
      // The first PUT of the second file finds its signed URL expired (403): the CLI resumes from the session's view.
      if (request.url === "/storage/1" && expired-- > 0) return { status: 403, body: {} };
      return respond(request, count, base);
    });
    assert.equal(result.code, 0, result.stderr);
    const reads = result.requests.filter((request) => request.method === "GET" && request.url.startsWith("/v1/uploads/direct/sessions/s1") && !request.url.includes("statusOnly"));
    assert.ok(reads.length > 0, "the CLI re-read the session to resume");
    for (const read of reads) assert.match(read.url, /[?&]fileId=f1(&|$)/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("parts the session describes without a URL are signed through parts/sign before they are sent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const file = join(dir, "big.pdf");
    await writeFile(file, Buffer.alloc(21 * 1024 * 1024, 0x41));
    const partSize = 8 * 1024 * 1024;
    const result = await invoke(["upload", file], (request, _count, base) => {
      if (request.url === "/v1/uploads/direct/sessions") {
        // The server's part-URL budget ran out: part 1 carries its URL, parts 2 and 3 do not.
        return { status: 201, body: { sessionId: "s1", files: [{ index: 0, clientId: "0", id: "f0", filename: "big.pdf", mimeType: "application/pdf", sizeBytes: 21 * 1024 * 1024,
          mode: "multipart", partSize, partUrlsOmitted: true, pendingParts: [
            { partNumber: 1, sizeBytes: partSize, url: `${base}/storage/1` }, { partNumber: 2, sizeBytes: partSize }, { partNumber: 3, sizeBytes: 5 * 1024 * 1024 }] }] } };
      }
      if (request.url === "/v1/uploads/direct/sessions/s1/files/f0/parts/sign") {
        const { partNumbers } = JSON.parse(request.body.toString());
        return { body: { parts: partNumbers.map((partNumber) => ({ partNumber, url: `${base}/storage/${partNumber}` })) } };
      }
      if (request.url.startsWith("/storage/")) return { headers: { etag: `"e${request.url.slice(-1)}"` }, body: {} };
      if (request.url.endsWith("/files/complete")) return { body: { ok: true } };
      if (request.url.endsWith("/confirm")) return { status: 201, body: intakeResult };
      return { status: 404, body: {} };
    }, { killAfterMs: 60_000 });
    assert.equal(result.code, 0, result.stderr);
    const signs = result.requests.filter((request) => request.url.endsWith("/parts/sign"));
    assert.equal(signs.length, 1);
    assert.deepEqual(JSON.parse(signs[0].body.toString()).partNumbers, [2, 3]);
    assert.deepEqual(result.requests.filter((request) => request.url.startsWith("/storage/")).map((request) => request.url).sort(), ["/storage/1", "/storage/2", "/storage/3"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("uninspected files are completed in one batch: a coded-missing file costs one complete and no wait, then one read and its bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const files = await directFiles(dir, 2); // a 21 MiB multipart file (index 0) and a small single file (index 1)
    let sent = false;
    const started = Date.now();
    const result = await invoke(["upload", ...files], (request, _count, base) => {
      if (request.url === "/v1/uploads/direct/sessions") {
        // A large session's replayed read: neither file was inspected.
        return { status: 201, body: { sessionId: "s1", files: [
          { index: 0, clientId: "0", id: "f0", filename: "big.pdf", mimeType: "application/pdf", sizeBytes: 21 * 1024 * 1024, mode: "multipart", partSize: 8 * 1024 * 1024, inspected: false, transferState: "unknown" },
          { index: 1, clientId: "1", id: "f1", filename: "f1.pdf", mimeType: "application/pdf", sizeBytes: 7, mode: "single", inspected: false, putUrl: `${base}/storage/stale` },
        ] } };
      }
      if (request.url.endsWith("/files/complete")) {
        const body = JSON.parse(request.body.toString());
        const ids = body.files ? body.files.map((file) => file.fileId) : [body.fileId];
        // f0 is already assembled in storage; f1 has no object until it is sent.
        return { body: { files: ids.map((fileId) => fileId === "f1" && !sent
          ? { fileId, status: "failed", error: { statusCode: 409, code: "upload_object_missing", message: "No object found", retryable: false, action: "reupload", blocksSession: false } }
          : { fileId, status: "completed" }), sessionComplete: sent } };
      }
      if (request.url === "/v1/uploads/direct/sessions/s1?fileId=f1") {
        return { body: { sessionId: "s1", status: "pending", files: [{ index: 1, clientId: "1", id: "f1", filename: "f1.pdf", mimeType: "application/pdf", sizeBytes: 7, mode: "single", status: "pending", putUrl: `${base}/storage/fresh` }] } };
      }
      if (request.url.startsWith("/storage/")) { sent = true; return { headers: { etag: '"e"' }, body: {} }; }
      if (request.url.endsWith("/confirm")) return { status: 201, body: intakeResult };
      return { status: 404, body: {} };
    });
    assert.equal(result.code, 0, result.stderr);
    // The assembled multipart file sent nothing; the missing file was read once, then sent to its fresh URL.
    assert.deepEqual(result.requests.filter((request) => request.url.startsWith("/storage/")).map((request) => request.url), ["/storage/fresh"]);
    const completes = result.requests.filter((request) => request.url.endsWith("/files/complete")).map((request) => JSON.parse(request.body.toString()));
    // One batch settles both uninspected files; the resent file is completed once more after its bytes.
    assert.deepEqual(completes[0], { files: [{ fileId: "f0" }, { fileId: "f1" }] });
    assert.equal(completes.length, 2);
    assert.equal(result.requests.filter((request) => request.url.includes("?fileId=")).length, 1);
    assert.ok(Date.now() - started < 10_000, "no busy wait for a missing file");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an uninspected file's uncoded 409 is a failure, never a wait or a resend", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const files = await directFiles(dir, 1);
    const started = Date.now();
    const result = await invoke(["upload", ...files], (request) => {
      if (request.url === "/v1/uploads/direct/sessions") {
        return { status: 201, body: { sessionId: "s1", files: [{ index: 0, clientId: "0", id: "f0", filename: "big.pdf", mimeType: "application/pdf", sizeBytes: 21 * 1024 * 1024, mode: "multipart", partSize: 8 * 1024 * 1024, inspected: false, transferState: "unknown" }] } };
      }
      if (request.url.endsWith("/files/complete")) return { status: 409, body: { error: { code: "conflict", message: "Check your request and try again." } } };
      if (request.url.endsWith("/abort")) return { body: { ok: true } };
      return { status: 404, body: {} };
    });
    assert.notEqual(result.code, 0);
    assert.equal(result.requests.filter((request) => request.url.endsWith("/files/complete")).length, 1);
    assert.equal(result.requests.filter((request) => request.url.startsWith("/storage/") || request.url.includes("?fileId=")).length, 0);
    assert.equal(result.requests.filter((request) => request.url.endsWith("/abort")).length, 1);
    assert.ok(Date.now() - started < 10_000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an upload whose session stays busy past --timeout is kept for the server, not aborted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
  try {
    const files = await directFiles(dir, 1);
    const result = await invoke(["upload", ...files, "--timeout", "2"], (request) => {
      if (request.url === "/v1/uploads/direct/sessions") {
        return { status: 201, body: { sessionId: "s1", files: [{ index: 0, clientId: "0", id: "f0", filename: "big.pdf", mimeType: "application/pdf", sizeBytes: 21 * 1024 * 1024, mode: "multipart", partSize: 8 * 1024 * 1024, inspected: false, transferState: "unknown" }] } };
      }
      if (request.url.endsWith("/files/complete")) return { status: 409, headers: { "retry-after": "0" }, body: { error: { code: "upload_session_busy", message: "busy" } } };
      if (request.url.endsWith("/abort")) return { body: { ok: true } };
      return { status: 404, body: {} };
    });
    assert.notEqual(result.code, 0);
    assert.ok(result.requests.filter((request) => request.url.endsWith("/files/complete")).length > 1, "the busy complete was waited out");
    assert.equal(result.requests.filter((request) => request.url.endsWith("/abort")).length, 0);
    assert.match(result.stderr, /s1/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("duplicate remote file ids or a changed refreshed descriptor stop the upload before any bytes move", async () => {
  const big = (id, extra = {}) => ({ index: 0, clientId: "0", id, filename: "big.pdf", mimeType: "application/pdf", sizeBytes: 21 * 1024 * 1024, mode: "single", putUrl: "/storage/0", ...extra });
  const small = (id, extra = {}) => ({ index: 1, clientId: "1", id, filename: "f1.pdf", mimeType: "application/pdf", sizeBytes: 7, mode: "single", putUrl: "/storage/1", ...extra });
  const missing = (ids) => ({ body: { files: ids.map((fileId) => ({ fileId, status: "failed", error: { statusCode: 409, code: "upload_object_missing", message: "missing" } })) } });
  const cases = [
    ["session descriptors", [big("same"), small("same")], () => ({ body: {} }), () => ({ body: {} })],
    ["a completion result", [big("a", { inspected: false }), small("b", { inspected: false })],
      () => ({ body: { files: [{ fileId: "a", status: "completed" }, { fileId: "a", status: "completed" }] } }), () => ({ body: {} })],
    ["a refreshed read", [big("a", { inspected: false }), small("b")], () => missing(["a"]),
      () => ({ body: { sessionId: "s1", status: "pending", files: [big("a", { putUrl: "/storage/x" }), big("a", { putUrl: "/storage/y" })] } })],
    ["a changed refreshed descriptor", [big("a", { inspected: false }), small("b")], () => missing(["a"]),
      () => ({ body: { sessionId: "s1", status: "pending", files: [big("a", { sizeBytes: 7, putUrl: "/storage/other" })] } })],
  ];
  for (const [label, descriptors, complete, refresh] of cases) {
    const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
    try {
      const files = await directFiles(dir, 2);
      const result = await invoke(["upload", ...files], (request, _count, base) => {
        if (request.url === "/v1/uploads/direct/sessions") {
          return { status: 201, body: { sessionId: "s1", files: descriptors.map((file) => ({ ...file, putUrl: `${base}${file.putUrl}` })) } };
        }
        if (request.url.endsWith("/files/complete")) return complete();
        if (request.url.includes("?fileId=")) {
          const answer = refresh();
          return { body: { ...answer.body, files: (answer.body.files ?? []).map((file) => ({ ...file, putUrl: `${base}${file.putUrl}` })) } };
        }
        if (request.url.endsWith("/abort")) return { body: { ok: true } };
        if (request.url.startsWith("/storage/")) return { headers: { etag: '"e"' }, body: {} };
        return { status: 404, body: {} };
      });
      assert.notEqual(result.code, 0, label);
      assert.match(result.stderr, /more than once|differently/, label);
      assert.equal(result.requests.filter((request) => request.url.startsWith("/storage/")).length, 0, `${label}: no bytes sent`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("uninspected files answered retryable (per-file busy or storage unavailable) go into the next batch; out of rounds the session is kept", async () => {
  const busy = { statusCode: 409, code: "upload_session_busy", message: "busy", retryable: true, action: "retry", blocksSession: false };
  const unavailable = { statusCode: 503, code: "upload_storage_unavailable", message: "down", retryable: true, action: "retry", blocksSession: false };
  for (const [label, stillFailing] of [["recovers", 2], ["stays busy", Infinity]]) {
    const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
    try {
      const files = await directFiles(dir, 2);
      let completes = 0;
      const result = await invoke(["upload", ...files], (request, _count, base) => {
        if (request.url === "/v1/uploads/direct/sessions") {
          return { status: 201, body: { sessionId: "s1", files: [
            { index: 0, clientId: "0", id: "f0", filename: "big.pdf", mimeType: "application/pdf", sizeBytes: 21 * 1024 * 1024, mode: "multipart", partSize: 8 * 1024 * 1024, inspected: false, transferState: "unknown" },
            { index: 1, clientId: "1", id: "f1", filename: "f1.pdf", mimeType: "application/pdf", sizeBytes: 7, mode: "single", inspected: false, putUrl: `${base}/storage/1` },
          ] } };
        }
        if (request.url.endsWith("/files/complete")) {
          completes += 1;
          const ids = JSON.parse(request.body.toString()).files.map((file) => file.fileId);
          return { body: { files: ids.map((fileId) => completes > stillFailing ? { fileId, status: "completed" } : { fileId, status: "failed", error: fileId === "f0" ? busy : unavailable }) } };
        }
        if (request.url.endsWith("/confirm")) return { status: 201, body: intakeResult };
        if (request.url.endsWith("/abort")) return { body: { ok: true } };
        return { status: 404, body: {} };
      });
      const urls = result.requests.map((request) => request.url);
      assert.equal(urls.filter((url) => url.endsWith("/abort")).length, 0, `${label}: never aborted`);
      assert.equal(urls.filter((url) => url.startsWith("/storage/")).length, 0, `${label}: no bytes resent`);
      if (stillFailing === 2) {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(urls.filter((url) => url.endsWith("/files/complete")).length, 3);
      } else {
        assert.notEqual(result.code, 0);
        assert.equal(urls.filter((url) => url.endsWith("/files/complete")).length, 4);
        assert.match(result.stderr, /s1/);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("a resume refuses foreign ids: extra completion results, extra descriptors in a filtered read, a renamed legacy match", async () => {
  const missing = (fileId) => ({ fileId, status: "failed", error: { statusCode: 409, code: "upload_object_missing", message: "missing", retryable: false } });
  const big = (extra) => ({ id: "f0", filename: "big.pdf", mimeType: "application/pdf", sizeBytes: 21 * 1024 * 1024, mode: "single", putUrl: "/storage/0", ...extra });
  const cases = [
    ["an extra completion result", big({ index: 0, clientId: "0", inspected: false }), () => ({ body: { files: [missing("f0"), { fileId: "other", status: "completed" }] } }), null],
    ["an extra descriptor in the filtered read", big({ index: 0, clientId: "0", inspected: false }), () => ({ body: { files: [missing("f0")] } }),
      () => [big({ index: 0, clientId: "0", putUrl: "/storage/a" }), big({ id: "other", index: 1, clientId: "1", putUrl: "/storage/other" })]],
    ["a renamed legacy match", big({ inspected: false }), () => ({ body: { files: [missing("f0")] } }),
      () => [big({ filename: "other.pdf", putUrl: "/storage/renamed" })]],
  ];
  for (const [label, descriptor, complete, refresh] of cases) {
    const dir = await mkdtemp(join(tmpdir(), "cli-upload-"));
    try {
      const files = await directFiles(dir, 1);
      const result = await invoke(["upload", ...files], (request, _count, base) => {
        if (request.url === "/v1/uploads/direct/sessions") return { status: 201, body: { sessionId: "s1", files: [{ ...descriptor, putUrl: `${base}${descriptor.putUrl}` }] } };
        if (request.url.endsWith("/files/complete")) return complete();
        if (request.url.includes("?fileId=") && refresh) return { body: { sessionId: "s1", status: "pending", files: refresh().map((file) => ({ ...file, putUrl: `${base}${file.putUrl}` })) } };
        if (request.url.endsWith("/abort")) return { body: { ok: true } };
        if (request.url.startsWith("/storage/")) return { headers: { etag: '"e"' }, body: {} };
        return { status: 404, body: {} };
      });
      assert.notEqual(result.code, 0, label);
      assert.match(result.stderr, /did not send|not asked for|differently/, label);
      assert.equal(result.requests.filter((request) => request.url.startsWith("/storage/")).length, 0, `${label}: no bytes sent`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
