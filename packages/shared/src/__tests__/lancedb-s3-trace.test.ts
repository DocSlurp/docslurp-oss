import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskBlockCache } from "../lancedb-s3-cache.js";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { afterAll, expect, it, vi } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { initializeObservability, shutdownObservability } from "../observability.js";
import { LanceS3Stats, beginSearchReadScope, bulkDeleteKeys, classifyS3Request, lanceObjectClass, rangeSizeBucket, searchReadAttributes, withLanceSearchSpan, getLanceS3TraceStats, keyPrefix, signUpstreamRequest, startLanceS3Proxy, withLanceS3Proxy } from "../lancedb-s3-trace.js";

function proxyFetch(proxy: Awaited<ReturnType<typeof startLanceS3Proxy>>, url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { "x-amz-security-token": proxy.credentials.sessionToken!, ...init.headers } });
}

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
    const put = await proxyFetch(proxy, `${proxy.endpoint}/bkt/idx/t.lance/_versions/1.manifest`, { method: "PUT", headers: { "if-none-match": "*" }, body: "payload" });
    expect(put.status).toBe(200);
    const conflict = await proxyFetch(proxy, `${proxy.endpoint}/bkt/idx/t.lance/exists`, { method: "PUT", headers: { "if-none-match": "*" }, body: "x" });
    expect(conflict.status).toBe(412);
    expect(await conflict.text()).toBe("<Error/>");
    const get = await proxyFetch(proxy, `${proxy.endpoint}/bkt/idx/t.lance/data/a.lance`, { headers: { range: "bytes=0-5" } });
    expect(get.status).toBe(206);
    expect(await get.text()).toBe("answer");
    expect(seen[0].body).toBe("payload");
    expect(seen[0].headers["if-none-match"]).toBe("*");
    expect(seen[0].headers.authorization).toMatch(/Credential=AK\//);
    expect(seen[0].headers["x-amz-security-token"]).toBeUndefined();
    expect(JSON.stringify(spans)).not.toContain(proxy.credentials.sessionToken);
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
    expect((await proxyFetch(proxy, `${proxy.endpoint}/b/k`)).status).toBe(503);
    expect((await proxyFetch(proxy, `${proxy.endpoint}/b/k`)).status).toBe(200);
    expect(stats.cumulative.retries).toBe(1);
    expect(stats.cumulative.errors).toBe(1);
  } finally {
    await proxy.close();
    await new Promise<void>((r) => { upstream.close(() => r()); upstream.closeAllConnections(); });
  }
  const dead = await startLanceS3Proxy({ endpoint: "http://127.0.0.1:1", region: "us-east-1", credentials: { accessKeyId: "AK", secretAccessKey: "SK" }, stats: new LanceS3Stats(), logIntervalMs: 0 });
  try { expect((await proxyFetch(dead, `${dead.endpoint}/b/k`)).status).toBe(502); } finally { await dead.close(); }
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
    const get = async (path: string, range?: string) => (await proxyFetch(proxy, `${proxy.endpoint}/bkt/${path}`, { headers: range ? { range } : {} })).text();
    await get("t.lance/_versions/1.manifest"); // outside any search: not counted
    const first = beginSearchReadScope();
    await proxyFetch(proxy, `${proxy.endpoint}/bkt?list-type=2&prefix=t.lance%2F_versions%2F`).then((r) => r.text());
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
      await proxyFetch(proxy, `${proxy.endpoint}/bkt?list-type=2`).then((r) => r.text());
      await proxyFetch(proxy, `${proxy.endpoint}/bkt/t.lance/_indices/u/index.idx`, { headers: { range: "bytes=0-9" } }).then((r) => r.text());
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

it("serves only its own client: no secret, another bucket or root, a dot segment or a foreign copy source is refused before anything is signed", async () => {
  const seen: string[] = [];
  const upstream = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); req.resume(); res.writeHead(200); res.end("ok"); });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const stats = new LanceS3Stats();
  const proxy = await startLanceS3Proxy({ endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, region: "us-east-1", credentials: { accessKeyId: "AK", secretAccessKey: "SK" }, stats, logIntervalMs: 0, roots: ["bkt/idx"] });
  const status = async (url: string, init?: RequestInit) => (await proxyFetch(proxy, url, init)).status;
  try {
    expect(proxy.endpoint).toBe(proxy.address);
    expect(new URL(proxy.endpoint).pathname).toBe("/");
    expect(proxy.endpoint).not.toContain(proxy.credentials.sessionToken);
    // No secret, a wrong one, and a right-length wrong one: all refused, whatever Authorization or Host they carry.
    for (const url of [`${proxy.address}/bkt/idx/k`, `${proxy.address}/nope/bkt/idx/k`, `${proxy.address}/${"0".repeat(64)}/bkt/idx/k`, `${proxy.address}/bkt/idx/k`]) {
      expect((await fetch(url, { headers: { authorization: "AWS4-HMAC-SHA256 Credential=AK/20260101/us-east-1/s3/aws4_request" } })).status, url.replace(proxy.endpoint, "<endpoint>")).toBe(403);
    }
    for (const method of ["PUT", "DELETE"]) expect(await fetch(`${proxy.address}/bkt/idx/k`, { method, body: method === "PUT" ? "x" : undefined }).then((r) => r.status)).toBe(403);
    for (const token of ["wrong", "0".repeat(64)]) {
      expect(await status(`${proxy.endpoint}/bkt/idx/k`, { headers: { "x-amz-security-token": token } })).toBe(403);
    }
    // The right secret, but outside the root: another bucket (also percent-encoded), another prefix, dot segments.
    const outside = ["/other/idx/k", "/%6fther/idx/k", "/bkt/uploads/k", "/bkt/idxx/k", "/bkt/idx/../uploads/k"];
    for (const path of outside) expect(await status(`${proxy.endpoint}${path}`), path).toBe(403);
    // Bucket-level requests: only a listing under the root.
    const bucketLevel: Array<[string, RequestInit?]> = [["/other?list-type=2&prefix=idx%2F"], ["/bkt?list-type=2"], ["/bkt?list-type=2&prefix=uploads%2F"], ["/bkt?list-type=2&prefix=idx%2F..%2Fuploads%2F"], ["/bkt?policy"], ["/bkt?uploads"], ["/bkt", { method: "HEAD" }], ["/bkt?delete", { method: "POST", body: "<Delete/>" }]];
    for (const [path, init] of bucketLevel) expect(await status(`${proxy.endpoint}${path}`, init), path).toBe(403);
    // Copy sources are held to the same roots.
    for (const source of ["/other/idx/secret", "bkt/uploads/secret", "/bkt/idx/../uploads/secret", "arn:aws:s3:::other/idx/secret"]) {
      expect(await status(`${proxy.endpoint}/bkt/idx/k`, { method: "PUT", headers: { "x-amz-copy-source": source } }), source).toBe(403);
    }
    expect(await status(`${proxy.endpoint}/bkt/idx/%zz`)).toBe(400);
    // Dot segments, sent as written (fetch would resolve them first): the store must never be the one to resolve them.
    const raw = (path: string) => new Promise<number>((resolve, reject) => {
      const url = new URL(proxy.endpoint);
      httpRequest({ host: url.hostname, port: url.port, path, method: "GET", headers: { "x-amz-security-token": proxy.credentials.sessionToken! } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); }).on("error", reject).end();
    });
    const dotted = ["/bkt/idx/../uploads/k", "/bkt/idx/%2e%2e/uploads/k", "/bkt/idx/./k", "/bkt/idx/%2E/k", "/bkt/../other/idx/k"];
    for (const path of dotted) expect(await raw(path), path).toBe(403);
    // A bulk delete is held to the roots key by key.
    const bulk = (keys: string[]) => status(`${proxy.endpoint}/bkt?delete`, { method: "POST", body: `<Delete>${keys.map((key) => `<Object><Key>${key}</Key></Object>`).join("")}</Delete>` });
    expect(await bulk(["idx/t.lance/data/a.lance", "uploads/secret.pdf"])).toBe(403);
    expect(await bulk(["idx/../uploads/secret.pdf"])).toBe(403);
    expect(seen).toEqual([]);
    expect(stats.refused).toBe(8 + outside.length + bucketLevel.length + 4 + 1 + dotted.length + 2);
    expect(await bulk(["idx/t.lance/data/a.lance", "idx/t.lance/_indices/u/a&amp;b.idx"])).toBe(200);
    expect(bulkDeleteKeys(Buffer.from("<Delete><Object><Key>a&amp;b/&#x41;&#66;&lt;</Key></Object><Object><Key>c</Key></Object></Delete>"))).toEqual(["a&b/AB<", "c"]);
    seen.length = 0;
    // Its own client, its own root.
    expect(await status(`${proxy.endpoint}/bkt/idx/t.lance/_versions/1.manifest`)).toBe(200);
    expect(await status(`${proxy.endpoint}/bkt?list-type=2&prefix=idx%2Ft.lance%2F`)).toBe(200);
    expect(await status(`${proxy.endpoint}/bkt/idx/k`, { method: "PUT", headers: { "x-amz-copy-source": "/bkt/idx/src?versionId=3" } })).toBe(200);
    proxy.allowRoot("other", "");
    expect(await status(`${proxy.endpoint}/other/anything/k`)).toBe(200);
    expect(seen.map((line) => line.split("?")[0])).toEqual(["GET /bkt/idx/t.lance/_versions/1.manifest", "GET /bkt", "PUT /bkt/idx/k", "GET /other/anything/k"]);
  } finally {
    await proxy.close();
    await new Promise<void>((r) => { upstream.close(() => r()); upstream.closeAllConnections(); });
  }
});

it("stays off behind a forward proxy that would take loopback requests, and drops forward-proxy options", async () => {
  const options = { region: "auto", endpoint: "https://x.example", aws_access_key_id: "a", aws_secret_access_key: "b", proxy_url: "http://egress:3128", AWS_PROXY_URL: "http://egress:3128" };
  const on = { LANCEDB_S3_TRACE: "1" };
  // Read as Lance's client reads it: NO_PROXY wins when set at all, and only a literal 127.0.0.1 excludes loopback.
  for (const env of [
    { HTTP_PROXY: "http://egress:3128" },
    { all_proxy: "socks5://egress:1080", NO_PROXY: "localhost" },
    { HTTP_PROXY: "http://egress:3128", NO_PROXY: "*" },
    { HTTP_PROXY: "http://egress:3128", NO_PROXY: "example.com", no_proxy: "127.0.0.1" },
    { HTTP_PROXY: "http://egress:3128", NO_PROXY: "", no_proxy: "127.0.0.1" },
  ]) expect(await withLanceS3Proxy("s3://b/lancedb", options, { ...on, ...env }), JSON.stringify(env)).toBe(options);
  for (const env of [{ HTTP_PROXY: "http://egress:3128", NO_PROXY: "localhost, 127.0.0.1" }, { http_proxy: "http://egress:3128", no_proxy: "127.0.0.1" }, { HTTPS_PROXY: "http://egress:3128" }]) {
    const routed = await withLanceS3Proxy("s3://b/lancedb", options, { ...on, ...env });
    expect(routed!.endpoint, JSON.stringify(env)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(routed!.aws_endpoint_url_s3).toBe(routed!.endpoint);
    expect(Object.keys(routed!).sort()).toEqual(["allow_http", "aws_access_key_id", "aws_endpoint_url_s3", "aws_secret_access_key", "aws_session_token", "aws_skip_signature", "endpoint", "region", "virtual_hosted_style_request"]);
  }
});

it("sends to the endpoint a direct Lance connection would use, in Lance's order", async () => {
  const listen = async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); req.resume(); res.writeHead(200); res.end(); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { seen, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
  };
  const [a, b] = [await listen(), await listen()];
  const base = { region: "auto", aws_secret_access_key: "s" };
  const on = { LANCEDB_S3_TRACE: "1" };
  let n = 0;
  const reaches = async (options: Record<string, string>, env: Record<string, string>) => {
    a.seen.length = 0; b.seen.length = 0;
    // A fresh key id per case: proxies are shared per upstream and credential set.
    const routed = await withLanceS3Proxy("s3://envbkt/lancedb", { ...base, aws_access_key_id: `case-${n++}`, ...options }, { ...on, ...env });
    expect((await fetch(`${routed!.endpoint}/envbkt/lancedb/k`, { headers: { "x-amz-security-token": routed!.aws_session_token! } })).status).toBe(200);
    expect((await fetch(`${routed!.endpoint}/envbkt/elsewhere/k`, { headers: { "x-amz-security-token": routed!.aws_session_token! } })).status).toBe(403);
    return a.seen.length ? "a" : b.seen.length ? "b" : "none";
  };
  try {
    expect(await reaches({}, { AWS_ENDPOINT_URL_S3: a.url })).toBe("a");
    expect(await reaches({ endpoint: b.url }, { AWS_ENDPOINT_URL_S3: a.url })).toBe("a");
    expect(await reaches({ endpoint: a.url }, { AWS_ENDPOINT: b.url, AWS_ENDPOINT_URL: b.url })).toBe("a");
    expect(await reaches({ endpoint_url: a.url }, { AWS_ENDPOINT_URL: b.url })).toBe("a");
    expect(await reaches({}, { AWS_ENDPOINT: a.url, AWS_ENDPOINT_URL: b.url })).toBe("a");
    expect(await reaches({}, { AWS_ENDPOINT_URL: a.url })).toBe("a");
  } finally {
    await a.close(); await b.close();
  }
});


it("isolates cache bytes and validation leases between upstream credential identities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-credential-cache-"));
  const cache = new DiskBlockCache({ dir, maxBytes: 1_000_000, blockBytes: 4096 });
  const upstream = createServer((req, res) => {
    req.resume();
    if (!req.headers.authorization?.includes("Credential=allowed/")) { res.writeHead(403); res.end(); return; }
    res.writeHead(req.method === "HEAD" ? 200 : 206, { "content-range": "bytes 0-3/4", "content-length": "4", etag: '"e"' });
    res.end(req.method === "HEAD" ? undefined : "data");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const config = { endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, region: "auto", logIntervalMs: 0, cache, roots: ["bkt/org-a"] };
  const allowed = await startLanceS3Proxy({ ...config, credentials: { accessKeyId: "allowed", secretAccessKey: "a" } });
  const denied = await startLanceS3Proxy({ ...config, credentials: { accessKeyId: "revoked", secretAccessKey: "b" } });
  try {
    const key = "/bkt/org-a/t.lance/data/a.lance";
    expect(await (await proxyFetch(allowed, allowed.endpoint + key, { headers: { range: "bytes=0-3" } })).text()).toBe("data");
    const refused = await proxyFetch(denied, denied.endpoint + key, { headers: { range: "bytes=0-3" } });
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain("data");
    // Local auth is per proxy, not a bearer usable against every listener.
    expect((await fetch(denied.endpoint + key, { headers: { "x-amz-security-token": allowed.credentials.sessionToken! } })).status).toBe(403);
  } finally {
    await allowed.close(); await denied.close();
    await new Promise<void>((r) => { upstream.close(() => r()); upstream.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  }
});


it("bounds oversized buffered origin responses before caching them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-oversize-cache-"));
  const cache = new DiskBlockCache({ dir, maxBytes: 1_000_000, blockBytes: 4096, maxSpanBlocks: 1 });
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(206, { "content-range": "bytes 0-8191/8192" });
    res.end(Buffer.alloc(8192));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const proxy = await startLanceS3Proxy({ endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, region: "auto", credentials: { accessKeyId: "AK", secretAccessKey: "SK" }, logIntervalMs: 0, cache });
  try {
    const response = await proxyFetch(proxy, `${proxy.endpoint}/bkt/t.lance/data/a.lance`, { headers: { range: "bytes=0-1" } });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("response too large");
    expect(cache.entries).toBe(0);
  } finally {
    await proxy.close();
    await new Promise<void>((r) => { upstream.close(() => r()); upstream.closeAllConnections(); });
    await rm(dir, { recursive: true, force: true });
  }
});
