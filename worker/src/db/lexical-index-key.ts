import type { Sql } from "postgres";

/** Clients that have seen the column. A transaction client is not the pool, so it is checked each time. */
const present = new WeakSet<object>();

/**
 * Whether documents.lexical_index_key exists (migration 20261127T2148). A worker may run against a database that
 * predates it during a rollout; every write of the column is skipped until it appears. Found once, it is cached per client;
 * until then each check is one catalog read.
 */
export async function lexicalIndexKeyColumnPresent(sql: Sql<Record<string, unknown>>): Promise<boolean> {
  if (present.has(sql)) return true;
  const rows = await sql`
    select 1 from information_schema.columns
    where table_schema = current_schema() and table_name = 'documents' and column_name = 'lexical_index_key'
  `;
  if (rows.length === 0) return false;
  present.add(sql);
  return true;
}
