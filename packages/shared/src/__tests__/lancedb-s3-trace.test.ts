import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterAll, expect, it, vi } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { initializeObservability, shutdownObservability } from "../observability.js";
import { LanceS3Stats, beginSearchReadScope, classifyS3Request, lanceObjectClass, rangeSizeBucket, searchReadAttributes, withLanceSearchSpan, getLanceS3TraceStats, keyPrefix, signUpstreamRequest, startLanceS3Proxy, withLanceS3Proxy } from "../lancedb-s3-trace.js";

vi.stubEnv("OTEL_ENABLED", "true");
vi.stubEnv("LANGFUSE_ENABLED", "false");
const spans: ReadableSpan[] = [];
initializeObservability({ spanProcessors: [{ onStart() {}, onEnd(span) { spans.push(span); }, async shutdown() {}, async forceFlush() {} }] });
afterAll(async () => { await shutdownObservability(); vi.unstubAllEnvs(); });

it("classifies path-style S3 requests into API operations", () => {
  const op = (method: string, url: string, headers: IncomingHttpHeaders = {}) => classifyS3Request(method, url, headers).operation;
  expect(op("GET", "/b/lancedb/org/t.lance/data/x.lance")).toBe("GetObject");
  expect(op("HEAD", "/b/lancedb/org/t.lance/_latest.manifest")).toBe("HeadObject");
  expect(op("PUT", "/b/k")).toBe("PutObject");
  expect(op("PUT", "/b/k", { "x-amz-copy-source": "/b/o" })).toBe("CopyObject");
  expect(op("PUT", "/b/k?partNumber=2&uploadId=u")).toBe("UploadPart");
  expect(op("PUT", "/b/k?partNumber=2&uploadId=u", { "x-amz-copy-source": "/b/o" })).toBe("UploadPartCopy");
  expect(op("POST", "/b/k?uploads")).toBe("CreateMultipartUpload");
  expect(op("POST", "/b/k?uploadId=u")).toBe("CompleteMultipartUpload");
  expect(op("DELETE", "/b/k?uploadId=u")).toBe("AbortMultipartUpload");
  expect(op("DELETE", "/b/k")).toBe("DeleteObject");
  expect(op("GET", "/b?list-type=2&prefix=a%2F")).toBe("ListObjectsV2");
  expect(op("GET", "/b/?list-type=2")).toBe("ListObjectsV2");
  expect(op("GET", "/b?uploads")).toBe("ListMultipartUploads");
  expect(op("POST", "/b?delete")).toBe("DeleteObjects");
  expect(op("HEAD", "/b")).toBe("HeadBucket");
  expect(classifyS3Request("GET", "/bkt/a/b/c.lance").bucket).toBe("bkt");
  expect(classifyS3Request("GET", "/bkt/a/b/c.lance").key).toBe("a/b/c.lance");
  expect(keyPrefix("o1/t.lance/data/very/deep/file")).toBe("o1/t.lance/data");
});

it("re-signs for the real host, keeps conditional and range headers and the payload hash", async () => {
  const target = { protocol: "https:" as const, hostname: "fly.storage.tigris.dev", region: "auto" };
  const credentials = { accessKeyId: "AKTEST", secretAccessKey: "secret-value", sessionToken: "tok" };
  const incoming: IncomingHttpHeaders = {
    host: "127.0.0.1:5555", authorization: "AWS4-HMAC-SHA256 Credential=OLD/20200101/x/s3/aws4_request", "x-amz-date": "20200101T000000Z", "x-amz-security-token": "old",
    "if-none-match": "*", range: "bytes=0-99", "x-amz-content-sha256": "abc123", "content-length": "5", "accept-encoding": "gzip", connection: "keep-alive",
  };
  const signed = await signUpstreamRequest("PUT", "/bucket/a%20b/k.manifest?uploads&prefix=x%2Fy", incoming, target, credentials, new Date("2026-10-19T12:00:00Z"));
  expect(signed.headers.host).toBe("fly.storage.tigris.dev");
  expect(signed.headers["if-none-match"]).toBe("*");
  expect(signed.headers.range).toBe("bytes=0-99");
  expect(signed.headers["x-amz-content-sha256"]).toBe("abc123");
  expect(signed.headers["x-amz-date"]).toBe("20261019T120000Z");
  expect(signed.headers["x-amz-security-token"]).toBe("tok");
  expect(signed.headers.connection).toBeUndefined();
  expect(signed.headers["accept-encoding"]).toBeUndefined();
  const auth = signed.headers.authorization;
  expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKTEST\/20261019\/auto\/s3\/aws4_request/);
  expect(auth).toContain("if-none-match");
  expect(auth).toContain("range");
  expect(auth).not.toContain("OLD");
  expect(signed.path).toBe("/bucket/a%20b/k.manifest?uploads=&prefix=x%2Fy");
  // Deterministic: same inputs sign identically.
  expect((await signUpstreamRequest("PUT", "/bucket/a%20b/k.manifest?uploads&prefix=x%2Fy", incoming, target, credentials, new Date("2026-10-19T12:00:00Z"))).headers.authorization).toBe(auth);
  // Defaults to UNSIGNED-PAYLOAD when Lance sent no hash; refuses aws-chunked bodies.
  expect((await signUpstreamRequest("GET", "/b/k", {}, target, credentials)).headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
  await expect(signUpstreamRequest("PUT", "/b/k", { "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD" }, target, credentials)).rejects.toThrow(/aws-chunked/);
});

it("proxies bodies and conditional statuses unchanged, emits spans and counters", async () => {
  spans.length = 0;
  const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.headers["if-none-match"] === "*" && req.url!.includes("exists")) { res.writeHead(412, { "content-type": "application/xml" }); res.end("<Error/>"); return; }
      res.writeHead(req.method === "GET" ? 206 : 200, { "content-length": req.method === "GET" ? "6" : "0", etag: '"e"' });
      res.end(req.method === "GET" ? "answer" : undefined);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as { port: number }).port;
  const stats = new LanceS3Stats();
  const lines: string[] = [];
  const proxy = await startLanceS3Proxy({ endpoint: `http://127.0.0.1:${port}`, region: "us-east-1", credentials: { accessKeyId: "AK", secretAccessKey: "SK" }, stats, logIntervalMs: 0, log: (l) => lines.push(l) });
  try {
    const put = await fetch(`${proxy.endpoint}/bkt/idx/t.lance/_versions/1.manifest`, { method: "PUT", headers: { "if-none-match": "*" }, body: "payload" });
    expect(put.status).toBe(200);
    const conflict = await fetch(`${proxy.endpoint}/bkt/idx/t.lance/exists`, { method: "PUT", headers: { "if-none-match": "*" }, body: "x" });
    expect(conflict.status).toBe(412);
    expect(await conflict.text()).toBe("<Error/>");
    const get = await fetch(`${proxy.endpoint}/bkt/idx/t.lance/data/a.lance`, { headers: { range: "bytes=0-5" } });
    expect(get.status).toBe(206);
    expect(await get.text()).toBe("answer");
    expect(seen[0].body).toBe("payload");
    expect(seen[0].headers["if-none-match"]).toBe("*");
    expect(seen[0].headers.authorization).toMatch(/Credential=AK\//);
    expect(seen[0].headers.host).toBe(`127.0.0.1:${port}`);
    expect(seen[2].headers.range).toBe("bytes=0-5");
    // The failed conditional PUT is not a retry; an identical repeat after a 5xx would be.
    const snapshot = stats.snapshot();
    expect(snapshot.requests).toBe(3);
    expect(snapshot.byOperationStatus).toMatchObject({ "PutObject:200": 1, "PutObject:412": 1, "GetObject:206": 1 });
    expect(snapshot.bytesIn).toBe("payload".length + 1);
    expect(snapshot.bytesOut).toBe(6 + "<Error/>".length);
    const names = spans.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["lancedb.s3.PutObject", "lancedb.s3.GetObject"]));
    const conflictSpan = spans.find((s) => s.attributes["http.response.status_code"] === 412)!;
    expect(conflictSpan.attributes).toMatchObject({ "docslurp.storage.system": "lancedb-s3", "docslurp.s3.condition": "if-none-match", "aws.s3.bucket": "bkt", "docslurp.s3.key_prefix": "idx/t.lance/exists" });
    expect(conflictSpan.attributes["docslurp.s3.ttfb_ms"]).toBeTypeOf("number");
    expect(spans.find((s) => s.name === "lancedb.s3.GetObject")!.attributes["http.request.header.range"]).toBe("bytes=0-5");
    const line = stats.summaryLine(60);
    expect(line).toMatch(/^\[lancedb-s3\] window=60s requests=3 errors=0 /);
    expect(line).toContain("PutObject:412=1");
    expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain("SK");
  } finally {
    await proxy.close();
    await new Promise<void>((r) => { upstream.close(() => r()); upstream.closeAllConnections(); });
  }
});

it("flags a repeat of a failed request as a suspected retry and reports upstream failures as 502", async () => {
  let calls = 0;
  const upstream = createServer((req, res) => { calls++; req.resume(); res.writeHead(calls === 1 ? 503 : 200); res.end(); });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const stats = new LanceS3Stats();
  const proxy = await startLanceS3Proxy({ endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, region: "us-east-1", credentials: { accessKeyId: "AK", secretAccessKey: "SK" }, stats, logIntervalMs: 0 });
  try {
    expect((await fetch(`${proxy.endpoint}/b/k`)).status).toBe(503);
    expect((await fetch(`${proxy.endpoint}/b/k`)).status).toBe(200);
    expect(stats.cumulative.retries).toBe(1);
    expect(stats.cumulative.errors).toBe(1);
  } finally {
    await proxy.close();
    await new Promise<void>((r) => { upstream.close(() => r()); upstream.closeAllConnections(); });
  }
  const dead = await startLanceS3Proxy({ endpoint: "http://127.0.0.1:1", region: "us-east-1", credentials: { accessKeyId: "AK", secretAccessKey: "SK" }, stats: new LanceS3Stats(), logIntervalMs: 0 });
  try { expect((await fetch(`${dead.endpoint}/b/k`)).status).toBe(502); } finally { await dead.close(); }
});

it("is off unless LANCEDB_S3_TRACE is set and only rewrites s3 roots", async () => {
  const options = { region: "auto", endpoint: "https://x.example", aws_access_key_id: "a", aws_secret_access_key: "b" };
  expect(await withLanceS3Proxy("s3://b/lancedb", options, {})).toBe(options);
  expect(await withLanceS3Proxy("/tmp/lance", options, { LANCEDB_S3_TRACE: "1" })).toBe(options);
  expect(getLanceS3TraceStats().requests).toBeGreaterThanOrEqual(0);
});

it("classifies Lance object keys and range sizes", () => {
  const cls = (op: Parameters<typeof lanceObjectClass>[0], key: string) => lanceObjectClass(op, key);
  expect(cls("ListObjectsV2", "")).toBe("list");
  expect(cls("GetObject", "lancedb/org/t.lance/_versions/18446744073709551610.manifest")).toBe("versions");
  expect(cls("HeadObject", "t.lance/_versions/3.manifest")).toBe("versions");
  expect(cls("GetObject", "t.lance/_latest.manifest")).toBe("latest");
  expect(cls("GetObject", "t.lance/_transactions/0-abc.txn")).toBe("transactions");
  expect(cls("GetObject", "t.lance/_indices/5c1e/index.idx")).toBe("indices");
  expect(cls("GetObject", "t.lance/data/0123abcd.lance")).toBe("data");
  expect(cls("GetObject", "t.lance/_deletions/0-1.arrow")).toBe("deletions");
  expect(cls("GetObject", "somewhere/else.bin")).toBe("other");
  // A table or org literally named "data" or "_versions" must not be mistaken for the Lance directory of that name.
  expect(cls("GetObject", "data/org/t.lance/_versions/1.manifest")).toBe("versions");
  expect(rangeSizeBucket(undefined)).toBe("full");
  expect(rangeSizeBucket("bytes=0-")).toBe("full");
  expect(rangeSizeBucket("bytes=0-4095")).toBe("le4k");
  expect(rangeSizeBucket("bytes=100-65635")).toBe("le64k");
  expect(rangeSizeBucket("bytes=0-1048575")).toBe("le1m");
  expect(rangeSizeBucket("bytes=0-1048576")).toBe("gt1m");
});

it("counts proxied requests per search by object class and flags overlapping searches", async () => {
  spans.length = 0;
  const upstream = createServer((req, res) => { req.resume(); res.writeHead(200, { "content-length": "4" }); res.end("data"); });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const stats = new LanceS3Stats();
  const proxy = await startLanceS3Proxy({ endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, region: "us-east-1", credentials: { accessKeyId: "AK", secretAccessKey: "SK" }, stats, logIntervalMs: 0 });
  try {
    const get = async (path: string, range?: string) => (await fetch(`${proxy.endpoint}/bkt/${path}`, { headers: range ? { range } : {} })).text();
    await get("t.lance/_versions/1.manifest"); // outside any search: not counted
    const first = beginSearchReadScope();
    await fetch(`${proxy.endpoint}/bkt?list-type=2&prefix=t.lance%2F_versions%2F`).then((r) => r.text());
    await get("t.lance/_indices/u/index.idx", "bytes=0-2097151");
    await get("t.lance/data/a.lance", "bytes=0-99");
    const alone = first.end();
    expect(alone).toMatchObject({ requests: 3, bytes: 12, overlapped: false, byClass: { list: 1, indices: 1, data: 1 }, bySize: { full: 1, gt1m: 1, le4k: 1 } });
    expect(alone.requestMs).toBeGreaterThan(0);

    const a = beginSearchReadScope();
    await get("t.lance/data/a.lance", "bytes=0-9");
    const b = beginSearchReadScope(); // overlaps a
    await get("t.lance/_versions/2.manifest");
    const countsA = a.end();
    await get("t.lance/data/b.lance");
    const countsB = b.end();
    expect(countsA).toMatchObject({ requests: 2, overlapped: true, byClass: { data: 1, versions: 1 } });
    expect(countsB).toMatchObject({ requests: 2, overlapped: true, byClass: { versions: 1, data: 1 } });
    expect(b.end()).toEqual(countsB); // idempotent
    await get("t.lance/data/c.lance"); // scopes closed: not counted
    expect(countsB.requests).toBe(2);
    expect(searchReadAttributes(alone)).toMatchObject({ "docslurp.lancedb.s3.requests": 3, "docslurp.lancedb.s3.requests.list": 1, "docslurp.lancedb.s3.requests.indices": 1, "docslurp.lancedb.s3.requests.data": 1, "docslurp.lancedb.s3.range.gt1m": 1, "docslurp.lancedb.s3.overlapped": false });
    expect(searchReadAttributes(alone)).not.toHaveProperty("docslurp.lancedb.s3.requests.versions");
    expect(spans.find((s) => s.attributes["http.request.header.range"] === "bytes=0-2097151")!.attributes["docslurp.lancedb.object_class"]).toBe("indices");
  } finally {
    await proxy.close();
    await new Promise<void>((r) => { upstream.close(() => r()); upstream.closeAllConnections(); });
  }
});

it("puts search request counts on the search span and in the summary line", async () => {
  spans.length = 0;
  const upstream = createServer((req, res) => { req.resume(); res.writeHead(200, { "content-length": "2" }); res.end("ok"); });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const stats = new LanceS3Stats();
  const proxy = await startLanceS3Proxy({ endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, region: "us-east-1", credentials: { accessKeyId: "AK", secretAccessKey: "SK" }, stats, logIntervalMs: 0 });
  try {
    await withLanceSearchSpan("lancedb.search", { "docslurp.dependency.operation": "search" }, async () => {
      await fetch(`${proxy.endpoint}/bkt?list-type=2`).then((r) => r.text());
      await fetch(`${proxy.endpoint}/bkt/t.lance/_indices/u/index.idx`, { headers: { range: "bytes=0-9" } }).then((r) => r.text());
    }, stats);
    await withLanceSearchSpan("lancedb.search", {}, async () => {}, stats); // no proxied requests: nothing recorded
    await expect(withLanceSearchSpan("lancedb.search", {}, async () => { throw new Error("boom"); }, stats)).rejects.toThrow("boom");
    const search = spans.find((s) => s.name === "lancedb.search" && s.attributes["docslurp.lancedb.s3.requests"] !== undefined)!;
    expect(search.attributes).toMatchObject({ "docslurp.lancedb.s3.requests": 2, "docslurp.lancedb.s3.requests.list": 1, "docslurp.lancedb.s3.requests.indices": 1, "docslurp.lancedb.s3.overlapped": false });
    expect(spans.filter((s) => s.name === "lancedb.search")).toHaveLength(3);
    const line = stats.summaryLine(60);
    expect(line).toContain(" searches=1 search_overlapped=0 search_requests=2 search_by_class=");
    expect(line).toMatch(/search_by_class=(list=1,indices=1|indices=1,list=1)$/);
    expect(stats.snapshot()).toMatchObject({ searches: 1, searchRequests: 2, searchByClass: { list: 1, indices: 1 } });
    expect(stats.summaryLine(60)).not.toContain("searches="); // window reset
  } finally {
    await proxy.close();
    await new Promise<void>((r) => { upstream.close(() => r()); upstream.closeAllConnections(); });
  }
});
