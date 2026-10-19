// Compares Lance on S3 with and without the LANCEDB_S3_TRACE proxy against a local endpoint.
// LANCEDB_S3_TRACE_TEST_ENDPOINT=http://127.0.0.1:9000 pnpm exec tsx scripts/lancedb-s3-trace-bench.ts
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { connect } from "@lancedb/lancedb";
import { startLanceS3Proxy } from "@docslurp/shared/lancedb-s3-trace";

const endpoint = process.env.LANCEDB_S3_TRACE_TEST_ENDPOINT ?? "http://127.0.0.1:9000";
const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "minioadmin", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "minioadmin" };
const bucket = `lance-bench-${Date.now()}`;
await new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials }).send(new CreateBucketCommand({ Bucket: bucket }));
const proxy = await startLanceS3Proxy({ endpoint, region: "us-east-1", credentials, logIntervalMs: 0 });
const base = { region: "us-east-1", aws_access_key_id: credentials.accessKeyId, aws_secret_access_key: credentials.secretAccessKey, allow_http: "true", virtual_hosted_style_request: "false" };
const dim = 256;
const rows = (n: number, offset: number) => Array.from({ length: n }, (_, i) => ({ id: offset + i, vector: Array.from({ length: dim }, (_, d) => Math.sin((offset + i) * (d + 1))) }));
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

async function run(label: string, via: string) {
  const db = await connect(`s3://${bucket}/${label}`, { storageOptions: { ...base, endpoint: via } });
  const t0 = performance.now();
  const table = await db.createTable("t", rows(20000, 0), { mode: "overwrite" });
  const bulk = performance.now() - t0;
  const adds: number[] = [];
  for (let i = 0; i < 30; i++) { const s = performance.now(); await table.add(rows(10, 100000 + i * 10)); adds.push(performance.now() - s); }
  const searches: number[] = [];
  for (let i = 0; i < 150; i++) { const s = performance.now(); await table.search(rows(1, i)[0].vector).limit(10).toArray(); searches.push(performance.now() - s); }
  console.log(`${label.padEnd(7)} bulk_create_20k=${bulk.toFixed(0)}ms add p50=${pct(adds, 0.5).toFixed(0)} p95=${pct(adds, 0.95).toFixed(0)}ms search p50=${pct(searches, 0.5).toFixed(1)} p95=${pct(searches, 0.95).toFixed(1)}ms`);
}
for (let round = 0; round < 2; round++) { await run(`direct${round}`, endpoint); await run(`proxy${round}`, proxy.endpoint); }
console.log(`proxy requests=${proxy.stats.cumulative.requests} avg_proxy_ms=${(proxy.stats.cumulative.totalMs / proxy.stats.cumulative.requests).toFixed(2)} avg_ttfb_ms=${(proxy.stats.cumulative.ttfbMs / proxy.stats.cumulative.requests).toFixed(2)}`);
await proxy.close();
