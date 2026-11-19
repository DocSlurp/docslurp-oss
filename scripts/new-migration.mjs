#!/usr/bin/env node
// Create an empty migration named with the current UTC time: server/db/migrations/YYYYMMDDTHHMM_<name>.sql.
//
//   pnpm db:new add_runs_finished_at
//
// Timestamp names never collide between branches, and there is no journal to edit:
// server/db/migration-runner.mjs applies every file the database has not recorded, in name order.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Pure: the file name for `name` at `now`. Throws on a name that is not snake_case. */
export function migrationFileName(name, now = new Date()) {
  const slug = String(name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!/^[a-z0-9][a-z0-9_]{0,79}$/.test(slug)) throw new Error('Usage: pnpm db:new <snake_case_name> (letters, digits and underscores)');
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  return `${stamp}_${slug}.sql`;
}

export const TEMPLATE = `-- Every migration must be safe to run twice and must keep the previous release working
-- (AGENTS.md, docs/releases.md#schema-changes-expand-and-contract):
--   CREATE TABLE / INDEX / SEQUENCE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, DROP ... IF EXISTS,
--   CREATE OR REPLACE FUNCTION / VIEW, a DO block that checks the catalog before ADD CONSTRAINT,
--   CREATE TYPE, CREATE POLICY or a rename, ON CONFLICT or NOT EXISTS on inserts, guarded backfills.
-- It runs in its own transaction with a bounded lock wait and is retried when the wait times out,
-- so keep it short: one table rewrite or index build per file.
`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const dir = fileURLToPath(new URL('../server/db/migrations/', import.meta.url));
    const path = join(dir, migrationFileName(process.argv[2]));
    if (existsSync(path)) throw new Error(`${path} already exists`);
    writeFileSync(path, TEMPLATE, { flag: 'wx' });
    console.log(path);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
