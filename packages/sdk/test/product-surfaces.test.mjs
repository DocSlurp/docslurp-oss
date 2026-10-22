import assert from "node:assert/strict";
import { test } from "node:test";
import { createDocSlurpClient } from "../dist/index.js";
const json = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

test("workspace discovery returns records and escapes detail IDs", async () => {
  const calls = [];
  const workspace = { id: "ws/one", name: "Manuals" };
  const client = createDocSlurpClient({ apiUrl: "https://example.test", fetch: async url => {
    calls.push(url);
    return json(url.endsWith("/workspaces") ? { workspaces: [workspace] } : workspace);
  } });
  assert.deepEqual(await client.listWorkspaces(), [workspace]);
  assert.deepEqual(await client.getWorkspace(workspace.id), workspace);
  assert.deepEqual(calls, ["https://example.test/v1/workspaces", "https://example.test/v1/workspaces/ws%2Fone"]);
});

test("upload accepts URLs into a workspace named by the caller with retry identity", async () => {
  const client = createDocSlurpClient({ workspace: "existing", fetch: async (url, init) => {
    assert.ok(url.endsWith("/v1/uploads/url"));
    assert.equal(new Headers(init.headers).get("Idempotency-Key"), "import-1");
    assert.deepEqual(JSON.parse(init.body), { urls: ["https://files.example/manual.pdf"], workspace: "Manuals", newWorkspace: false });
    return json({ run: { id: "run-1" } });
  } });
  assert.equal((await client.upload({ urls: ["https://files.example/manual.pdf"], workspace: "Manuals", idempotencyKey: "import-1" })).run.id, "run-1");
});

test("explicit session lifecycle preserves file metadata and separates completion from ingestion", async () => {
  const calls = [];
  const client = createDocSlurpClient({ workspace: "manuals", fetch: async (url, init) => {
    calls.push({ path: new URL(url).pathname, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return json({ sessionId: "session/one", status: "uploading", files: [], ok: true });
  } });
  const files = [{ filename: "manual.pdf", mimeType: "application/pdf", sizeBytes: 10, singlePart: true }];
  await client.createUploadSession({ files });
  await client.getUploadSession("session/one");
  await client.completeUploadFile("session/one", { fileId: "file-1", etag: "etag" });
  await client.completeUploadSession("session/one");
  await client.abortUploadSession("session/one");
  assert.deepEqual(calls[0].body, { files, workspace: "manuals", newWorkspace: false });
  assert.deepEqual(calls.slice(1).map(call => [call.method, call.path]), [
    ["GET", "/v1/uploads/direct/sessions/session%2Fone"],
    ["POST", "/v1/uploads/direct/sessions/session%2Fone/files/complete"],
    ["POST", "/v1/uploads/direct/sessions/session%2Fone/confirm"],
    ["POST", "/v1/uploads/direct/sessions/session%2Fone/abort"],
  ]);
  assert.deepEqual(calls[2].body, { fileId: "file-1", etag: "etag" });
});
