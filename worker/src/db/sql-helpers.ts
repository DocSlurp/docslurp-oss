import type { JSONValue, Sql } from "postgres";

const BULK_WRITE_BATCH_SIZE = 1000;

/** Rows in batches of at most 1000 per bulk insert. */
export function batchedRows<T>(rows: T[], batchSize = BULK_WRITE_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    batches.push(rows.slice(index, index + batchSize));
  }
  return batches;
}


/** A JSON parameter as the worker's modules write it: round-tripped through JSON so undefined and class instances drop out. */
export function sqlJson(sql: Sql<Record<string, unknown>>, value: unknown) {
  return sql.json(JSON.parse(JSON.stringify(value ?? {})) as JSONValue);
}

/** The same normalisation as sqlJson, as text for unnest/jsonb casts. */
export function jsonText(value: unknown): string {
  return JSON.stringify(JSON.parse(JSON.stringify(value ?? {})));
}

/**
 * Whether a table exists, cached per process. Optional tables (graph, billing runtime, older migrations) are probed once;
 * the modules of one Store share one instance.
 */
export class TableExistence {
  private readonly cache = new Map<string, boolean>();

  constructor(private readonly sql: Sql<Record<string, unknown>>) {}

  async exists(tableName: string): Promise<boolean> {
    const cached = this.cache.get(tableName);
    if (cached !== undefined) {
      return cached;
    }

    const rows = await this.sql.unsafe<Array<{ exists: boolean }>>(
      "select to_regclass($1) is not null as exists",
      [tableName],
    );
    const exists = rows[0]?.exists ?? false;
    this.cache.set(tableName, exists);
    return exists;
  }
}

/**
 * The value with every string well formed: a lone UTF-16 surrogate becomes U+FFFD, as the text protocol stores it (jsonb
 * rejects `\ud83d`). Arrays and plain objects are copied; other values are returned as they are.
 */
export function wellFormed<T>(value: T): T {
  if (typeof value === "string") return (value as unknown as { toWellFormed(): string }).toWellFormed() as T;
  if (Array.isArray(value)) return value.map((item) => wellFormed(item)) as T;
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [wellFormed(key), wellFormed(item)])) as T;
  }
  return value;
}

/**
 * Rows as one JSON text for a `${text}::text::jsonb` parameter (a text parameter: a jsonb one would be serialised again) (jsonb_to_recordset): strings made well formed, serialised once.
 * Undefined fields drop out, as JSON does.
 */
export function jsonRowsText(rows: readonly unknown[]): string {
  return JSON.stringify(wellFormed(rows));
}
