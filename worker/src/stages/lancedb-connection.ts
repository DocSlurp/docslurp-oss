import { withDependencySpan } from "@docslurp/shared/observability";
import { connect, type Connection } from "@lancedb/lancedb";
import { resolveLanceDbConfig } from "@docslurp/shared";
import { withLanceDdb } from "@docslurp/shared/lancedb-ddb";
import { withLanceS3Trace } from "@docslurp/shared/lancedb-s3-trace";

/** Opens a LanceDB connection with object-store options from LANCEDB_URI / STORAGE_URI. */
export async function connectLanceDb(uri: string): Promise<Connection> {
  // LANCEDB_S3_TRACE=1 routes Lance's native S3 requests through the tracing proxy.
  const config = resolveLanceDbConfig();
  const traced = await withLanceS3Trace(uri, config.storageOptions);
  // s3+ddb:// roots commit through DynamoDB; withLanceDdb adds ?ddbTableName= and the credential-splitting proxy.
  const { uri: connectUri, storageOptions } = await withLanceDdb(uri, traced, config);
  return await withDependencySpan("lancedb.connect", { "db.system.name": "lancedb", "docslurp.dependency.type": "vector", "docslurp.dependency.provider": "lancedb", "docslurp.dependency.operation": "connect", "docslurp.dependency.phase": "adapter" }, () => connect(connectUri, storageOptions ? { storageOptions } : undefined));
}
