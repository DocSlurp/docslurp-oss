import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { assertMigrationOwner } from "../../server/db/roles.mjs";
const { Client } = createRequire(new URL("../../server/db/migrate.mjs", import.meta.url))("pg");
const host = process.env.GEO_OWNER_SOCKET;
assert.ok(host, "GEO_OWNER_SOCKET is required (disposable database only)");
const admin = new Client({ host, user: "postgres", database: "docslurp" });
const owner = new Client({ host, user: "docslurp", database: "docslurp" });
await admin.connect(); await owner.connect();
try {
  assert.equal(await assertMigrationOwner(owner), "docslurp");
  // Real foreign application objects must still block, even with PostGIS present.
  await admin.query("create table public.foreign_application_table (id integer)");
  await assert.rejects(assertMigrationOwner(owner), /MIGRATION_DATABASE_URL/);
  await admin.query("drop table public.foreign_application_table");
  assert.equal(await assertMigrationOwner(owner), "docslurp");
  // A matching table name without extension membership is not trusted.
  await admin.query("alter extension postgis drop table public.spatial_ref_sys");
  await assert.rejects(assertMigrationOwner(owner), /MIGRATION_DATABASE_URL/);
  await admin.query("alter extension postgis add table public.spatial_ref_sys");
  assert.equal(await assertMigrationOwner(owner), "docslurp");
  await admin.query("create role geo_restricted nologin; grant usage on schema public to geo_restricted");
  await admin.query("set role geo_restricted");
  await assert.rejects(assertMigrationOwner(admin), /MIGRATION_DATABASE_URL/);
  await admin.query("reset role");
  console.log("PASS: extension membership permits owner; foreign tables, name spoofing and restricted roles refuse");
} finally { await owner.end(); await admin.end(); }
