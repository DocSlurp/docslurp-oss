import { withDependencySpan } from "@docslurp/shared/observability";
import { connect, type Connection } from "@lancedb/lancedb";
import { resolveLanceDbConfig } from "@docslurp/shared";

/** Opens a LanceDB connection with object-store options from LANCEDB_URI / STORAGE_URI. */
export async function connectLanceDb(uri: string): Promise<Connection> {
  const { storageOptions } = resolveLanceDbConfig();
  return await withDependencySpan("lancedb.connect", { "db.system.name": "lancedb", "docslurp.dependency.type": "vector", "docslurp.dependency.provider": "lancedb", "docslurp.dependency.operation": "connect", "docslurp.dependency.phase": "adapter" }, () => connect(uri, storageOptions ? { storageOptions } : undefined));
}
