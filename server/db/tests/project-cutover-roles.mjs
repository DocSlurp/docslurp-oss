// Opt-in real-PostgreSQL upgrade check. Use an empty disposable local database
// whose owner is a member of docslurp_realtime_publisher and
// projects_function_owner; provision projects_acl_reader separately.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { migratePostgis } from "../migrate-postgis.mjs";

const raw = process.env.PROJECT_CUTOVER_DATABASE_URL;
if (!raw) throw new Error("PROJECT_CUTOVER_DATABASE_URL is required");
const url = new URL(raw);
if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.startsWith("/projects_")) throw new Error("Use a disposable local projects_* database only");
const source = fileURLToPath(new URL("../migrations/", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "project-cutover-roles-"));
const client = new pg.Client({ connectionString: raw });
await client.connect();
try {
  const journal = JSON.parse(await readFile(join(source, "meta/_journal.json"), "utf8"));
  const stop = journal.entries.findIndex(entry => entry.tag === "0132_projects");
  assert.ok(stop > 0);
  await mkdir(join(scratch, "meta"));
  await writeFile(join(scratch, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, stop) }));
  for (const entry of journal.entries.slice(0, stop)) await copyFile(join(source, `${entry.tag}.sql`), join(scratch, `${entry.tag}.sql`));
  await migrate(drizzle(client), { migrationsFolder: scratch });
  if (process.env.PROJECT_CUTOVER_POSTGIS === "1") await migratePostgis(client);
  await client.query(`
    GRANT USAGE,CREATE ON SCHEMA public TO projects_function_owner;
    ALTER FUNCTION org_spend_status(text,text,numeric) OWNER TO projects_function_owner;
    REVOKE ALL ON FUNCTION org_spend_status(text,text,numeric) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION org_spend_status(text,text,numeric) TO projects_acl_reader WITH GRANT OPTION;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO docslurp_worker;
  `);
  if (process.env.PROJECT_CUTOVER_AUTH === "1") {
    await client.query(`INSERT INTO "user"(id,name,email) VALUES ('cutover-key-user','Cutover key test','cutover-key@example.com');
      INSERT INTO organizations(id,name,created_by_user_id) VALUES ('cutover-org-a','A','cutover-key-user'),('cutover-org-b','B','cutover-key-user');
      INSERT INTO org_memberships(org_id,user_id,role) VALUES ('cutover-org-a','cutover-key-user','owner');
      INSERT INTO workspaces(id,org_id,user_id,name) VALUES ('cutover-a','cutover-org-a','cutover-key-user','A'),('cutover-excluded','cutover-org-a','cutover-key-user','Excluded'),('cutover-foreign','cutover-org-b','cutover-key-user','Foreign');`);
    for (const [id,scope,revoked] of [['manage','workspaces:manage',false],['wrong','search',false],['revoked','workspaces:manage',true]]) {
      const hash=createHash('sha256').update(`dslp_priv_cutover_${id}`).digest('hex');
      await client.query("INSERT INTO api_keys(id,user_id,org_id,key_hash,name,scopes,workspace_ids,revoked_at) VALUES ($1,'cutover-key-user','cutover-org-a',$2,'Upgrade credential',ARRAY[$3],ARRAY['cutover-a'],CASE WHEN $4 THEN now() ELSE NULL END)",[id,hash,scope,revoked]);
    }
  }
  const snapshot = async () => (await client.query(`SELECT p.oid,p.proname,pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.proconfig,
    ARRAY(SELECT format('%s:%s:%s:%s',a.grantor,a.grantee,a.privilege_type,a.is_grantable) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a ORDER BY a.grantor,a.grantee,a.privilege_type) AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    AND p.proname IN ('org_spend_status','realtime_changed') ORDER BY p.proname`)).rows;
  const before = await snapshot();
  assert.equal(before.length, 2);
  if (process.env.PROJECT_CUTOVER_DELEGATED_ACL === "1") {
    await client.query("SET ROLE projects_acl_reader; GRANT EXECUTE ON FUNCTION org_spend_status(text,text,numeric) TO projects_acl_recipient; RESET ROLE");
    const delegated = await snapshot();
    await assert.rejects(migrate(drizzle(client), { migrationsFolder: source }), error => {
      const cause = error.cause ?? error;
      return cause.code === "P0001" && cause.message.startsWith("Projects migration refuses delegated grants on org_spend_status");
    });
    assert.deepEqual(await snapshot(),delegated);
    assert.equal((await client.query("SELECT to_regclass('public.workspaces') IS NOT NULL AS legacy")).rows[0].legacy,true);
    await client.query("SET ROLE projects_acl_reader; REVOKE EXECUTE ON FUNCTION org_spend_status(text,text,numeric) FROM projects_acl_recipient; RESET ROLE");
    console.log("PASS: delegated ACL chain refuses and rolls back without changing owner, grantor, grants or historical schema");
  }
  await migrate(drizzle(client), { migrationsFolder: source });
  if (process.env.PROJECT_CUTOVER_POSTGIS === "1") {
    await migratePostgis(client);
    const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='geo_projection_generations'")).rows.map(row => row.column_name);
    assert.ok(columns.includes('project_id'));
    assert.ok(!columns.includes('workspace_id'));
    const routine = (await client.query("SELECT prosrc FROM pg_proc WHERE proname='publish_accepted_geo_source'")).rows[0].prosrc;
    assert.ok(routine.includes('project_id') && !routine.includes('workspace_id'));
    console.log("PASS: existing PostGIS bootstrap ledger, scope columns and publisher routine upgrade");
  }
  const after = await snapshot();
  for (let index = 0; index < before.length; index++) {
    const old = before[index], next = after[index];
    assert.equal(next.owner, old.owner);
    assert.equal(next.prosecdef, old.prosecdef);
    assert.deepEqual(next.proconfig, old.proconfig);
    assert.deepEqual(next.acl, old.acl);
    if (old.proname === 'realtime_changed') assert.equal(next.oid, old.oid);
  }
  assert.equal((await client.query("SELECT has_function_privilege('docslurp_worker','org_spend_status(text,text,numeric)','execute') AS allowed")).rows[0].allowed, false);
  assert.equal((await client.query("SELECT has_function_privilege('projects_acl_reader','org_spend_status(text,text,numeric)','execute with grant option') AS allowed")).rows[0].allowed, true);
  if (process.env.PROJECT_CUTOVER_AUTH === "1") {
    if (process.env.DATABASE_URL !== raw) throw new Error("DATABASE_URL must identify the same disposable database");
    const { validateApiKey, rotateApiKey } = await import("../../src/services/api-keys.ts");
    const { assertApiKeyScopes, loadApiKeyScopedProject } = await import("../../src/lib/api-key-authorization.ts");
    const { sql } = await import("../../src/db.ts");
    try {
      const valid=await validateApiKey('dslp_priv_cutover_manage');
      assert.ok(valid);
      assert.deepEqual(valid.projectIds,['cutover-a']);
      assertApiKeyScopes(valid,['projects:manage']);
      const refs = Object.fromEntries((await client.query("SELECT id,slug FROM projects WHERE id IN ('cutover-a','cutover-excluded','cutover-foreign')")).rows.map(row=>[row.id,row.slug]));
      assert.ok(await loadApiKeyScopedProject(refs['cutover-a'],valid));
      assert.equal(await loadApiKeyScopedProject(refs['cutover-excluded'],valid),null);
      assert.equal(await loadApiKeyScopedProject(refs['cutover-foreign'],valid),null);
      const wrong=await validateApiKey('dslp_priv_cutover_wrong');
      assert.throws(()=>assertApiKeyScopes(wrong,['projects:manage']));
      assert.equal(await validateApiKey('dslp_priv_cutover_revoked'),null);
      const rotated=await rotateApiKey('manage','cutover-key-user');
      assert.ok(rotated);
      assert.equal(await validateApiKey('dslp_priv_cutover_manage'),null);
      const next=await validateApiKey(rotated.rawKey);
      assert.ok(next);
      assert.deepEqual(next.projectIds,['cutover-a']);
      assertApiKeyScopes(next,['projects:manage']);
      await client.query("DELETE FROM org_memberships WHERE org_id='cutover-org-a' AND user_id='cutover-key-user'");
      assert.equal(await validateApiKey(rotated.rawKey),null);
      console.log("PASS: upgraded live credentials, management scope and rotation; wrong-scope, excluded/foreign project, revoked key and removed membership denied");
    } finally {
      const { flushApiKeyUsage } = await import("../../src/services/api-key-usage.ts");
      await flushApiKeyUsage();
      await sql.end({ timeout: 2 });
    }
  }
  console.log("PASS: nondefault routine owners, ACLs, grant options, SECURITY DEFINER/search_path and default-ACL nonexpansion");
} finally {
  await client.end();
  await rm(scratch, { recursive: true, force: true });
}
