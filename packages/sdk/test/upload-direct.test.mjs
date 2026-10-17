import assert from "node:assert/strict";
import { test } from "node:test";

import { createDocSlurpClient, DIRECT_UPLOAD_THRESHOLD_BYTES } from "../dist/index.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const uploadResult = { workspace: { id: "workspace" }, run: { id: "run" }, documents: [] };

function fakeApi({ mode = "single", partSize = 4 } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const href = String(url);
    const headers = new Headers(init.headers);
    calls.push({ url: href, method: init.method ?? "GET", auth: headers.get("authorization"), contentType: headers.get("content-type"), body: init.body });
    if (href.endsWith("/v1/uploads/direct/sessions")) {
      const request = JSON.parse(init.body);
      return json({
        sessionId: "s1",
        files: request.files.map((file, index) => mode === "single"
          ? { id: `f${index}`, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, mode, putUrl: `https://storage.invalid/put/${index}` }
          : { id: `f${index}`, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, mode, partSize,
              pendingParts: Array.from({ length: Math.ceil(file.sizeBytes / partSize) }, (_, part) => ({ partNumber: part + 1, sizeBytes: Math.min(partSize, file.sizeBytes - part * partSize), url: `https://storage.invalid/part/${part + 1}` })) }),
      }, 201);
    }
    if (href.startsWith("https://storage.invalid/")) return new Response(null, { status: 200, headers: { etag: `"etag-${calls.length}"` } });
    if (href.endsWith("/files/complete")) return json({ ok: true });
    if (href.endsWith("/confirm")) return json(uploadResult, 201);
    if (href.endsWith("/abort")) return json({ ok: true });
    if (href.endsWith("/v1/uploads/bulk")) return json(uploadResult, 201);
    return json({ error: "unexpected" }, 500);
  };
  return { fetch, calls };
}

test("uploads above the threshold go through a direct session, never multipart /bulk", async () => {
  const api = fakeApi();
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });
  const big = new Blob([new Uint8Array(DIRECT_UPLOAD_THRESHOLD_BYTES + 1)], { type: "application/pdf" });
  const result = await client.upload({ data: big, filename: "big.pdf", canonicalId: "/manual" });
  assert.equal(result.run.id, "run");
  const urls = api.calls.map((call) => `${call.method} ${call.url}`);
  assert.deepEqual(urls, [
    "POST https://api.invalid/v1/uploads/direct/sessions",
    "PUT https://storage.invalid/put/0",
    "POST https://api.invalid/v1/uploads/direct/sessions/s1/files/complete",
    "POST https://api.invalid/v1/uploads/direct/sessions/s1/confirm",
  ]);
  const session = JSON.parse(api.calls[0].body);
  assert.deepEqual(session.files, [{ filename: "big.pdf", mimeType: "application/pdf", sizeBytes: big.size, canonicalId: "/manual" }]);
  assert.equal(session.workspaceId, "default");
  // Presigned storage URLs never receive the API key.
  assert.equal(api.calls[1].auth, null);
  assert.equal(api.calls[1].contentType, "application/pdf");
  assert.equal(api.calls[0].auth, "Bearer key");
});

test("small uploads keep the single multipart request", async () => {
  const api = fakeApi();
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });
  await client.upload(new Blob(["hello"], { type: "text/plain" }));
  assert.deepEqual(api.calls.map((call) => call.url), ["https://api.invalid/v1/uploads/bulk"]);
});

test("multipart sessions upload each part slice and complete with their ETags", async () => {
  const api = fakeApi({ mode: "multipart", partSize: 4 });
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });
  await client.upload(new Blob(["0123456789"]), { directUpload: true, filename: "ten.txt" });
  const parts = api.calls.filter((call) => call.url.startsWith("https://storage.invalid/part/"));
  assert.deepEqual(await Promise.all(parts.map((call) => call.body.text())), ["0123", "4567", "89"]);
  const complete = JSON.parse(api.calls.find((call) => call.url.endsWith("/files/complete")).body);
  assert.deepEqual(complete.parts.map((part) => part.partNumber), [1, 2, 3]);
  assert.ok(complete.parts.every((part) => part.etag.startsWith('"etag-')));
});

test("a failed storage PUT aborts the session and surfaces the error", async () => {
  const api = fakeApi();
  const failing = async (url, init) => String(url).startsWith("https://storage.invalid/") ? new Response("denied", { status: 403 }) : api.fetch(url, init);
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: failing });
  await assert.rejects(client.upload(new Blob(["x"]), { directUpload: true }), error => {
    assert.equal(error.status, 403);
    assert.equal(error.body, "denied");
    assert.match(error.message, /don’t have access/);
    return true;
  });
  assert.ok(api.calls.some((call) => call.url.endsWith("/v1/uploads/direct/sessions/s1/abort")));
});
