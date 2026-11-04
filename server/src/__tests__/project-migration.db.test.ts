import { describe, expect, it } from "vitest";
import { createMigratedDatabase, applyRemainingMigrations } from "../../../worker/src/test/migrated-db.js";

describe("project terminology upgrade", () => {
  it("preserves tenant identity and split spend and denies a foreign project", async () => {
    const db = await createMigratedDatabase({ stopBefore: "0121_projects" });
    try {
      await db.exec(`
        INSERT INTO "user" (id,name,email) VALUES ('rename-user','Rename test','rename@example.com');
        INSERT INTO organizations (id,name,created_by_user_id) VALUES ('rename-org-a','A','rename-user'),('rename-org-b','B','rename-user');
        INSERT INTO workspaces (id,org_id,user_id,name,is_default) VALUES ('rename-a','rename-org-a','rename-user','A',true),('rename-b','rename-org-b','rename-user','B',true);
        INSERT INTO usage_events (id,user_id,org_id,provider,model,metric,amount,unit,cost_cents,input_tokens,metadata)
        VALUES ('rename-spend','rename-user','rename-org-a','test','test','chat',10,'tokens',12,10,'{"workspaceIds":["rename-a","rename-b"],"customer":{"workspaceId":"keep-me"}}');
      `);
      const before = await db.query("SELECT workspace_id AS project_id,org_id,cost_cents,input_tokens FROM usage_attribution WHERE id='rename-spend' ORDER BY org_id");
      await applyRemainingMigrations(db, "0121_projects");
      expect((await db.query("SELECT project_id,org_id,cost_cents,input_tokens FROM usage_attribution WHERE id='rename-spend' ORDER BY org_id")).rows).toEqual(before.rows);
      expect(before.rows).toHaveLength(2);
      expect((await db.query("SELECT id,org_id FROM projects WHERE is_default ORDER BY id")).rows).toEqual([{ id: "rename-a", org_id: "rename-org-a" }, { id: "rename-b", org_id: "rename-org-b" }]);
      const metadata = (await db.query<{ metadata: Record<string, unknown> }>("SELECT metadata FROM usage_events WHERE id='rename-spend'")).rows[0]!.metadata;
      expect(metadata.projectIds).toEqual(["rename-a", "rename-b"]);
      expect(metadata.customer).toEqual({ workspaceId: "keep-me" });
      expect(metadata).not.toHaveProperty("workspaceIds");
      expect((await db.query("SELECT project_in_org FROM org_spend_status('rename-org-a','rename-b',0)")).rows[0]).toEqual({ project_in_org: false });
      expect((await db.query("SELECT project_in_org FROM org_spend_status('rename-org-a','rename-a',0)")).rows[0]).toEqual({ project_in_org: true });
      await db.exec("INSERT INTO projects (id,org_id,user_id,name) VALUES ('rename-new','rename-org-a','rename-user','New')");
      expect((await db.query("SELECT to_regclass('public.workspaces') AS old")).rows).toEqual([{ old: null }]);
    } finally { await db.close(); }
  }, 120_000);
});
