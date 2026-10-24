/**
 * Move existing org-level LanceDB tables into per-workspace databases, without
 * re-embedding. See src/stages/lancedb-relocate.ts for the routing rules and
 * safety notes.
 *
 *   DATABASE_URL=… LANCEDB_URI=… node worker/dist/stages/lancedb-relocate-cli.js \
 *     (--org <id> | --all) [--batch-rows 2000] [--dry-run] [--skip-maintenance] [--drop-legacy]
 *
 * Run once after deploying per-workspace databases: first with --dry-run, then
 * without, verify search, then again with --drop-legacy (idempotent upserts,
 * so the rerun converges and then drops). Exits 1 when any org reported an error.
 */
import postgres from "postgres";

import { relocateAllOrgVectors, relocateOrgVectors, type LanceRelocateResult } from "./lancedb-relocate.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const orgId = arg("org");
const all = process.argv.includes("--all");
if (Boolean(orgId) === all) throw new Error("pass exactly one of --org <id> or --all");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });
const options = {
  sql,
  batchRows: Number(arg("batch-rows") ?? 2_000),
  dryRun: process.argv.includes("--dry-run"),
  skipMaintenance: process.argv.includes("--skip-maintenance"),
  dropLegacy: process.argv.includes("--drop-legacy"),
};
let results: LanceRelocateResult[] = [];
try {
  results = orgId ? [await relocateOrgVectors({ ...options, orgId })] : await relocateAllOrgVectors(options);
} finally {
  await sql.end({ timeout: 5 });
}
const failed = results.filter((result) => result.errors.length > 0);
console.log(`[relocate] done orgs=${results.length} rows=${results.reduce((sum, result) => sum + result.written.reduce((rows, entry) => rows + entry.rows, 0), 0)}`
  + ` orphan_rows=${results.reduce((sum, result) => sum + result.orphanRows, 0)} dropped=${results.reduce((sum, result) => sum + result.droppedLegacy.length, 0)} failed=${failed.length}`);
for (const result of failed) console.log(`[relocate] FAILED org=${result.orgId}: ${result.errors.join("; ")}`);
if (failed.length > 0) process.exitCode = 1;
