/**
 * Prepare existing LanceDB tables for native search, without re-embedding: adds the
 * hydration columns, fills them from Postgres, builds the chunk-text FTS index and
 * optimizes each table so the rewritten rows return to the vector index. See
 * src/stages/lancedb-native-backfill.ts for what each step does and its safety notes.
 *
 *   DATABASE_URL=… LANCEDB_URI=… node worker/dist/stages/lancedb-native-backfill-cli.js \
 *     (--workspace <id> | --org <id> | --all) [--batch-docs 50] [--skip-fts] [--skip-optimize] [--dry-run]
 *
 * (compiled into the worker image; from a checkout, `pnpm --filter @docslurp/worker exec tsx
 * scripts/lancedb-native-backfill.ts …` runs the same code).
 *
 * --org and --all cover every workspace database (one per workspace and embedding space)
 * and index/optimize each once.
 * Safe to rerun. Read-only on Postgres. Exits 1 when any table failed.
 */
import postgres from "postgres";

import {
  backfillAllLanceHydration,
  backfillOrgLanceHydration,
  backfillWorkspaceLanceHydration,
  type LanceNativeBackfillTableResult,
} from "./lancedb-native-backfill.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workspaceId = arg("workspace");
const orgId = arg("org");
const all = process.argv.includes("--all");
if ([workspaceId, orgId, all || undefined].filter(Boolean).length !== 1) throw new Error("pass exactly one of --workspace <id>, --org <id> or --all");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });
const options = {
  sql,
  batchDocs: Number(arg("batch-docs") ?? 50),
  dryRun: process.argv.includes("--dry-run"),
  skipFts: process.argv.includes("--skip-fts"),
  skipOptimize: process.argv.includes("--skip-optimize"),
};
let results: LanceNativeBackfillTableResult[] = [];
try {
  results = workspaceId
    ? await backfillWorkspaceLanceHydration({ ...options, workspaceId })
    : orgId
      ? await backfillOrgLanceHydration({ ...options, orgId })
      : await backfillAllLanceHydration(options);
} finally {
  await sql.end({ timeout: 5 });
}
const present = results.filter((result) => !result.skipped);
const failed = present.filter((result) => result.error);
const withoutFts = present.filter((result) => !result.error && !result.ftsPresent);
console.log(`[backfill] done tables=${present.length} chunk_rows=${present.reduce((sum, result) => sum + result.chunkRows, 0)}`
  + ` fts_built=${present.filter((result) => result.ftsBuilt).length} without_fts=${withoutFts.length} failed=${failed.length}`);
for (const result of failed) console.log(`[backfill] FAILED org=${result.orgId} workspace=${result.workspaceId} uri=${result.uri}: ${result.error}`);
if (failed.length > 0) process.exitCode = 1;
