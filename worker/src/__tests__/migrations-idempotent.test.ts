import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, describe, expect, it } from "vitest";

import { applyMigration, readMigrationJournal } from "../test/migrated-db.js";

// Every migration must be safe to run twice in a row: the second run must
// succeed and leave the schema and row counts exactly as the first run left
// them (AGENTS.md; scripts/check-migration-safety.mjs flags the usual causes
// statically). drizzle-kit never re-runs an applied migration on its own, but a
// half-recorded run, a restored journal or a manual re-apply must not break a
// database or apply a backfill twice.

const SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;

/** Sorted lines describing the database's schema objects, grants and row counts. */
async function fingerprint(db: PGlite): Promise<string[]> {
  const lines: string[] = [];
  const add = async (kind: string, sql: string) => {
    for (const row of (await db.query<{ line: string }>(sql)).rows) lines.push(`${kind} ${row.line}`);
  };
  await add("relation", `SELECT n.nspname || '.' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || coalesce(array_to_string(c.reloptions, ','), '') AS line
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMAS} AND c.relkind IN ('r', 'v', 'm', 'S', 'p', 'f')`);
  await add("column", `SELECT c.oid::regclass::text || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' ' || coalesce(a.attacl::text, '') AS line
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE ${SCHEMAS} AND c.relkind IN ('r', 'v', 'm', 'p', 'f') AND a.attnum > 0 AND NOT a.attisdropped`);
  await add("constraint", `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(co.oid) || ' ' || convalidated AS line
    FROM pg_constraint co JOIN pg_namespace n ON n.oid = co.connamespace WHERE ${SCHEMAS}`);
  await add("index", `SELECT schemaname || ' ' || indexdef AS line FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`);
  await add("trigger", `SELECT pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::text AS line
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMAS} AND NOT t.tgisinternal`);
  await add("routine", `SELECT p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text, '') AS line
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${SCHEMAS} AND p.prokind IN ('f', 'p')`);
  await add("view", `SELECT c.oid::regclass::text || ' ' || md5(pg_get_viewdef(c.oid)) AS line
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMAS} AND c.relkind IN ('v', 'm')`);
  await add("type", `SELECT t.oid::regtype::text || ' ' || t.typtype::text || ' ' || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '') AS line
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE ${SCHEMAS} AND t.typtype IN ('e', 'd', 'c') AND (t.typrelid = 0 OR (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c')`);
  await add("policy", `SELECT schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS line FROM pg_policies`);
  await add("extension", `SELECT extname || ' ' || extversion AS line FROM pg_extension`);
  await add("role", `SELECT rolname || ' ' || rolcanlogin AS line FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%'`);
  const tables = (await db.query<{ name: string }>(`SELECT format('%I.%I', n.nspname, c.relname) AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${SCHEMAS} AND c.relkind IN ('r', 'p')`)).rows;
  if (tables.length > 0) {
    await add("rows", tables.map(({ name }) => `SELECT '${name.replace(/'/g, "''")} ' || count(*) AS line FROM ${name}`).join(" UNION ALL "));
  }
  return lines.sort();
}

describe("migrations are idempotent", () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  afterAll(async () => {
    await db.close();
  });

  it("every migration succeeds when run a second time and changes nothing", async () => {
    const problems: string[] = [];
    for (const { tag } of readMigrationJournal()) {
      await applyMigration(db, tag);
      const once = await fingerprint(db);
      try {
        await applyMigration(db, tag);
      } catch (error) {
        problems.push(`${tag}: second run failed: ${(error as Error).message.split("\n")[0]}`);
        continue;
      }
      const twice = await fingerprint(db);
      const onceSet = new Set(once);
      const twiceSet = new Set(twice);
      const changed = [
        ...once.filter((line) => !twiceSet.has(line)).map((line) => `- ${line}`),
        ...twice.filter((line) => !onceSet.has(line)).map((line) => `+ ${line}`),
      ];
      if (changed.length > 0) problems.push(`${tag}: second run changed the database:\n  ${changed.slice(0, 20).join("\n  ")}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  }, 300_000);
});
