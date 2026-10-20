import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { connect, type Connection } from "@lancedb/lancedb";
import { initializeObservability, shutdownObservability } from "@docslurp/shared/observability";
import { lanceS3Stats, startLanceS3Proxy, withLanceS3Proxy, type LanceS3Proxy } from "@docslurp/shared/lancedb-s3-trace";
type ReadableSpan = { name: string; attributes: Record<string, unknown> };
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// Needs an S3 endpoint with conditional writes (MinIO from `pnpm db:up`). Override with LANCEDB_S3_TRACE_TEST_ENDPOINT.
const endpoint = process.env.LANCEDB_S3_TRACE_TEST_ENDPOINT ?? "http://127.0.0.1:9000";
const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "minioadmin", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "minioadmin" };
const reachable = await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

vi.stubEnv("OTEL_ENABLED", "true");
vi.stubEnv("LANGFUSE_ENABLED", "false");
const spans: ReadableSpan[] = [];
initializeObservability({ spanProcessors: [{ onStart() {}, onEnd(span) { spans.push(span); }, async shutdown() {}, async forceFlush() {} }] });

const bucket = `lance-trace-${Date.now()}`;
let proxy: LanceS3Proxy;
let direct: Record<string, string>;
const open = (): Promise<Connection> => connect(`s3://${bucket}/idx`, { storageOptions: { ...direct, endpoint: proxy.endpoint, allow_http: "true", virtual_hosted_style_request: "false" } });

beforeAll(async () => {
  if (!reachable) return;
  const s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  direct = { region: "us-east-1", aws_access_key_id: credentials.accessKeyId, aws_secret_access_key: credentials.secretAccessKey };
  proxy = await startLanceS3Proxy({ endpoint, region: "us-east-1", credentials, logIntervalMs: 0 });
});
afterAll(async () => { await proxy?.close(); await shutdownObservability(); vi.unstubAllEnvs(); });

it.skipIf(!reachable)("withLanceS3Proxy rewrites storage options to the local proxy", async () => {
  const rewritten = await withLanceS3Proxy(`s3://${bucket}/idx`, { ...direct, endpoint }, { LANCEDB_S3_TRACE: "1" });
  expect(rewritten).toMatchObject({ allow_http: "true", virtual_hosted_style_request: "false" });
  expect(rewritten!.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(rewritten!.endpoint).not.toBe(endpoint);
});

it.skipIf(!reachable)("Lance create/add/search work through the proxy and concurrent commits lose nothing", async () => {
  spans.length = 0;
  const before = lanceS3Stats.cumulative.requests;
  const db = await open();
  const dim = 8;
  const row = (id: number) => ({ id, vector: Array.from({ length: dim }, (_, i) => (i === id % dim ? 1 : 0)) });
  const table = await db.createTable("docs", [row(0)], { mode: "overwrite" });
  await table.add([row(1), row(2)]);
  const hits = await table.search(row(1).vector).limit(3).toArray();
  expect(hits.length).toBe(3);
  expect(hits[0].id).toBe(1);

  // Two independent connections (separate writers) racing on the same table.
  const writers = await Promise.all([open(), open(), open()]);
  const tables = await Promise.all(writers.map((w) => w.openTable("docs")));
  const perWriter = 6;
  await Promise.all(tables.map((t, w) => (async () => {
    for (let i = 0; i < perWriter; i++) await t.add([row(100 + w * 100 + i)]);
  })()));
  const fresh = await (await open()).openTable("docs");
  expect(await fresh.countRows()).toBe(3 + writers.length * perWriter);
  const ids = new Set((await fresh.query().select(["id"]).toArray()).map((r) => r.id));
  expect(ids.size).toBe(3 + writers.length * perWriter);

  const traced = spans.filter((s) => s.name.startsWith("lancedb.s3."));
  expect(lanceS3Stats.cumulative.requests - before).toBe(traced.length);
  const operations = new Set(traced.map((s) => s.attributes["docslurp.dependency.operation"]));
  for (const op of ["PutObject", "GetObject", "HeadObject", "ListObjectsV2"]) expect(operations, op).toContain(op);
  expect(traced.every((s) => s.attributes["docslurp.storage.system"] === "lancedb-s3")).toBe(true);
  // The commit protocol's conditional writes reach the store unchanged.
  const conditional = traced.filter((s) => s.attributes["docslurp.s3.condition"]);
  expect(conditional.length).toBeGreaterThan(0);
  expect(traced.some((s) => s.attributes["http.response.status_code"] === 200)).toBe(true);
  console.log(`[lancedb-s3-test] requests=${traced.length} conditional=${conditional.length} conflicts(412)=${conditional.filter((s) => s.attributes["http.response.status_code"] === 412).length}`);
}, 120_000);
