import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient } from "../dist/index.js";
const json = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

test("project discovery returns records and escapes detail IDs", async () => {
  const calls = [];
  const project = { id: "ws/one", name: "Manuals" };
  const client = createDocSlurpClient({ apiUrl: "https://example.test", fetch: async url => {
    calls.push(url);
    return json(url.endsWith("/projects") ? { projects: [project] } : project);
  } });
  assert.deepEqual(await client.listProjects(), [project]);
  assert.deepEqual(await client.getProject(project.id), project);
  assert.deepEqual(calls, ["https://example.test/v1/projects", "https://example.test/v1/projects/ws%2Fone"]);
});

test("upload accepts URLs into a project named by the caller with retry identity", async () => {
  const client = createDocSlurpClient({ project: "existing", fetch: async (url, init) => {
    assert.ok(url.endsWith("/v1/uploads/url"));
    assert.equal(new Headers(init.headers).get("Idempotency-Key"), "import-1");
    assert.deepEqual(JSON.parse(init.body), { urls: ["https://files.example/manual.pdf"], project: "Manuals", newProject: false });
    return json({ run: { id: "run-1" } });
  } });
  assert.equal((await client.upload({ urls: ["https://files.example/manual.pdf"], project: "Manuals", idempotencyKey: "import-1" })).run.id, "run-1");
});

test("explicit session lifecycle preserves file metadata and separates completion from ingestion", async () => {
  const calls = [];
  const client = createDocSlurpClient({ project: "manuals", fetch: async (url, init) => {
    calls.push({ path: new URL(url).pathname, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return json({ sessionId: "session/one", status: "uploading", files: [], ok: true });
  } });
  const files = [{ filename: "manual.pdf", mimeType: "application/pdf", sizeBytes: 10, singlePart: true }];
  await client.createUploadSession({ files });
  await client.getUploadSession("session/one");
  await client.completeUploadFile("session/one", { fileId: "file-1", etag: "etag" });
  await client.completeUploadSession("session/one");
  await client.abortUploadSession("session/one");
  assert.deepEqual(calls[0].body, { files, project: "manuals", newProject: false });
  assert.deepEqual(calls.slice(1).map(call => [call.method, call.path]), [
    ["GET", "/v1/uploads/direct/sessions/session%2Fone"],
    ["POST", "/v1/uploads/direct/sessions/session%2Fone/files/complete"],
    ["POST", "/v1/uploads/direct/sessions/session%2Fone/confirm"],
    ["POST", "/v1/uploads/direct/sessions/session%2Fone/abort"],
  ]);
  assert.deepEqual(calls[2].body, { fileId: "file-1", etag: "etag" });
});

test("completeUploadFiles sends batches of 100 and returns per-file answers", async () => {
  const bodies = [];
  const client = createDocSlurpClient({ apiUrl: "https://example.test", fetch: async (url, init) => {
    assert.ok(url.endsWith("/v1/uploads/direct/sessions/s1/files/complete"));
    const body = JSON.parse(init.body);
    bodies.push(body);
    return json({ ok: true, completedCount: body.files.length, failedCount: 0, sessionComplete: bodies.length === 3,
      files: body.files.map(file => file.fileId === "f7" ? { fileId: file.fileId, status: "failed", error: { statusCode: 409, code: "rejected", message: "changed", retryable: false, action: "reupload", blocksSession: false } } : { fileId: file.fileId, status: "completed" }) });
  } });
  const files = Array.from({ length: 250 }, (_, i) => ({ fileId: `f${i}` }));
  const result = await client.completeUploadFiles("s1", files);
  assert.deepEqual(bodies.map(body => body.files.length), [100, 100, 50]);
  assert.equal(result.files.length, 250);
  assert.equal(result.failedCount, 1);
  assert.equal(result.ok, false);
  assert.equal(result.sessionComplete, true);
  assert.deepEqual(result.files[7], { fileId: "f7", status: "failed", error: { statusCode: 409, code: "rejected", message: "changed", retryable: false, action: "reupload", blocksSession: false } });
});

test("completeUploadFiles falls back to one call per file on a server without batches", async () => {
  const bodies = [];
  const client = createDocSlurpClient({ apiUrl: "https://example.test", fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    // The older server's zod refusal of a body without fileId.
    if (body.files) return new Response(JSON.stringify({ error: { code: "invalid_request", message: "Invalid request", details: { issues: [{ path: "fileId", code: "invalid_type", message: "Required" }] } } }), { status: 400, headers: { "Content-Type": "application/json" } });
    if (body.fileId === "bad") return new Response(JSON.stringify({ error: { message: "Upload parts are incomplete or have incorrect sizes" } }), { status: 409, headers: { "Content-Type": "application/json" } });
    return json({ ok: true });
  } });
  const result = await client.completeUploadFiles("s1", [{ fileId: "a" }, { fileId: "bad" }, { fileId: "c", sizeBytes: 3 }]);
  assert.deepEqual(bodies.slice(1), [{ fileId: "a" }, { fileId: "bad" }, { fileId: "c", sizeBytes: 3 }]);
  assert.deepEqual(result.files.map(file => [file.fileId, file.status]), [["a", "completed"], ["bad", "failed"], ["c", "completed"]]);
  assert.equal(result.files[1].error.statusCode, 409);
  assert.equal(result.files[1].error.action, "reupload");
});

test("completeUploadFiles does not fall back on a 400 that is not the older server's refusal", async () => {
  let calls = 0;
  const client = createDocSlurpClient({ apiUrl: "https://example.test", fetch: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code: "invalid_request", message: "files must list between 1 and 100 entries" } }), { status: 400, headers: { "Content-Type": "application/json" } });
  } });
  await assert.rejects(client.completeUploadFiles("s1", [{ fileId: "a" }]), (error) => error.status === 400);
  assert.equal(calls, 1);
});

test("completeUploadFiles attaches what earlier batches completed to a session-level failure", async () => {
  let calls = 0;
  const client = createDocSlurpClient({ apiUrl: "https://example.test", fetch: async (_url, init) => {
    calls++;
    if (calls === 1) {
      const body = JSON.parse(init.body);
      return json({ ok: true, completedCount: body.files.length, failedCount: 0, sessionComplete: false, files: body.files.map(file => ({ fileId: file.fileId, status: "completed" })) });
    }
    return new Response(JSON.stringify({ error: { code: "upload_session_closed", message: "Upload session is closed" } }), { status: 409, headers: { "Content-Type": "application/json" } });
  } });
  const files = Array.from({ length: 150 }, (_, i) => ({ fileId: `f${i}` }));
  await assert.rejects(client.completeUploadFiles("s1", files), (error) => error.status === 409 && error.partialResults.completedCount === 100 && error.partialResults.files.length === 100);
});
