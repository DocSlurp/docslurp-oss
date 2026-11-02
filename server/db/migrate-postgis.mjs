import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

/** Call with a dedicated, direct pg connection. Never installs extensions. */
export async function migratePostgis(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock(7142771002)");
    const capability = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'postgis'");
    if (!capability.rowCount) throw new Error("PostGIS migrations require an already installed postgis extension");
    // Ledger DDL is itself migration-owned.
    await client.query(await readFile(new URL("./migrations/postgis/ledger.sql", import.meta.url), "utf8"));
    const journal = JSON.parse(await readFile(new URL("./migrations/postgis/journal.json", import.meta.url), "utf8"));
    for (const name of journal) {
      if (!/^\d{4}_[a-z_]+\.sql$/.test(name)) throw new Error("Invalid PostGIS journal entry");
      const source = await readFile(new URL(`./migrations/postgis/${name}`, import.meta.url), "utf8");
      const digest = createHash("sha256").update(source).digest("hex");
      const applied = await client.query("SELECT digest FROM postgis_migration_ledger WHERE name = $1", [name]);
      if (applied.rowCount) {
        if (applied.rows[0].digest !== digest) throw new Error(`PostGIS migration changed: ${name}`);
        continue;
      }
      await client.query(source);
      await client.query("INSERT INTO postgis_migration_ledger(name,digest) VALUES ($1,$2)", [name, digest]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
