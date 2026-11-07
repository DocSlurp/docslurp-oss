import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { applyRemainingMigrations, createMigratedDatabase } from "@docslurp/worker/testing";
import { oneOrgPlanSql } from "../../db/predeploy-check.mjs";

const migration = readFileSync(new URL("../../db/migrations/0127_one_org_per_user.sql", import.meta.url), "utf8");

it.each(["funded_at = now()", "auto_recharge_enabled = true"])("keeps an older funded personal membership ahead of an active free team (%s)", async (funding) => {
  const db = await createMigratedDatabase({ stopBefore: "one_org_per_user" });
  try {
    await db.exec(`
      insert into "user"(id, name, email) values ('retention-user', 'Retention', 'retention@example.test');
      insert into organizations(id, name, slug, created_by_user_id, is_personal, personal_owner_user_id) values
        ('paid-personal', 'Paid personal', 'paid-personal', 'retention-user', true, 'retention-user'),
        ('active-team', 'Active team', 'active-team', 'retention-user', false, null);
      update organizations set ${funding} where id = 'paid-personal';
      insert into org_memberships(org_id, user_id, role, created_at) values
        ('paid-personal', 'retention-user', 'owner', now() - interval '30 days'),
        ('active-team', 'retention-user', 'owner', now());
      insert into workspaces(id, org_id, user_id, name) values
        ('paid-workspace', 'paid-personal', 'retention-user', 'Paid'),
        ('active-workspace', 'active-team', 'retention-user', 'Active');
      insert into workspace_runs(id,workspace_id,user_id,org_id,kind,status,stage,pipeline,created_at) values
        ('recent-run','active-workspace','retention-user','active-team','upload','completed','completed','{}',now());
      insert into api_keys(id,user_id,org_id,key_hash,name) values
        ('paid-key','retention-user','paid-personal','paid-hash','Paid'),
        ('free-key','retention-user','active-team','free-hash','Free');
    `);
    const plan = await db.query(oneOrgPlanSql(migration).plan);
    expect(plan.rows).toEqual([{ org_id: "active-team", user_id: "retention-user", reason: "not_kept" }]);
    await applyRemainingMigrations(db, "one_org_per_user");
    expect((await db.query('select org_id, role from org_memberships')).rows).toEqual([{ org_id: "paid-personal", role: "owner" }]);
    expect((await db.query('select id, revoked_at is null as live from api_keys order by id')).rows).toEqual([
      { id: "free-key", live: false }, { id: "paid-key", live: true },
    ]);
    expect((await db.query("select user_id from projects where id = 'paid-workspace'")).rows).toEqual([{ user_id: "retention-user" }]);
  } finally { await db.close(); }
});
