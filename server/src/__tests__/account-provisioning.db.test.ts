import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { ensureUserAndOrganization } from "../services/account-provisioning.js";

let pool: Pool;
let stop: () => Promise<void>;
beforeAll(async () => {
  const db = await startMigratedPostgres();
  stop = db.stop;
  pool = new Pool({ connectionString: db.url, max: 1 });
}, 60_000);
afterAll(async () => { await pool?.end(); await stop?.(); });

async function user(id: string, name = "Shared Name") {
  await pool.query('insert into "user" (id, name, email) values ($1, $2, $3)', [id, name, `${id}@example.invalid`]);
  return { id, name };
}

describe("personal organization provisioning", () => {
  it("keeps users with matching ID prefixes and names in distinct organizations", async () => {
    const first = await user("prefix-account-one");
    const second = await user("prefix-account-two");
    await ensureUserAndOrganization(pool, first);
    await ensureUserAndOrganization(pool, second);
    const { rows } = await pool.query(`select o.id, o.slug, o.personal_owner_user_id as owner, m.user_id as member, m.role
      from organizations o join org_memberships m on m.org_id = o.id
      where o.personal_owner_user_id = any($1::text[])`, [[first.id, second.id]]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.slug)).size).toBe(2);
    expect(new Set(rows.map(row => row.id)).size).toBe(2);
    for (const row of rows) {
      expect(row.member).toBe(row.owner);
      expect(row.role).toBe("owner");
    }
  });

  it("does not let a pre-existing organization slug block another user's first sign-in", async () => {
    const owner = await user("occupied-owner", "Owner");
    const newcomer = await user("takenx-newcomer", "Common Name");
    await pool.query(`insert into organizations (id, name, slug, created_by_user_id)
      values ('occupied-org', 'Existing', 'common-takenx', $1)`, [owner.id]);
    await pool.query("insert into org_memberships (org_id,user_id,role) values ('occupied-org',$1,'owner')", [owner.id]);
    const before = await pool.query("select o.*, m.user_id, m.role from organizations o join org_memberships m on m.org_id=o.id where o.id='occupied-org'");
    await ensureUserAndOrganization(pool, newcomer);
    const after = await pool.query("select o.*, m.user_id, m.role from organizations o join org_memberships m on m.org_id=o.id where o.id='occupied-org'");
    expect(after.rows).toEqual(before.rows);
    const { rows } = await pool.query("select org_id from org_memberships where user_id=$1", [newcomer.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].org_id).not.toBe("occupied-org");
  });

  it("reuses the same personal organization on repeated provisioning", async () => {
    const identity = await user("repeat-user", "Repeat");
    await ensureUserAndOrganization(pool, identity);
    const before = await pool.query("select id,slug from organizations where personal_owner_user_id=$1", [identity.id]);
    await ensureUserAndOrganization(pool, identity);
    const after = await pool.query("select id,slug from organizations where personal_owner_user_id=$1", [identity.id]);
    expect(before.rows).toHaveLength(1);
    expect(after.rows).toEqual(before.rows);
  });

  it("does not provision an organization for a deleted identity", async () => {
    const identity = await user("deleted-person", "Deleted");
    await pool.query('update "user" set deleted_at=now() where id=$1', [identity.id]);
    await ensureUserAndOrganization(pool, identity);
    const result = await pool.query("select id from organizations where personal_owner_user_id=$1", [identity.id]);
    expect(result.rows).toEqual([]);
  });

  it("treats a hostile display name as data and keeps membership scoped to its identity", async () => {
    const identity = await user("hostile-name", "');DROP TABLE organizations;--");
    await ensureUserAndOrganization(pool, identity);
    const result = await pool.query(`select o.slug, m.user_id from organizations o
      join org_memberships m on m.org_id=o.id where o.personal_owner_user_id=$1`, [identity.id]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].user_id).toBe(identity.id);
    expect(result.rows[0].slug).toMatch(/^[a-z0-9-]+$/);
  });
});
