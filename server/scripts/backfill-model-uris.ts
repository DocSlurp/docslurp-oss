/**
 * One-off backfill of the exact model records (migrations 0191/0192) on rows written before them:
 * vector_indexes / document_page_states / document_page_vectors space URIs, usage_events.metadata.modelUri,
 * project_runs.resolved_models and document_page_extracts.model_uri. See services/model-uri-backfill.ts for what each
 * target fills and docs/self-host/operations.md ("Model URI backfill") for the runbook.
 *
 *   pnpm -C server exec tsx scripts/backfill-model-uris.ts [--write] [--target=all|vector-indexes|page-states|
 *     page-vectors|usage-events|runs|page-extracts ...] [--batch-size=2000] [--statement-timeout-ms=30000]
 *     [--lock-timeout-ms=5000]
 *
 * Dry run is the default: it prints per-target counts (would update, unmatched by reason, skipped) and writes nothing.
 * --write applies them, one transaction per batch. Only null fields are filled, so a rerun resumes and a completed
 * backfill reruns with zero updates. Run it with the API's environment (DATABASE_URL and the model-mode settings):
 * the expected vector space is what this deployment's search computes.
 */
import "../src/env.js";

const targetNames = ["all", "vector-indexes", "page-states", "page-vectors", "usage-events", "runs", "page-extracts"] as const;
const usage = `Usage: tsx scripts/backfill-model-uris.ts [--write] [--target=${targetNames.join("|")} ...] [--batch-size=2000] [--statement-timeout-ms=30000] [--lock-timeout-ms=5000]`;
const args = process.argv.slice(2);
const known = new RegExp(`^(--write|--dry-run|--target=(${targetNames.join("|")})|--batch-size=\\d{1,5}|--statement-timeout-ms=\\d{1,7}|--lock-timeout-ms=\\d{1,7})$`);
if (args.some((arg) => !known.test(arg)) || (args.includes("--write") && args.includes("--dry-run"))) {
  console.error(usage);
  process.exit(2);
}
const numberArg = (name: string, fallback: number) => Number(args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const batchSize = numberArg("batch-size", 2000);
if (batchSize < 1 || batchSize > 10_000) {
  console.error(`${usage}\n--batch-size must be 1-10000`);
  process.exit(2);
}
const requested = args.filter((arg) => arg.startsWith("--target=")).map((arg) => arg.slice("--target=".length));

// Import the database only after argument validation.
const { sql } = await import("../src/db.js");
const { backfillModelUris, MODEL_URI_BACKFILL_TARGETS } = await import("../src/services/model-uri-backfill.js");
try {
  const targets = requested.length === 0 || requested.includes("all")
    ? MODEL_URI_BACKFILL_TARGETS
    : MODEL_URI_BACKFILL_TARGETS.filter((target) => requested.includes(target));
  const report = await backfillModelUris(sql, {
    targets,
    write: args.includes("--write"),
    batchSize,
    statementTimeoutMs: numberArg("statement-timeout-ms", 30_000),
    lockTimeoutMs: numberArg("lock-timeout-ms", 5_000),
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await sql.end();
}
