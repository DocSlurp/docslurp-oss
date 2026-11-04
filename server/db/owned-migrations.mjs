import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { assertGenerationRollout } from "./generation-rollout.mjs";
import { assertMigrationOwner, reconcileRoleGrants } from "./roles.mjs";
import { migratePostgis } from "./migrate-postgis.mjs";

/** The caller owns the session advisory lock. Never open another connection:
 * the pre-generation barrier must stay closed throughout this operation. */
export async function applyOwnedMigrations(client, { migrationsFolder, env = process.env } = {}) {
  await assertMigrationOwner(client);
  await assertGenerationRollout(client, env);
  const { rows: [identity] } = await client.query(`select current_user as actor,
    session_user as authenticated,
    (select tableowner from pg_tables where schemaname='public' and tablename='documents') as existing_owner,
    pg_get_userbyid(datdba) as database_owner from pg_database where datname=current_database()`);
  if (identity.actor !== identity.authenticated) throw new Error("Migration connection must start without a role override");
  const owner = env.MIGRATION_OWNER_ROLE ?? identity.existing_owner ?? identity.database_owner;
  if (typeof owner !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(owner)) {
    throw new Error("Invalid migration owner identifier");
  }
  if (owner !== (identity.existing_owner ?? identity.database_owner)) {
    throw new Error("Migration owner must match the existing documents owner or fresh database owner");
  }
  const { rows: [role] } = await client.query("select rolsuper,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname=$1", [owner]);
  if (!role) throw new Error("Migration owner does not exist");
  if (owner !== identity.actor && (role.rolsuper || role.rolcreaterole || role.rolreplication || role.rolbypassrls)) {
    throw new Error("Delegated migration owner must not have elevated role attributes");
  }
  try {
    // Identifier allowlist above plus SQL identifier quoting; no URL/PGOPTIONS
    // interpolation and no membership or privilege grants to runtime roles.
    await client.query(`SET ROLE "${owner}"`);
    await assertMigrationOwner(client);
    await migrate(drizzle(client), { migrationsFolder });
    if (env.POSTGIS_MIGRATIONS === "1") await migratePostgis(client);
    await reconcileRoleGrants(client);
  } finally {
    await client.query("RESET ROLE");
  }
}
