/**
 * Live correctness test for Lance's s3+ddb:// commit store: data on an S3-compatible store (for example Backblaze B2),
 * commits coordinated through DynamoDB. Reads credentials from env FILES (parsed as data, never printed):
 *   S3_ENV_FILE  with S3_KEY_VAR / S3_SECRET_VAR / S3_ENDPOINT_VAR names (or *_VALUE overrides) and S3_BUCKET, S3_REGION
 *   DDB_ENV_FILE with DDB_KEY_VAR / DDB_SECRET_VAR, DDB_TABLE, DDB_REGION
 * Phases: create/add/search, then WRITERS x COMMITS concurrent appends. Cleans the test prefix at the end.
 *   pnpm exec tsx scripts/lancedb-ddb-commit-test.ts
 */
import { readFileSync } from "node:fs";
import { ListObjectsV2Command, DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";

function parseEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}
const need = (name: string) => { const v = process.env[name]; if (!v) throw new Error(`${name} required`); return v; };
const s3 = parseEnv(need("S3_ENV_FILE"));
const ddb = parseEnv(need("DDB_ENV_FILE"));
const key = s3[need("S3_KEY_VAR")], secret = s3[need("S3_SECRET_VAR")], endpoint = s3[need("S3_ENDPOINT_VAR")] ?? need("S3_ENDPOINT");
const bucket = need("S3_BUCKET"), region = need("S3_REGION");
const prefix = `${process.env.TEST_PREFIX ?? "ddbtest"}-${Date.now()}`;

process.env.STORAGE_URI = `s3://${encodeURIComponent(key)}:${encodeURIComponent(secret)}@${bucket}?endpoint=${encodeURIComponent(endpoint)}&region=${region}`;
process.env.LANCEDB_URI = `s3+ddb://${bucket}/${prefix}/lancedb`;
process.env.LANCEDB_DDB_TABLE = need("DDB_TABLE");
process.env.LANCEDB_DDB_REGION = need("DDB_REGION");
process.env.LANCEDB_DDB_ACCESS_KEY_ID = ddb[need("DDB_KEY_VAR")];
process.env.LANCEDB_DDB_SECRET_ACCESS_KEY = ddb[need("DDB_SECRET_VAR")];

const WRITERS = Number(process.env.WRITERS ?? 12), COMMITS = Number(process.env.COMMITS ?? 4);
const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };

async function main() {
  const { connectLanceDb } = await import("../src/stages/lancedb-connection.js");
  const { lanceDdbProxyFor } = await import("@docslurp/shared/lancedb-ddb");
  const { resolveLanceDbConfig } = await import("@docslurp/shared");
  const config = resolveLanceDbConfig();
  const root = `${config.root}/orgtest/vectors/m/8`;
  console.log(`root scheme=${root.split(":")[0]} prefix=${prefix} ddbTable=${config.ddb?.table} ddbRegion=${config.ddb?.region}`);
  const row = (id: string, i: number) => ({ id, text: `row ${id}`, vector: Array.from({ length: 8 }, (_, d) => ((i + d) % 7) / 7) });

  // Phase 1: create / add / search
  const db = await connectLanceDb(root);
  const created = performance.now();
  const table = await db.createTable("chunks", [row("seed-0", 0), row("seed-1", 1)]);
  console.log(`create ok ${Math.round(performance.now() - created)}ms`);
  await table.add([row("seed-2", 2)]);
  const hits = await table.search([0, 1 / 7, 2 / 7, 3 / 7, 4 / 7, 5 / 7, 6 / 7, 0]).limit(3).toArray();
  console.log(`search ok hits=${hits.length} rows=${await table.countRows()}`);

  // Phase 2: concurrent writers, each with its own connection
  const latencies: number[] = [];
  let failed = 0;
  const errors = new Map<string, number>();
  const started = performance.now();
  await Promise.all(Array.from({ length: WRITERS }, async (_, w) => {
    const wdb = await connectLanceDb(root);
    const t = await wdb.openTable("chunks");
    for (let c = 0; c < COMMITS; c++) {
      const t0 = performance.now();
      try { await t.add([row(`w${w}-c${c}`, w * 100 + c)]); latencies.push(performance.now() - t0); }
      catch (error) { failed++; const msg = String(error instanceof Error ? error.message : error).slice(0, 160); errors.set(msg, (errors.get(msg) ?? 0) + 1); }
    }
  }));
  const wall = performance.now() - started;
  const verify = await (await connectLanceDb(root)).openTable("chunks");
  const rows = await verify.countRows();
  const expected = 3 + WRITERS * COMMITS - failed;
  const ids = new Set((await verify.query().select(["id"]).toArray()).map((r: { id: string }) => r.id));
  const attempted = WRITERS * COMMITS;
  console.log(JSON.stringify({
    writers: WRITERS, commitsEach: COMMITS, attempted, succeeded: attempted - failed, failed, rowsPresent: rows, rowsExpectedIfNoLoss: expected,
    lostCommits: Math.max(0, expected - rows), distinctIds: ids.size, version: await verify.version(),
    commitLatencyMs: { p50: Math.round(pct(latencies, 0.5)), p95: Math.round(pct(latencies, 0.95)), max: Math.round(Math.max(0, ...latencies)) }, wallMs: Math.round(wall),
    errors: Object.fromEntries(errors),
  }));
  const proxy = config.ddb?.accessKeyId ? await lanceDdbProxyFor(config.ddb) : undefined;
  if (proxy) console.log(JSON.stringify({ dynamoRequests: proxy.counts }));

  // Cleanup: test prefix objects (DynamoDB rows for these base_uris are left; TTL-less, tiny).
  const client = new S3Client({ region, endpoint, forcePathStyle: true, credentials: { accessKeyId: key, secretAccessKey: secret } });
  let deleted = 0, token: string | undefined;
  do {
    const list = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/`, ContinuationToken: token }));
    const objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length) { await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } })); deleted += objects.length; }
    token = list.NextContinuationToken;
  } while (token);
  console.log(`cleanup deleted ${deleted} objects under ${prefix}/`);
  process.exit(0);
}
main().catch((e) => { console.error("FAILED", e instanceof Error ? e.message.replace(/AKIA\w+/g, "***") : e); process.exit(1); });
