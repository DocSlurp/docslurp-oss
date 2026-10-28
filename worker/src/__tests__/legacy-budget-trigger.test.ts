import type { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import { applyRemainingMigrations, createMigratedDatabase } from "../test/migrated-db.js";

/**
 * Migration 0096 drops the run-budget trigger that databases restored from
 * before the migrations-only schema (a40fbea3) still carry from db/init.sql.
 * The definition below is copied verbatim from production app-db (2026-10-28).
 */
const LEGACY_TRIGGER = `
create or replace function enforce_workspace_run_budget()
returns trigger language plpgsql as $$
declare
  workspace_budget integer; workspace_spend integer; org_budget integer; org_spend integer;
begin
  select monthly_budget_cents into workspace_budget from workspaces where id = new.workspace_id;
  if workspace_budget is not null and workspace_budget > 0 then
    select coalesce(sum(ue.cost_cents), 0)::integer into workspace_spend
    from usage_events ue join workspace_runs wr on wr.id = ue.run_id
    where wr.workspace_id = new.workspace_id and ue.created_at >= date_trunc('month', now());
    if workspace_spend >= workspace_budget then
      raise exception using errcode = 'P0001',
        message = format('workspace monthly budget exceeded for workspace %s', new.workspace_id);
    end if;
  end if;
  select monthly_budget_cents into org_budget from organizations where id = new.org_id;
  if org_budget is not null and org_budget > 0 then
    select coalesce(sum(ue.cost_cents), 0)::integer into org_spend
    from usage_events ue join workspace_runs wr on wr.id = ue.run_id
    where wr.org_id = new.org_id and ue.created_at >= date_trunc('month', now());
    if org_spend >= org_budget then
      raise exception using errcode = 'P0001',
        message = format('organization monthly budget exceeded for org %s', new.org_id);
    end if;
  end if;
  return new;
end;
$$;
create trigger workspace_runs_budget_guard before insert on workspace_runs
for each row execute function enforce_workspace_run_budget();
`;

/** A workspace with a 100-cent budget and 150 cents of run-attributed spend this month. */
async function seedOverBudgetWorkspace(db: PGlite): Promise<void> {
  await db.exec(`
    insert into "user" (id, name, email) values ('u1', 'U', 'u1@example.com');
    insert into organizations (id, name, slug, created_by_user_id) values ('o1', 'Org', 'org-1', 'u1');
    insert into workspaces (id, org_id, user_id, name, monthly_budget_cents) values ('w1', 'o1', 'u1', 'W', 100);
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage)
      values ('r1', 'o1', 'u1', 'w1', 'upload', 'completed', 'completed');
    insert into usage_events (id, user_id, run_id, org_id, workspace_id, provider, model, metric, unit, amount, cost_cents)
      values ('e1', 'u1', 'r1', 'o1', 'w1', 'openai', 'm', 'embedding', 'tokens', 1, 150);
  `);
}

/** The reindex path's insert for a budget-blocked change (config-change.ts createReindexRuns). */
const insertBlockedReindexRun = (db: PGlite) =>
  db.exec(`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, blocked_reason, stage)
    values ('r2', 'o1', 'u1', 'w1', 'reindex', 'blocked', 'budget', 'queued')`);

const triggerCount = async (db: PGlite) =>
  (await db.query<{ n: number }>(
    `select count(*)::int as n from pg_trigger where tgname = 'workspace_runs_budget_guard'`,
  )).rows[0]!.n +
  (await db.query<{ n: number }>(
    `select count(*)::int as n from pg_proc where proname = 'enforce_workspace_run_budget'`,
  )).rows[0]!.n;

describe("migration 0096 drop_legacy_budget_trigger", () => {
  it("removes the legacy trigger that rejected budget-blocked reindex runs", async () => {
    const db = await createMigratedDatabase({ stopBefore: "drop_legacy_budget_trigger" });
    await db.exec(LEGACY_TRIGGER);
    await seedOverBudgetWorkspace(db);
    await expect(insertBlockedReindexRun(db)).rejects.toThrow(/workspace monthly budget exceeded/);

    await applyRemainingMigrations(db, "drop_legacy_budget_trigger");

    expect(await triggerCount(db)).toBe(0);
    await insertBlockedReindexRun(db);
    const run = await db.query<{ status: string; blocked_reason: string }>(
      `select status, blocked_reason from workspace_runs where id = 'r2'`,
    );
    expect(run.rows).toEqual([{ status: "blocked", blocked_reason: "budget" }]);
    await db.close();
  }, 120_000);

  it("is a no-op on a database built from the migrations", async () => {
    const db = await createMigratedDatabase();
    expect(await triggerCount(db)).toBe(0);
    await db.close();
  }, 120_000);
});
