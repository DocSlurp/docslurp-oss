import { describe, expect, it } from "vitest";
import { applyRemainingMigrations, createMigratedDatabase } from "@docslurp/worker/testing";

/**
 * 0141: search sessions carry a real project_id. Project reads (list, detail,
 * telemetry, suggestions) count and date a project's sessions by it, through
 * (project_id, created_at); the metadata expression index 0087 built for
 * workspaceId (and 0132 only renamed) is gone.
 */
describe("search_sessions.project_id (0141)", () => {
  it("backfills from metadata, cascades with the project and serves project reads from the index", async () => {
    const db = await createMigratedDatabase({ stopBefore: "0142_search_sessions_project_id" });
    try {
      await db.exec(`
        INSERT INTO "user" (id,name,email) VALUES ('ss-user','S','ss@example.test');
        INSERT INTO organizations (id,name,created_by_user_id) VALUES ('ss-org','O','ss-user');
        INSERT INTO projects (id,org_id,user_id,name) VALUES ('ss-a','ss-org','ss-user','A'),('ss-b','ss-org','ss-user','B');
        INSERT INTO search_sessions (id,user_id,query,metadata) VALUES
          ('ss-1','ss-user','q','{"projectId":"ss-a"}'),
          ('ss-2','ss-user','q','{"projectId":"ss-b"}'),
          ('ss-orphan','ss-user','q','{"projectId":"deleted-project"}'),
          ('ss-none','ss-user','q','{}');
      `);
      await applyRemainingMigrations(db, "0142_search_sessions_project_id");

      const rows = await db.query<{ id: string; project_id: string | null }>("SELECT id, project_id FROM search_sessions ORDER BY id");
      expect(rows.rows).toEqual([
        { id: "ss-1", project_id: "ss-a" },
        { id: "ss-2", project_id: "ss-b" },
        { id: "ss-none", project_id: null },
        { id: "ss-orphan", project_id: null },
      ]);
      const indexes = await db.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'search_sessions' ORDER BY indexname",
      );
      const names = indexes.rows.map((row) => row.indexname);
      expect(names).toContain("search_sessions_project_id_created_at_idx");
      expect(names).not.toContain("search_sessions_project_created_idx");
      expect(names).not.toContain("search_sessions_workspace_created_idx");

      // The project-list/getProject subqueries (services/projects.ts). Seq scans off so the plan is
      // deterministic on a tiny table: an unusable index would still show a Seq Scan.
      await db.exec("SET enable_seqscan = off");
      for (const statement of [
        "SELECT count(*)::int FROM search_sessions s WHERE s.project_id = 'ss-a'",
        "SELECT max(s.created_at) FROM search_sessions s WHERE s.project_id = 'ss-a'",
        `SELECT w.id, (SELECT count(*) FROM search_sessions s WHERE s.project_id = w.id) AS n,
           (SELECT max(s.created_at) FROM search_sessions s WHERE s.project_id = w.id) AS last
         FROM projects w WHERE w.id = ANY(ARRAY['ss-a','ss-b'])`,
      ]) {
        const plan = (await db.query<{ "QUERY PLAN": string }>(`EXPLAIN ${statement}`)).rows.map((row) => row["QUERY PLAN"]).join("\n");
        expect(plan).toContain("search_sessions_project_id_created_at_idx");
        expect(plan).not.toMatch(/Seq Scan on search_sessions/);
      }
      await db.exec("RESET enable_seqscan");

      // Deleting a project deletes its search history (and, through it, result rows).
      await db.exec("INSERT INTO search_session_results (id,session_id,chunk_id,rank) VALUES ('ssr-1','ss-1','chunk',1)");
      await db.exec("DELETE FROM projects WHERE id = 'ss-a'");
      expect((await db.query("SELECT id FROM search_sessions WHERE id = 'ss-1'")).rows).toEqual([]);
      expect((await db.query("SELECT id FROM search_session_results WHERE id = 'ssr-1'")).rows).toEqual([]);
      // A session can only name a project that exists.
      await expect(db.exec("INSERT INTO search_sessions (id,user_id,query,project_id) VALUES ('ss-bad','ss-user','q','nope')"))
        .rejects.toThrow(/search_sessions_project_id_fkey/);
    } finally {
      await db.close();
    }
  }, 120_000);
});
