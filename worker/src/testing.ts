// The only worker surface other packages may import (`@docslurp/worker/testing`),
// and only from tests: the server's DB tests run against the migrated Postgres
// harness and exercise worker-owned cleanup and canonical-document code against
// the same schema. Keep this list minimal; production code must not depend on it.
export { applyRemainingMigrations, createMigratedDatabase } from "./test/migrated-db.js";
export { serveOnRandomPort, startMigratedPostgres } from "./test/migrated-postgres.js";
export { drainDocumentCleanupQueue, drainStorageCleanupQueue, type SupersededPurgeOptions } from "./db/superseded-purge.js";
export { legacyEmbeddingLocations, legacyOrgTable } from "./stages/lancedb-legacy-layout.js";
export { buildCanonicalChunksFromDocument } from "./lib/canonical-document.js";
export { buildMediaCanonicalDocument } from "./media/canonical.js";
