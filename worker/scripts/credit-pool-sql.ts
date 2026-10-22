import { readFile } from "node:fs/promises";
import type { Sql } from "postgres";

/**
 * Minimal credit schema for the standalone verify-* scripts: the balance
 * column plus the debit functions read verbatim from migration 0068, so the
 * scripts exercise the same SQL the worker calls in production.
 */
export async function installCreditPoolSql(sql: Sql<Record<string, unknown>>): Promise<void> {
  const migration = await readFile(
    new URL("../../server/db/migrations/0068_credit_packs_no_plans.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (/CREATE FUNCTION (append_credit_ledger|debit_org_credits)\(/.test(statement)) {
      await sql.unsafe(statement);
    }
  }
  // Workers append pending debits (migration 0030); flushPending() applies them.
  const pending = await readFile(
    new URL("../../server/db/migrations/0030_pending_credit_debits.sql", import.meta.url),
    "utf8",
  );
  for (const statement of pending.split("--> statement-breakpoint")) {
    if (/CREATE TABLE IF NOT EXISTS credit_debits_pending|CREATE INDEX IF NOT EXISTS credit_debits_pending|CREATE OR REPLACE FUNCTION (enqueue_org_credit_debit|apply_pending_org_debits)\(/.test(statement)) {
      await sql.unsafe(statement);
    }
  }
}

/** Applies every org's pending debits, as the maintenance flusher does. */
export async function flushPendingCreditDebits(sql: Sql<Record<string, unknown>>): Promise<void> {
  for (const { org_id } of await sql<{ org_id: string }[]>`select distinct org_id from credit_debits_pending`) {
    await sql`select * from apply_pending_org_debits(${org_id})`;
  }
}

export const CREDIT_POOL_ORG_COLUMNS =
  "created_by_user_id text";
export const CREDIT_LEDGER_TABLE =
  "create table credit_ledger(id text,user_id text,org_id text,delta numeric(24,12),reason text,metadata jsonb,created_at timestamptz)";
