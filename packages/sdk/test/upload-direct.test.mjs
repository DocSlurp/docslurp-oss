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
    if (href.endsWith("/s1?statusOnly=true")) return json({ status: "completed", result: uploadResult });
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
    "GET https://api.invalid/v1/uploads/direct/sessions/s1?statusOnly=true",
  ]);
  const session = JSON.parse(api.calls[0].body);
  assert.deepEqual(session.files, [{ filename: "big.pdf", mimeType: "application/pdf", sizeBytes: big.size, canonicalId: "/manual" }]);
  assert.equal(session.workspace, "default");
  // Presigned storage URLs never receive the API key.
  assert.equal(api.calls[1].auth, null);
  assert.equal(api.calls[1].contentType, "application/pdf");
  assert.equal(api.calls[0].auth, "Bearer key");
});

test("small uploads use a single storage PUT", async () => {
  const api = fakeApi();
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });
  await client.upload(new Blob(["hello"], { type: "text/plain" }));
  assert.equal(api.calls.filter((call) => call.method === "PUT").length, 1);
  assert.ok(!api.calls.some((call) => call.url.endsWith("/bulk")));
});

test("known-size multipart sessions upload slices without explicit completion", async () => {
  const api = fakeApi({ mode: "multipart", partSize: 4 });
  const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });
  await client.upload(new Blob(["0123456789"]), { directUpload: true, filename: "ten.txt" });
  const parts = api.calls.filter((call) => call.url.startsWith("https://storage.invalid/part/"));
  assert.deepEqual(await Promise.all(parts.map((call) => call.body.text())), ["0123", "4567", "89"]);
  assert.ok(!api.calls.some((call) => call.url.endsWith("/files/complete") || call.url.endsWith("/confirm")));
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


test("tags survive multipart and direct upload transport selection", async () => {
  for (const directUpload of [false, true]) {
    const api = fakeApi();
    const client = createDocSlurpClient({ apiUrl: "https://api.invalid", apiKey: "key", fetch: api.fetch });
    await client.upload({ files: [new Blob(["hello"])], tags: ["finance", "FY26"] }, { directUpload });
    const body = api.calls[0].body;
    assert.deepEqual(directUpload ? JSON.parse(body).tags : JSON.parse(body.get("tags")), ["finance", "FY26"]);
  }
});

function streamApi({ failPart = false } = {}) {
  const calls = [];
  let failed = false;
  let active = 0;
  let maximum = 0;
  let completed = 0;
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    if (url.endsWith('/direct/sessions')) {
      const input = JSON.parse(init.body);
      assert.equal(input.files[0].sizeBytes, undefined);
      return json({ sessionId: 'stream', files: [{ id: 'file', mode: 'multipart', partSize: 4 }] });
    }
    if (url.endsWith('/parts/sign')) return json({ parts: JSON.parse(init.body).partNumbers.map(partNumber => ({ partNumber, url: `https://storage.invalid/${partNumber}` })) });
    if (url.startsWith('https://storage.invalid/')) {
      if (failPart && !failed) { failed = true; return new Response(null, { status: 503 }); }
      active++; maximum = Math.max(maximum, active);
      // Complete out of order to prove the EOS manifest is ordered.
      await new Promise(resolve => setTimeout(resolve, url.endsWith('/1') ? 15 : 1));
      active--; completed++;
      return new Response(null, { headers: { etag: `"${url.split('/').at(-1)}"` } });
    }
    if (url.endsWith('/files/complete')) { assert.equal(active, 0); assert.equal(completed, JSON.parse(init.body).parts.length); return json({ ok: true }); }
    if (url.endsWith('/abort')) return json({ ok: true });
    if (url.endsWith('/stream?statusOnly=true')) return json({ status: 'completed', result: uploadResult });
    throw new Error(`Unexpected ${url}`);
  };
  return { fetch, calls, maximum: () => maximum };
}

test('unknown-size streams retry replayable parts and complete in order only after all PUTs', async () => {
  const api = streamApi({ failPart: true });
  const client = createDocSlurpClient({ apiUrl: 'https://api.invalid', fetch: api.fetch });
  async function* bytes() { yield new TextEncoder().encode('0123456789'); }
  assert.equal((await client.upload(bytes(), { filename: 'stream.txt' })).run.id, 'run');
  const manifest = JSON.parse(api.calls.find(call => call.url.endsWith('/files/complete')).body);
  assert.equal(manifest.sizeBytes, 10);
  assert.deepEqual(manifest.parts.map(part => part.partNumber), [1, 2, 3]);
  const uploaded = api.calls.filter(call => call.url.startsWith('https://storage.invalid/'));
  assert.equal(uploaded.length, 4);
  assert.ok(!api.calls.some(call => call.url.endsWith('/confirm')));
});

test('source failure aborts the multipart session without completing it', async () => {
  const api = streamApi();
  const client = createDocSlurpClient({ apiUrl: 'https://api.invalid', fetch: api.fetch });
  const error = new Error('Source failed');
  async function* bytes() { yield new Uint8Array(4); throw error; }
  await assert.rejects(client.upload(bytes()), value => value === error);
  assert.ok(api.calls.some(call => call.url.endsWith('/abort')));
  assert.ok(!api.calls.some(call => call.url.endsWith('/files/complete')));
});

test('cancelling a stalled custom source aborts its session promptly', async () => {
  const api = streamApi();
  const controller = new AbortController();
  let returned = false;
  const source = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => { returned = true; return { done: true }; } }; } };
  const client = createDocSlurpClient({ apiUrl: 'https://api.invalid', fetch: api.fetch });
  const pending = client.upload(source, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('Cancelled')), 10);
  await assert.rejects(pending, /Cancelled/);
  assert.equal(returned, true);
  assert.ok(api.calls.some(call => call.url.endsWith('/abort')));
});


test('multiple unknown-size browser streams reject before any network request', async () => {
  const client = createDocSlurpClient({ fetch: async () => { throw new Error('Must not send request'); } });
  await assert.rejects(client.upload({ files: [
    { data: new Blob(['a']).stream(), filename: 'a.txt' },
    { data: new Blob(['b']).stream(), filename: 'b.txt' },
  ] }), /individually/);
});


test('large unknown streams keep at most three storage PUTs active', async () => {
  const api = streamApi();
  const client = createDocSlurpClient({ apiUrl: 'https://api.invalid', fetch: api.fetch });
  async function* bytes() { for (let i = 0; i < 20; i++) yield new Uint8Array(4); }
  await client.upload(bytes());
  assert.equal(api.maximum(), 3);
  assert.equal(api.calls.filter(call => call.url.startsWith('https://storage.invalid/')).length, 20);
});
