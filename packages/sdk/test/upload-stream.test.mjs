import assert from "node:assert/strict";
import { test } from "node:test";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createDocSlurpClient, DocSlurpApiError } from "../dist/index.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function withServer(run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const form = await new Response(bytes, { headers: { "content-type": request.headers["content-type"] } }).formData();
    form.raw = bytes.toString();
    requests.push(form);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ workspace: { id: "workspace" }, run: { id: "run" }, documents: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("direct Node streams preserve ranges, infer filenames, and set workspace options over defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docslurp-sdk-stream-"));
  try {
    const path = join(dir, "handbook.pdf");
    await writeFile(path, "prefixDOCUMENTsuffix");
    await withServer(async (apiUrl, requests) => {
      const client = createDocSlurpClient({ apiUrl, apiKey: "key", workspaceId: "client-default" });
      const source = createReadStream(path, { start: 6, end: 13, highWaterMark: 2 });
      assert.equal((await client.upload(source, { workspaceId: "override" })).run.id, "run");
      assert.equal(requests[0].get("files").name, "handbook.pdf");
      assert.equal(await requests[0].get("files").text(), "DOCUMENT");
      assert.equal(requests[0].get("workspaceId"), "override");
      assert.equal(source.destroyed, true);
      await client.upload(createReadStream(path, { encoding: "hex", start: 6, end: 7 }), { filename: 'named"\r\n.pdf', workspaceId: "" });
      assert.equal(await requests[1].get("files").text(), Buffer.from("DO").toString("hex"));
      assert.equal(requests[1].get("files").name, 'named"\r\n.pdf');
      assert.match(requests[1].raw, /filename="named%22%0D%0A.pdf"/);
      // An empty per-call ID falls back to the client's workspace.
      assert.equal(requests[1].get("workspaceId"), "client-default");
      const handle = await open(path);
      try {
        await client.upload(createReadStream(join(dir, "not-present.txt"), { fd: handle.fd, autoClose: false, start: 6, end: 7 }));
        assert.equal(await requests[2].get("files").text(), "DO");
        assert.equal(requests[2].get("files").name, "document-1");
      } finally { await handle.close().catch((error) => { if (error.code !== "EBADF") throw error; }); }
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("direct browser File and Blob use replayable FormData transport", async () => {
  const client = createDocSlurpClient({ apiKey: "key", fetch: async (_url, init) => {
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get("files").name, "policy.txt");
    assert.equal(await init.body.get("files").text(), "Actual bytes");
    return json({ run: { id: "run" } });
  } });
  await client.upload(new File(["Actual bytes"], "policy.txt"));
  await client.upload(new Blob(["Actual bytes"]), { filename: "policy.txt" });
});

test("streaming requests emit bounded chunks without retrying consumed sources", async () => {
  let calls = 0;
  const source = Object.assign(Readable.from([Buffer.alloc(1024 * 1024, 7)]), { path: Buffer.from("large.bin") });
  const client = createDocSlurpClient({ fetch: async (_url, init) => {
    calls++;
    assert.equal(init.duplex, "half");
    assert.match(init.headers.get("content-type"), /^multipart\/form-data; boundary=/);
    const reader = init.body.getReader();
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      assert.ok(next.value.byteLength <= 64 * 1024);
      bytes += next.value.byteLength;
    }
    assert.ok(bytes > 1024 * 1024);
    return json({ error: "Busy" }, 503);
  } });
  await assert.rejects(client.upload(source, { idempotencyKey: "one-shot" }), DocSlurpApiError);
  assert.equal(calls, 1);
  assert.equal(source.destroyed, true);
});

test("early API rejection closes unopened streams and cancellation releases active sources", async () => {
  const unopened = new Readable({ read() { throw new Error("Source must not be consumed"); } });
  const rejecting = createDocSlurpClient({ fetch: async () => json({ error: "Forbidden" }, 403) });
  await assert.rejects(rejecting.upload(unopened), (error) => error instanceof DocSlurpApiError && error.status === 403);
  assert.equal(unopened.destroyed, true);
  const controller = new AbortController();
  const reason = new Error("Cancel upload");
  const active = new Readable({ read() { this.push(Buffer.alloc(32 * 1024)); } });
  const aborting = createDocSlurpClient({ fetch: async (_url, init) => {
    const reader = init.body.getReader();
    await reader.read();
    await reader.read();
    controller.abort(reason);
    return reader.read();
  } });
  await assert.rejects(aborting.upload(active, { signal: controller.signal }), (error) => error === reason);
  assert.equal(active.destroyed, true);
});

test("request timeouts close idle stream sources", async () => {
  const source = new Readable({ read() {} });
  const client = createDocSlurpClient({ fetch: async (_url, init) => {
    // Drain form fields and part headers; the idle source then never yields.
    const reader = init.body.getReader();
    while (!(await reader.read()).done);
    throw new Error("Idle source unexpectedly completed");
  } });
  await assert.rejects(client.upload(source, { timeoutMs: 20 }), (error) => error.name === "DocSlurpTimeoutError");
  assert.equal(source.destroyed, true);
});

test("source open errors reject transport cleanly without unhandled stream errors", async () => {
  const source = createReadStream("/definitely-missing-docslurp-file.pdf");
  const client = createDocSlurpClient({ fetch: async (_url, init) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await new Response(init.body).arrayBuffer();
    return json({ run: { id: "run" } });
  } });
  await assert.rejects(client.upload(source), (error) => error.code === "ENOENT");
  assert.equal(source.destroyed, true);
});
