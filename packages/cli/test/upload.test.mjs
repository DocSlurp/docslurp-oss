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
      env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", DOCSLURP_API_KEY: "test-key", DOCSLURP_URL: "https://ignored-env.test", DOCSLURP_WORKSPACE: "" },
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
const intakeResult = { workspace: { id: "w", name: "Default", slug: "default" }, run: { id: "run" }, documents: [{ id: "d" }] };

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
    const puts = result.requests.filter((request) => request.url.startsWith("/storage/"));
    assert.equal(puts[0].body.length, 21 * 1024 * 1024);
    assert.equal(puts[1].body.toString(), "scan-bytes");
    assert.match(result.stdout, /Run ID:\s+run/);
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
