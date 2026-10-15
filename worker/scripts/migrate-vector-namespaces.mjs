#!/usr/bin/env node
/**
 * Migration helper: create per-org LanceDB tables for existing orgs and copy their data.
 *
 * This is a one-time migration script. It is safe to run multiple times (idempotent).
 *
 * Usage:
 *   node worker/scripts/migrate-vector-namespaces.mjs
 *
 * Env vars:
 *   DATABASE_URL     - Postgres connection string
 *   LANCEDB_URI      - LanceDB root (default: /tmp/docslurp-lancedb); s3:// roots
 *                      inherit endpoint, region and credentials from STORAGE_URI
 */

import { config as loadEnv } from "dotenv";
loadEnv({ quiet: true });

import { createHash } from "node:crypto";

import { resolveLanceDbConfig } from "@docslurp/shared";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://docslurp:docslurp@localhost:5432/docslurp";
const LANCEDB = resolveLanceDbConfig(process.env);

function getTableName(orgId) {
  return `chunks_org_${createHash("sha256").update(orgId.trim()).digest("hex").slice(0, 32)}`;
}

async function main() {
  const sql = postgres(DATABASE_URL, { max: 2, idle_timeout: 30 });

  console.log("[migrate-vector-namespaces] fetching orgs...");
  const orgs = await sql`select id from organizations order by created_at asc`;
  console.log(`[migrate-vector-namespaces] found ${orgs.length} orgs`);

  let lancedb;
  try {
    const mod = await import("lancedb");
    lancedb = mod.default ?? mod;
  } catch (err) {
    console.warn("[migrate-vector-namespaces] lancedb not installed, skipping LanceDB table creation:", err.message);
    await sql.end();
    return;
  }

  const db = await lancedb.connect(
    LANCEDB.root,
    LANCEDB.storageOptions ? { storageOptions: LANCEDB.storageOptions } : undefined,
  );
  const existingTables = await db.tableNames();

  for (const org of orgs) {
    const tableName = getTableName(org.id);

    if (existingTables.includes(tableName)) {
      console.log(`[migrate-vector-namespaces] table ${tableName} already exists, skipping`);
      continue;
    }

    console.log(`[migrate-vector-namespaces] creating table ${tableName} for org ${org.id}...`);
    try {
      // Create the table with a seed record, then delete it
      await db.createTable(tableName, [
        {
          id: "__schema_seed__",
          documentId: "",
          chunkIndex: 0,
          text: "",
          vector: new Array(384).fill(0),
          metadata: {},
        },
      ]);
      const table = await db.openTable(tableName);
      await table.delete("id = '__schema_seed__'");
      console.log(`[migrate-vector-namespaces] created table ${tableName}`);
    } catch (err) {
      console.error(`[migrate-vector-namespaces] failed to create table ${tableName}:`, err.message);
    }
  }

  console.log("[migrate-vector-namespaces] done");
  await sql.end();
}

main().catch((err) => {
  console.error("[migrate-vector-namespaces] fatal:", err);
  process.exitCode = 1;
});
