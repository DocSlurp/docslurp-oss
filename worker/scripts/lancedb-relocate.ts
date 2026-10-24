/**
 * Move org-level LanceDB tables into per-workspace databases from a checkout; see
 * src/stages/lancedb-relocate-cli.ts. In the worker image run
 * `node worker/dist/stages/lancedb-relocate-cli.js` instead.
 *
 *   DATABASE_URL=… LANCEDB_URI=… pnpm --filter @docslurp/worker exec tsx scripts/lancedb-relocate.ts \
 *     (--org <id> | --all) [--batch-rows 2000] [--dry-run] [--skip-maintenance] [--drop-legacy]
 */
import "../src/stages/lancedb-relocate-cli.js";
