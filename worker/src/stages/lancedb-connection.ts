import { withDependencySpan } from "@docslurp/shared/observability";
import { connect, Session, type Connection } from "@lancedb/lancedb";
import { resolveLanceDbConfig } from "@docslurp/shared";
import { withLanceDdb } from "@docslurp/shared/lancedb-ddb";
import { formatLanceSessionLog, resolveLanceSessionConfig, type LanceSessionConfig } from "@docslurp/shared/lancedb-session";
import { withLanceS3Proxy } from "@docslurp/shared/lancedb-s3-trace";

let shared: { config: LanceSessionConfig; session: Session } | undefined;

/**
 * One Session per worker process, so the metadata cache (file footers, schemas) survives the
 * connect-per-call pattern of the writer, maintenance and purge paths instead of being rebuilt
 * from object storage each time. The worker does not prewarm: it is a different process from the
 * server, so warming here would not populate the cache that answers searches.
 */
export function workerLanceSession(): { config: LanceSessionConfig; session: Session } {
  if (!shared) {
    const config = resolveLanceSessionConfig();
    shared = { config, session: new Session(BigInt(config.indexCacheBytes), BigInt(config.metadataCacheBytes)) };
    console.log(formatLanceSessionLog("created", config));
  }
  return shared;
}

/** Opens a LanceDB connection with object-store options from LANCEDB_URI / STORAGE_URI. */
export async function connectLanceDb(uri: string): Promise<Connection> {
  // LANCEDB_S3_TRACE=1 or LANCEDB_S3_CACHE_DIR routes Lance's native S3 requests through the local proxy (tracing, disk cache).
  const config = resolveLanceDbConfig();
  const traced = await withLanceS3Proxy(uri, config.storageOptions);
  // s3+ddb:// roots commit through DynamoDB; withLanceDdb adds ?ddbTableName= and the credential-splitting proxy.
  const { uri: connectUri, storageOptions } = await withLanceDdb(uri, traced, config);
  return await withDependencySpan("lancedb.connect", { "db.system.name": "lancedb", "docslurp.dependency.type": "vector", "docslurp.dependency.provider": "lancedb", "docslurp.dependency.operation": "connect", "docslurp.dependency.phase": "adapter" }, () => connect(connectUri, storageOptions ? { storageOptions } : undefined, workerLanceSession().session));
}
