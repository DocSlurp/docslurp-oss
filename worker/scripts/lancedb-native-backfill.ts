/**
 * Native-search backfill from a checkout; see src/stages/lancedb-native-backfill-cli.ts.
 * In the worker image run `node worker/dist/stages/lancedb-native-backfill-cli.js` instead.
 *
 *   DATABASE_URL=… LANCEDB_URI=… pnpm --filter @docslurp/worker exec tsx scripts/lancedb-native-backfill.ts \
 *     (--workspace <id> | --org <id> | --all) [--batch-docs 50] [--skip-fts] [--skip-optimize] [--dry-run]
 */
import "../src/stages/lancedb-native-backfill-cli.js";
