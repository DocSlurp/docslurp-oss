import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "@lancedb/lancedb";
import { withLanceS3Proxy } from "@docslurp/shared/lancedb-s3-trace";
import { afterAll, expect, it, vi } from "vitest";

/**
 * Hosts of S3-compatible stores often export AWS_ENDPOINT_URL_S3. Lance prefers that variable
 * to the `endpoint` storage option, so the proxy (tracing, disk cache) was silently bypassed.
 * No object store needed: two local listeners stand in for the upstream and the variable's target.
 */
const listen = async () => {
  const hits: string[] = [];
  const server = createServer((request, response) => { hits.push(`${request.method} ${request.url}`); response.statusCode = 404; response.end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((resolve) => server.close(resolve)) };
};
const upstream = await listen();
const fromEnv = await listen();
afterAll(async () => { vi.unstubAllEnvs(); await upstream.close(); await fromEnv.close(); });

it("routes Lance through the proxy even when AWS_ENDPOINT_URL_S3 is set", async () => {
  vi.stubEnv("AWS_ENDPOINT_URL_S3", fromEnv.url);
  const direct = { region: "us-east-1", endpoint: upstream.url, allow_http: "true", aws_access_key_id: "test-key", aws_secret_access_key: "test-secret", client_max_retries: "0" };
  const storageOptions = await withLanceS3Proxy("s3://bucket/lancedb/org/project", { ...direct, AWS_ENDPOINT_URL_S3: fromEnv.url }, { LANCEDB_S3_TRACE: "1" });
  expect(storageOptions!.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(storageOptions!.endpoint).not.toBe(upstream.url);
  expect(storageOptions!.aws_endpoint_url_s3).toBe(storageOptions!.endpoint);
  expect(Object.keys(storageOptions!)).not.toContain("AWS_ENDPOINT_URL_S3");
  // The stand-in upstream answers 404, so the open fails; what matters is where the requests went.
  await connect("s3://bucket/lancedb/org/project", { storageOptions }).then((db) => db.openTable("chunks")).catch(() => undefined);
  expect(fromEnv.hits).toEqual([]);
  expect(upstream.hits.length).toBeGreaterThan(0);
}, 30_000);
