import { withDependencySpan } from "@docslurp/shared/observability";
import { connect, type Connection } from "@lancedb/lancedb";
import { resolveLanceDbConfig } from "@docslurp/shared";
import { withLanceS3Trace } from "@docslurp/shared/lancedb-s3-trace";

/** Opens a LanceDB connection with object-store options from LANCEDB_URI / STORAGE_URI. */
export async function connectLanceDb(uri: string): Promise<Connection> {
  // LANCEDB_S3_TRACE=1 routes Lance's native S3 requests through the tracing proxy.
  const storageOptions = await withLanceS3Trace(uri, resolveLanceDbConfig().storageOptions);
  return await withDependencySpan("lancedb.connect", { "db.system.name": "lancedb", "docslurp.dependency.type": "vector", "docslurp.dependency.provider": "lancedb", "docslurp.dependency.operation": "connect", "docslurp.dependency.phase": "adapter" }, () => connect(uri, storageOptions ? { storageOptions } : undefined));
}
