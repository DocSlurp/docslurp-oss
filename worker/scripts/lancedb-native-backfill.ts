/**
 * Prepare existing LanceDB tables for SEARCH_LANCEDB_NATIVE search, without re-embedding:
 * adds the hydration columns, fills them from Postgres, builds the chunk-text FTS index and
 * optimizes the table so the rewritten rows return to the vector index. See
 * src/stages/lancedb-native-backfill.ts for what each step does and its safety notes.
 *
 *   DATABASE_URL=… LANCEDB_URI=… pnpm --filter @docslurp/worker exec tsx scripts/lancedb-native-backfill.ts \
 *     --workspace <workspace id> [--batch-docs 50] [--skip-fts] [--skip-optimize] [--dry-run]
 *
 * Safe to rerun. Read-only on Postgres.
 */
import postgres from "postgres";

import { backfillWorkspaceLanceHydration } from "../src/stages/lancedb-native-backfill.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const workspaceId = arg("workspace");
if (!workspaceId) throw new Error("--workspace <id> is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });
try {
  await backfillWorkspaceLanceHydration({
    sql,
    workspaceId,
    batchDocs: Number(arg("batch-docs") ?? 50),
    dryRun: process.argv.includes("--dry-run"),
    skipFts: process.argv.includes("--skip-fts"),
    skipOptimize: process.argv.includes("--skip-optimize"),
  });
} finally {
  await sql.end({ timeout: 5 });
}
