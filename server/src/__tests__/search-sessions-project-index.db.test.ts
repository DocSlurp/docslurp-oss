import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { applyRemainingMigrations, createMigratedDatabase, serveOnRandomPort } from "@docslurp/worker/testing";

/**
 * 0142: search sessions carry a real project_id. Project reads (list, detail,
 * telemetry, suggestions) count and date a project's sessions by it, through
 * (project_id, created_at); the metadata expression index 0087 built for
 * workspaceId (and 0132 only renamed) is gone. The migration is schema only:
 * a trigger fills the column for writers that do not set it, and the
 * maintenance sweep fills the sessions that existed before it.
 */
describe("search_sessions.project_id (0142)", () => {
  it("adds the column without touching rows, fills old sessions from the sweep and new ones from the trigger", async () => {
    const db = await createMigratedDatabase({ stopBefore: "0142_search_sessions_project_id" });
    const { server, port } = await serveOnRandomPort(db);
    const sql = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await db.exec(`
        INSERT INTO "user" (id,name,email) VALUES ('ss-user','S','ss@example.test');
        INSERT INTO organizations (id,name,created_by_user_id) VALUES ('ss-org','O','ss-user');
        INSERT INTO projects (id,org_id,user_id,name) VALUES ('ss-a','ss-org','ss-user','A'),('ss-b','ss-org','ss-user','B');
        INSERT INTO search_sessions (id,user_id,query,metadata,created_at) VALUES
          ('ss-1','ss-user','q','{"projectId":"ss-a"}', now() - interval '5 minutes'),
          ('ss-2','ss-user','q','{"projectId":"ss-b"}', now() - interval '4 minutes'),
          ('ss-3','ss-user','q','{"projectId":"ss-a"}', now() - interval '3 minutes'),
          ('ss-3-tie','ss-user','q','{"projectId":"ss-b"}', now() - interval '3 minutes'),
          ('ss-orphan','ss-user','q','{"projectId":"deleted-project"}', now() - interval '2 minutes'),
          ('ss-none','ss-user','q','{}', now() - interval '1 minute');
      `);
      await applyRemainingMigrations(db, "0142_search_sessions_project_id");
      const projectIds = async () =>
        Object.fromEntries((await db.query<{ id: string; project_id: string | null }>("SELECT id, project_id FROM search_sessions"))
          .rows.map((row) => [row.id, row.project_id]));

      // Schema only: the migration updated no row, and the foreign key is valid without a scan.
      expect(await projectIds()).toEqual({ "ss-1": null, "ss-2": null, "ss-3": null, "ss-3-tie": null, "ss-orphan": null, "ss-none": null });
      const [constraint] = (await db.query<{ convalidated: boolean; confdeltype: string }>(
        "SELECT convalidated, confdeltype FROM pg_constraint WHERE conname = 'search_sessions_project_id_fkey'")).rows;
      expect(constraint).toEqual({ convalidated: true, confdeltype: "c" });

      // The sweep fills them in batches, each its own transaction; a capped sweep resumes where it stopped.
      vi.doMock("../db.js", () => ({ sql }));
      const backfill = await import("../services/search-session-project-backfill.js");
      backfill.resetSearchSessionProjectBackfillForTests();
      expect(await backfill.sweepSearchSessionProjectBackfill({ batchSize: 2, maxBatches: 1 })).toBe(2);
      expect(await projectIds()).toMatchObject({ "ss-1": "ss-a", "ss-2": "ss-b", "ss-3": null });
      // Sessions sharing a created_at (one transaction's now()) stay in one page.
      expect(await backfill.sweepSearchSessionProjectBackfill({ batchSize: 1, maxBatches: 1 })).toBe(2);
      expect(await projectIds()).toMatchObject({ "ss-3": "ss-a", "ss-3-tie": "ss-b" });
      expect(await backfill.sweepSearchSessionProjectBackfill({ batchSize: 2 })).toBe(0);
      // A deleted project and a session that names none stay null.
      expect(await projectIds()).toEqual({ "ss-1": "ss-a", "ss-2": "ss-b", "ss-3": "ss-a", "ss-3-tie": "ss-b", "ss-orphan": null, "ss-none": null });
      // Nothing left: the pass is over, later sweeps run no query.
      const queries = vi.spyOn(sql, "begin");
      expect(await backfill.sweepSearchSessionProjectBackfill({ batchSize: 2 })).toBe(0);
      expect(queries).not.toHaveBeenCalled();
      queries.mockRestore();

      // A writer that sets only metadata (the previous release, mid-deploy) still gets the column.
      await db.exec(`INSERT INTO search_sessions (id,user_id,query,metadata) VALUES
        ('ss-old-writer','ss-user','q','{"projectId":"ss-b"}'),
        ('ss-old-missing','ss-user','q','{"projectId":"deleted-project"}'),
        ('ss-old-number','ss-user','q','{"projectId":42}'),
        ('ss-old-nested','ss-user','q','{"projectId":{"id":"ss-a"}}'),
        ('ss-old-array','ss-user','q','["ss-a"]'),
        ('ss-old-string','ss-user','q','"ss-a"'),
        ('ss-old-null','ss-user','q','null')`);
      await db.exec("INSERT INTO search_sessions (id,user_id,query,project_id,metadata) VALUES ('ss-explicit','ss-user','q','ss-a','{\"projectId\":\"ss-b\"}')");
      expect(await projectIds()).toMatchObject({
        "ss-old-writer": "ss-b", "ss-old-missing": null, "ss-old-number": null, "ss-old-nested": null,
        "ss-old-array": null, "ss-old-string": null, "ss-old-null": null,
        // An explicit column value is never overridden by metadata.
        "ss-explicit": "ss-a",
      });
      // Metadata written later fills a still-empty column.
      await db.exec(`UPDATE search_sessions SET metadata = '{"projectId":"ss-a"}' WHERE id = 'ss-none'`);
      expect((await projectIds())["ss-none"]).toBe("ss-a");

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
        // The backfill's page of sessions still without a project.
        `SELECT s.id FROM search_sessions s WHERE s.project_id IS NULL AND s.created_at > '-infinity'::timestamptz
           ORDER BY s.project_id, s.created_at FETCH FIRST 5000 ROWS WITH TIES`,
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
      await sql.end();
      await server.stop();
      await db.close();
    }
  }, 120_000);
});
