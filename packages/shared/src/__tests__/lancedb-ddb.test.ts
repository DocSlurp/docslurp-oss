import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { signDynamoRequest, startLanceDdbProxy, withLanceDdb } from "../lancedb-ddb.js";

describe("withLanceDdb", () => {
  it("passes non-ddb URIs through", async () => {
    expect(await withLanceDdb("s3://b/x", { region: "r" })).toEqual({ uri: "s3://b/x", storageOptions: { region: "r" } });
  });

  it("appends ddbTableName and points Lance at a proxy when separate credentials exist", async () => {
    const config = { ddb: { table: "commits", region: "us-west-1", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" } };
    const out = await withLanceDdb("s3+ddb://b/p/org/vectors", { region: "us-west-004" }, config);
    expect(out.uri).toBe("s3+ddb://b/p/org/vectors?ddbTableName=commits");
    expect(out.storageOptions?.dynamodb_endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(out.storageOptions?.region).toBe("us-west-004");
  });

  it("uses the S3 credentials directly (no proxy) without LANCEDB_DDB_* keys", async () => {
    const out = await withLanceDdb("s3+ddb://b/p", { region: "us-east-1" }, { ddb: { table: "t", region: "us-east-1" } });
    expect(out.storageOptions?.dynamodb_endpoint).toBeUndefined();
  });

  it("requires a table", async () => {
    await expect(withLanceDdb("s3+ddb://b/p", undefined, {})).rejects.toThrow(/DynamoDB table/);
  });
});

describe("signDynamoRequest", () => {
  it("re-signs for the dynamodb service in the DynamoDB region and drops the old signature", async () => {
    const headers = await signDynamoRequest("POST", "/", { authorization: "OLD", "x-amz-date": "x", "x-amz-target": "DynamoDB_20120810.GetItem", "content-type": "application/x-amz-json-1.0" },
      Buffer.from("{}"), { protocol: "https:", hostname: "dynamodb.us-west-1.amazonaws.com", region: "us-west-1" }, { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s" }, new Date("2026-01-02T03:04:05Z"));
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260102\/us-west-1\/dynamodb\/aws4_request/);
    expect(headers.authorization).not.toContain("OLD");
    expect(headers["x-amz-target"]).toBe("DynamoDB_20120810.GetItem");
  });
});

describe("startLanceDdbProxy", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

  it("forwards signed requests upstream and counts operations", async () => {
    const seen: Array<{ auth?: string; target?: string; body: string }> = [];
    const upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { seen.push({ auth: req.headers.authorization, target: String(req.headers["x-amz-target"]), body }); res.writeHead(200, { "content-type": "application/x-amz-json-1.0" }); res.end("{}"); });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
    const proxy = await startLanceDdbProxy({ region: "us-west-1", endpoint: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s" }, logIntervalMs: 0 });
    closers.push(() => proxy.close());
    const res = await fetch(proxy.endpoint, { method: "POST", headers: { "x-amz-target": "DynamoDB_20120810.PutItem", "content-type": "application/x-amz-json-1.0", authorization: "AWS4-HMAC-SHA256 Credential=B2KEY/x" }, body: '{"TableName":"t"}' });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ target: "DynamoDB_20120810.PutItem", body: '{"TableName":"t"}' });
    expect(seen[0].auth).toContain("AKIAEXAMPLE/");
    expect(seen[0].auth).toContain("/us-west-1/dynamodb/");
    expect(proxy.counts).toMatchObject({ total: 1, byOperation: { PutItem: 1 }, byStatus: { "PutItem:200": 1 } });
  });
});
