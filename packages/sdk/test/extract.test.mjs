import assert from "node:assert/strict";
import { test } from "node:test";

import { createDocSlurpClient, DocSlurpApiError } from "../dist/index.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const extract = { id: "ext_1", status: "processing", expiresAt: "2026-10-29T00:00:00.000Z" };
const result = { workspace: { id: "workspace" }, run: { id: "run" }, documents: [], extract };

function fakeApi() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, method: init.method ?? "GET", body: init.body, redirect: init.redirect, auth: new Headers(init.headers).get("authorization") });
    if (href.endsWith("/v1/extracts/direct/sessions")) {
      const request = JSON.parse(init.body);
      return json({ sessionId: "s1", extract, files: request.files.map((file, index) => ({ id: `f${index}`, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, mode: "single", putUrl: `https://storage.invalid/put/${index}` })) }, 201);
    }
    if (href.startsWith("https://storage.invalid/")) return new Response(null, { status: 200, headers: { etag: "\"e\"" } });
    if (href.endsWith("/v1/uploads/direct/sessions/s1?statusOnly=true")) return json({ status: "completed", result });
    if (href.endsWith("/v1/extracts/url") || href.endsWith("/v1/extracts/bulk")) return json(result, 201);
    if (href.endsWith("/v1/extracts/ext_1")) return json({ extract });
    if (href.endsWith("/v1/extracts/ext_gone")) return json({ error: { code: "extract_expired", message: "expired" } }, 410);
    if (href.endsWith("/v1/extracts/ext_1/download")) return new Response(null, { status: 302, headers: { location: "https://storage.invalid/zip?X-Amz-Expires=120" } });
    return json({ error: "unexpected" }, 500);
  };
  return { fetch, calls };
}

test("extract uses the upload transports against /v1/extracts and sends the retention options", async () => {
  const api = fakeApi();
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });

  const fromUrls = await client.extract({ urls: ["https://example.com/a.pdf"] }, { retentionDays: 7, notifyEmail: false });
  assert.equal(fromUrls.extract.id, "ext_1");
  assert.deepEqual(JSON.parse(api.calls[0].body), { urls: ["https://example.com/a.pdf"], newWorkspace: false, workspace: "default", retentionDays: 7, notifyEmail: false });
  assert.equal(api.calls[0].url, "https://api.invalid/v1/extracts/url");

  await client.extract(new Blob(["hello"], { type: "text/plain" }), { download: "all" });
  const session = api.calls.find((call) => call.url.endsWith("/v1/extracts/direct/sessions"));
  assert.equal(JSON.parse(session.body).download, "all");
  // The session continues on the shared upload session routes; storage PUTs never carry the key.
  assert.ok(api.calls.some((call) => call.url.endsWith("/v1/uploads/direct/sessions/s1?statusOnly=true")));
  assert.equal(api.calls.find((call) => call.method === "PUT").auth, null);

  await client.extract([new Blob(["x"], { type: "text/plain" })], { directUpload: false, retentionDays: 3 });
  const bulk = api.calls.find((call) => call.url.endsWith("/v1/extracts/bulk"));
  assert.equal(bulk.body.get("retentionDays"), "3");

  // Plain uploads are unchanged.
  assert.ok(!api.calls.some((call) => call.url.includes("/v1/uploads/url") || call.url.includes("/v1/uploads/bulk")));
  await assert.rejects(client.extract({ urls: ["https://example.com/a.pdf"] }, { retentionDays: 0 }), RangeError);
});

test("reads an extract, surfaces 410 for expired ones and returns the signed download URL without following it", async () => {
  const api = fakeApi();
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });
  assert.equal((await client.getExtract("ext_1")).status, "processing");
  await assert.rejects(client.getExtract("ext_gone"), (error) => error instanceof DocSlurpApiError && error.status === 410);
  assert.equal(await client.getExtractDownloadUrl("ext_1"), "https://storage.invalid/zip?X-Amz-Expires=120");
  const download = api.calls.find((call) => call.url.endsWith("/download"));
  assert.equal(download.redirect, "manual");
  assert.equal(download.auth, "Bearer key");
  assert.ok(!api.calls.some((call) => call.url.startsWith("https://storage.invalid/zip")));
});
