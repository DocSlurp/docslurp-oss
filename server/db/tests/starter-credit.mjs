import { readFile } from 'node:fs/promises';
import pg from 'pg';
const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('begin');
  const { rows } = await client.query("select to_regclass('credit_ledger_starter_credit_user_idx') as existing");
  if (!rows[0].existing) {
    await client.query(await readFile(new URL('../migrations/0012_new_account_starter_credit.sql', import.meta.url), 'utf8'));
  }
  await client.query(await readFile(new URL('./starter-credit.sql', import.meta.url), 'utf8'));
  console.log('Starter credit: $2.50 grant, ledger, repeated onboarding, extra organization, and recreation checks passed.');
} finally {
  await client.query('rollback');
  await client.end();
}
