import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let sql: postgres.Sql;
let stop: () => Promise<void>;
let visual: typeof import("../services/visual-candidates.js");

const stats = (charts: number, diagrams: number, pages: number[], exported = 0) => ({ charts, diagrams, pagesWithUnexportedVisuals: pages, exported });

/**
 * Visual candidate stats are read per organization and project. These are the tenant-boundary negatives the security
 * rules require: another organization's project, a project id paired with the wrong organization, and documents
 * whose own org stamp disagrees with the project's, on a migrated database.
 */
describe("project visual candidates", () => {
  beforeAll(async () => {
    const database = await startMigratedPostgres();
    stop = database.stop;
    sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
    vi.doMock("../db.js", () => ({ sql }));
    await sql`insert into "user" (id, name, email) values ('ua', 'A', 'a@visuals.test'), ('ub', 'B', 'b@visuals.test')`;
    await sql`insert into organizations (id, name, slug, created_by_user_id) values ('oa', 'Org A', 'visuals-a', 'ua'), ('ob', 'Org B', 'visuals-b', 'ub')`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('oa', 'ua', 'owner'), ('ob', 'ub', 'owner')`;
    await sql`insert into projects (id, org_id, user_id, name) values ('pa', 'oa', 'ua', 'A'), ('pb', 'ob', 'ub', 'B')`;
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values
      ('ra', 'oa', 'ua', 'pa', 'bulk-upload', 'completed', 'completed', '{}'),
      ('rb', 'ob', 'ub', 'pb', 'bulk-upload', 'completed', 'completed', '{}')`;
    // Stats live on stage rows (what the worker writes). df1 carries forged-looking metadata and no stage row: the
    // metadata is never read.
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, metadata) values
      ('da1', 'oa', 'ua', 'pa', 'ra', 'deck.pdf', 'application/pdf', 'ua/deck.pdf', 'completed', '{}'),
      ('da2', 'oa', 'ua', 'pa', 'ra', 'plain.pdf', 'application/pdf', 'ua/plain.pdf', 'completed', '{}'),
      ('da3', 'oa', 'ua', 'pa', 'ra', 'stage.pdf', 'application/pdf', 'ua/stage.pdf', 'completed', '{}'),
      ('da4', 'oa', 'ua', 'pa', 'ra', 'malformed.pdf', 'application/pdf', 'ua/m.pdf', 'completed', '{}'),
      ('df1', 'oa', 'ua', 'pa', 'ra', 'forged.pdf', 'application/pdf', 'ua/f.pdf', 'completed', ${sql.json({ visualCandidates: stats(99, 0, [1]) })}),
      ('db1', 'ob', 'ub', 'pb', 'rb', 'other.pdf', 'application/pdf', 'ub/other.pdf', 'completed', '{}'),
      ('dx1', 'ob', 'ua', 'pa', 'ra', 'stamped-elsewhere.pdf', 'application/pdf', 'ua/x.pdf', 'completed', '{}')`;
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, stats) values
      ('ra', 'da1', 'vision-extract', 'completed', ${sql.json({ visualCandidates: stats(3, 1, [2, 3]) })}),
      ('ra', 'da3', 'vision-extract', 'completed', ${sql.json({ visualCandidates: stats(2, 0, [7], 1) })}),
      ('ra', 'da4', 'vision-extract', 'completed', ${sql.json({ visualCandidates: { charts: "lots" } })}),
      ('rb', 'db1', 'vision-extract', 'completed', ${sql.json({ visualCandidates: stats(50, 0, [1]) })}),
      ('ra', 'dx1', 'vision-extract', 'completed', ${sql.json({ visualCandidates: stats(9, 0, [1]) })})`;
    await sql`update documents set superseded_at = now() where id = 'da2'`;
    visual = await import("../services/visual-candidates.js");
  }, 120_000);
  afterAll(async () => { await sql?.end(); await stop?.(); });

  it("aggregates stage stats for the caller's project, skips malformed rows and never reads document metadata", async () => {
    const result = await visual.loadProjectVisualCandidates({ orgId: "oa", projectId: "pa" });
    expect(result).toEqual({
      documents: 2, charts: 5, diagrams: 1, exported: 1, unexported: 5, pagesWithUnexportedVisuals: 3,
      documentIds: expect.arrayContaining(["da1", "da3"]),
    });
    expect(result.documentIds).toHaveLength(2);
  });

  it("never reads another organization's project or documents stamped with another organization", async () => {
    // Org A's own read excludes dx1 (stamped ob) and db1 (project pb).
    expect((await visual.loadProjectVisualCandidates({ orgId: "oa", projectId: "pa" })).charts).toBe(5);
    // A project id paired with the wrong organization returns nothing, both ways.
    expect(await visual.loadProjectVisualCandidates({ orgId: "ob", projectId: "pa" })).toEqual(visual.emptyProjectVisualCandidates());
    expect(await visual.loadProjectVisualCandidates({ orgId: "oa", projectId: "pb" })).toEqual(visual.emptyProjectVisualCandidates());
    expect((await visual.loadProjectVisualCandidates({ orgId: "ob", projectId: "pb" })).charts).toBe(50);
  });

  it("sums recorded stats for estimates over the requested documents only, within the caller's scope", async () => {
    const all = await visual.loadVisualStatsForEstimate({ orgId: "oa", projectId: "pa", documentIds: ["da1", "da3", "db1", "dx1", "missing"] });
    // db1 (other project) and dx1 (stamped with another org) are ignored even when named.
    expect(all).toEqual({ documents: 2, charts: 5, diagrams: 1, bySource: {} });
    // Forged metadata on a named document prices nothing.
    expect(await visual.loadVisualStatsForEstimate({ orgId: "oa", projectId: "pa", documentIds: ["df1"] })).toMatchObject({ documents: 0, charts: 0 });
    expect(await visual.loadVisualStatsForEstimate({ orgId: "ob", projectId: "pa", documentIds: ["da1"] })).toMatchObject({ documents: 0 });
    expect(await visual.loadVisualStatsForEstimate({ orgId: "oa", projectId: "pa", documentIds: [] })).toMatchObject({ documents: 0 });
    await expect(visual.loadVisualStatsForEstimate({ orgId: "", projectId: "pa", documentIds: ["da1"] })).rejects.toThrow(/requires orgId/);
  });

  it("caches the chat hint per organization and project", async () => {
    const first = await visual.loadChatVisualCandidates({ orgId: "oa", projectId: "pa" }, 1_000);
    expect(first.charts).toBe(5);
    await sql`update document_run_stage_states set stats = ${sql.json({ visualCandidates: stats(30, 0, [1]) })} where document_id = 'da3'`;
    expect((await visual.loadChatVisualCandidates({ orgId: "oa", projectId: "pa" }, 2_000)).charts).toBe(5);
    // Another scope is never served from this entry; an expired entry is re-read.
    expect(await visual.loadChatVisualCandidates({ orgId: "ob", projectId: "pa" }, 2_000)).toEqual(visual.emptyProjectVisualCandidates());
    expect((await visual.loadChatVisualCandidates({ orgId: "oa", projectId: "pa" }, 1_000 + 6 * 60_000)).charts).toBe(33);
    await sql`update document_run_stage_states set stats = ${sql.json({ visualCandidates: stats(2, 0, [7], 1) })} where document_id = 'da3'`;
  });

  it("refuses an unscoped read instead of widening it", async () => {
    await expect(visual.loadProjectVisualCandidates({ orgId: "", projectId: "pa" })).rejects.toThrow(/requires orgId/);
    await expect(visual.loadProjectVisualCandidates({ orgId: "oa", projectId: "" })).rejects.toThrow(/requires orgId/);
  });
});
