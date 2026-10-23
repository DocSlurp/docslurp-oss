import { startDependencySpan } from "@docslurp/shared/observability";

/** Distinguish an absent compatibility table from an unavailable storage backend. */
export function isLanceTableNotFound(error: unknown): boolean {
  return /Table '[^']*' was not found|table .* does not exist/i.test(error instanceof Error ? error.message : String(error));
}

export function lanceOpenFailure(error: unknown): "not_found" | "permission_denied" | "timeout" | "storage_unavailable" | "unknown" {
  if (isLanceTableNotFound(error)) return "not_found";
  const message = error instanceof Error ? error.message : String(error);
  if (/access.?denied|forbidden|unauthorized|permission.?denied|invalidaccesskey|signaturedoesnotmatch/i.test(message)) return "permission_denied";
  if (/timed? ?out|timeout|deadline exceeded/i.test(message)) return "timeout";
  if (/connection refused|connection reset|service unavailable|ECONNRESET|ECONNREFUSED/i.test(message)) return "storage_unavailable";
  return "unknown";
}

/** Record outcome and trusted hashed table name, never storage URLs or native error text. */
export async function openLanceTable<T>(name: string, open: () => Promise<T>): Promise<T> {
  const span = startDependencySpan("lancedb.openTable", {
    "db.system.name": "lancedb",
    "db.collection.name": name,
    "docslurp.dependency.type": "vector",
    "docslurp.dependency.provider": "lancedb",
    "docslurp.dependency.operation": "openTable",
    "docslurp.dependency.phase": "adapter",
  });
  try {
    const table = await span.run(open);
    span.set({ "docslurp.lancedb.open_outcome": "opened" });
    return table;
  } catch (error) {
    const reason = lanceOpenFailure(error);
    span.set({ "docslurp.lancedb.open_outcome": reason });
    // Search deliberately probes exact older layouts. Absence is an observed
    // result, not a failed dependency; genuine storage failures remain errors.
    if (reason !== "not_found") span.end(error);
    throw error;
  } finally {
    span.end();
  }
}
