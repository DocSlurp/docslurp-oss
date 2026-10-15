import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
if (!process.env.DATABASE_URL || !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)) {
  throw new Error('Run this rollback-only integration check against a local database.');
}
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rollback = new Error('expected rollback');
try {
  await sql.begin(async tx => {
    const schema = `cost_test_${randomUUID().replaceAll('-', '')}`;
    await tx.unsafe(`create schema ${schema}; set local search_path to ${schema}`);
    await tx.unsafe(`
      create table usage_events (cost_cents integer not null default 0);
      create table organizations (credit_balance_cents integer not null default 0);
      create table credit_ledger (delta numeric(12,2));
      create table workspace_runs (input_cost_cents integer, output_cost_cents integer, pages_total integer, created_at timestamptz);
      create materialized view admin_stats as select count(*) from workspace_runs;
      insert into organizations values (2000);
    `);
    // Exercise a read on the same connection before and after the column type changes.
    const readBalance = () => tx`select credit_balance_cents from organizations`;
    assert.equal(Number((await readBalance())[0].credit_balance_cents), 2000);
    const migration = await readFile(new URL('../migrations/0013_fractional_usage_costs.sql', import.meta.url), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) await tx.unsafe(statement);
    assert.equal(Number((await readBalance())[0].credit_balance_cents), 2000);
    await tx.unsafe(`
      insert into usage_events select 0.000123456789 from generate_series(1,1000);
      update organizations set credit_balance_cents = credit_balance_cents - (select sum(cost_cents) from usage_events);
      insert into credit_ledger select -sum(cost_cents)/100 from usage_events;
    `);
    const [result] = await tx`select (select sum(cost_cents)::text from usage_events) as cost,
      (select credit_balance_cents::text from organizations) as balance,
      (select delta::text from credit_ledger) as delta`;
    assert.equal(result.cost, '0.123456789000');
    assert.equal(result.balance, '1999.876543211000');
    assert.equal(result.delta, '-0.001234567890');
    await tx.unsafe('create table cost_metadata_test (metadata jsonb)');
    const metadata = { costSource: 'provider', providerCostUsd: 0.00000123456789 };
    await tx`insert into cost_metadata_test values (${JSON.stringify(metadata)}::text::jsonb)`;
    await tx`insert into cost_metadata_test ${tx([{ metadata: tx.json(metadata) }], 'metadata')}`;
    const savedMetadata = await tx`select metadata->>'costSource' as source from cost_metadata_test`;
    assert.deepEqual(savedMetadata.map(row => row.source), ['provider', 'provider']);
    throw rollback;
  });
} catch (error) { if (error !== rollback) throw error; }
finally { await sql.end(); }
console.log('Fractional usage migration, 1000-event aggregation, credit debit, and ledger precision passed (rolled back).');
