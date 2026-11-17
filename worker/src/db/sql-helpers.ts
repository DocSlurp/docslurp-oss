import type { JSONValue, Sql } from "postgres";

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
