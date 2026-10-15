import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Runs the Workspace Graph module against a real, migrated Postgres. Opt-in:
 *   WORKSPACE_GRAPH_TEST_DATABASE_URL=postgres://… (a throwaway database; it is seeded and wiped)
 */
const databaseUrl = process.env.WORKSPACE_GRAPH_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("workspace graph service (database)", () => {
  let service: typeof import("../services/workspace-graph.js");
  let sql: typeof import("../db.js").sql;
  let staleHash = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    ({ sql } = await import("../db.js"));
    service = await import("../services/workspace-graph.js");
    const shared = await import("@docslurp/shared");

    await sql`delete from graph_jobs`;
    await sql`delete from workspaces where id = 'ws-graph'`;
    await sql`delete from organizations where id = 'org-graph'`;
    await sql`delete from "user" where id = 'user-graph'`;
    await sql`insert into "user"(id, name, email) values ('user-graph', 'Graph Owner', 'graph-owner@example.test')`;
    await sql`insert into organizations(id, name, slug, created_by_user_id) values ('org-graph', 'Graph Org', 'graph-org', 'user-graph')`;
    await sql`insert into org_memberships(org_id, user_id, role) values ('org-graph', 'user-graph', 'owner')`;
    await sql`
      insert into workspaces(id, org_id, user_id, name, template_key, pipeline)
      values ('ws-graph', 'org-graph', 'user-graph', 'Contracts', 'legal-contracts',
        ${sql.json({ graphRag: true, summarize: true })})
    `;
    await sql`
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, total_documents, pipeline)
      values ('run-graph', 'org-graph', 'user-graph', 'ws-graph', 'bulk-upload', 'completed', 'completed', 3, '{}'::jsonb)
    `;
    for (const [index, id] of ["doc-current", "doc-stale", "doc-missing"].entries()) {
      await sql`
        insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
        values (${id}, 'org-graph', 'user-graph', 'ws-graph', 'run-graph', ${`${id}.md`}, 'text/markdown', ${`raw/${id}`}, 'completed')
      `;
      await sql`
        insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text)
        values (${`${id}-c0`}, ${id}, 'run-graph', 'user-graph', 0, ${"Acme supplies Globex. ".repeat(500 * (index + 1))})
      `;
    }
    const pipeline = shared.normalizePipelineFeatures({ graphRag: true });
    const currentHash = shared.graphConfigFingerprint(
      pipeline.graph,
      shared.resolvePipelineTextModel(pipeline, "graph-extraction", process.env.DOCSLURP_TEXT_MODEL?.trim() || undefined),
    );
    staleHash = "g1-00000000";
    await sql`
      insert into kg_document_state (document_id, workspace_id, config_hash, source, windows, input_tokens, output_tokens, duration_ms)
      values ('doc-current', 'ws-graph', ${currentHash}, 'llm', 1, 3000, 500, 4000),
             ('doc-stale', 'ws-graph', ${staleHash}, 'llm', 2, 6000, 900, 9000)
    `;
  });

  afterAll(async () => {
    await sql?.end();
  });

  it("reports coverage and estimates for the workspace's own scope", async () => {
    const status = await service.getWorkspaceGraphStatus("ws-graph", "user-graph");
    expect(status.enabled).toBe(true);
    expect(status.coverage).toMatchObject({ documents: 3, current: 1, stale: 1, missing: 1 });
    expect(status.estimates.stale.documents).toBe(2);
    expect(status.estimates.full.documents).toBe(3);
    expect(status.estimates.fullByDepth.deep.costCents).toBeGreaterThan(status.estimates.fullByDepth.lean.costCents);
    expect(status.fallbackScope).toMatch(/^Workspace "Contracts": /);
    expect(status.activeJob).toBeNull();
  });

  it("updates only the graph fields and marks earlier extractions stale", async () => {
    const status = await service.updateWorkspaceGraph("ws-graph", "user-graph", { depth: "deep", entityTypes: ["party", "clause"] });
    expect(status.config).toEqual({ domain: null, entityTypes: ["party", "clause"], depth: "deep" });
    expect(status.coverage).toMatchObject({ current: 0, stale: 2, missing: 1 });
    const [workspace] = await sql<{ pipeline: { summarize: boolean; graphRag: boolean } }[]>`
      select pipeline from workspaces where id = 'ws-graph'
    `;
    expect(workspace?.pipeline).toMatchObject({ summarize: true, graphRag: true });
  });

  it("queues one rebuild at a time with its estimate, and cancels queued jobs at once", async () => {
    const job = await service.startGraphRebuild("ws-graph", "user-graph", { mode: "stale", maxCostCents: 25 });
    expect(job).toMatchObject({ status: "queued", mode: "stale", documentsTotal: 3, maxCostCents: 25 });
    expect(job.estimate?.documents).toBe(3);
    expect(job.etaSeconds).toBe(job.estimate?.seconds);

    await expect(service.startGraphRebuild("ws-graph", "user-graph", { mode: "full" })).rejects.toMatchObject({
      status: 409,
      activeJob: expect.objectContaining({ id: job.id }),
    });
    const status = await service.getWorkspaceGraphStatus("ws-graph", "user-graph");
    expect(status.activeJob?.id).toBe(job.id);

    const cancelled = await service.cancelGraphJob("ws-graph", "user-graph", job.id);
    expect(cancelled).toMatchObject({ status: "cancelled", phase: "done", cancelRequested: true });
  });

  it("refuses to rebuild once the graph is turned off", async () => {
    const status = await service.updateWorkspaceGraph("ws-graph", "user-graph", { enabled: false });
    expect(status.enabled).toBe(false);
    await expect(service.startGraphRebuild("ws-graph", "user-graph", { mode: "full" })).rejects.toMatchObject({ status: 409 });
  });

  it("hides other users' workspaces", async () => {
    await expect(service.getWorkspaceGraphStatus("ws-graph", "someone-else")).rejects.toMatchObject({ status: 404 });
  });
});
