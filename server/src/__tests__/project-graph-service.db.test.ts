import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Runs the Project Graph module against a real, migrated Postgres. Opt-in:
 *   TEST_DATABASE_URL=postgres://… (a throwaway database; it is seeded and wiped)
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("project graph service (database)", () => {
  let service: typeof import("../services/project-graph.js");
  let sql: typeof import("../db.js").sql;
  let staleHash = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    ({ sql } = await import("../db.js"));
    service = await import("../services/project-graph.js");
    const shared = await import("@docslurp/shared");

    await sql`delete from graph_jobs`;
    await sql`delete from projects where id in ('ws-graph','sparse-graph','malformed-graph')`;
    await sql`delete from organizations where id = 'org-graph'`;
    await sql`delete from "user" where id = 'user-graph'`;
    await sql`insert into "user"(id, name, email) values ('user-graph', 'Graph Owner', 'graph-owner@example.test')`;
    await sql`insert into organizations(id, name, slug, created_by_user_id) values ('org-graph', 'Graph Org', 'graph-org', 'user-graph')`;
    await sql`insert into org_memberships(org_id, user_id, role) values ('org-graph', 'user-graph', 'owner')`;
    // Match createProject's normalization/template application: a sparse raw row tagged
    // legal-contracts would otherwise resolve as standard/PII-off until the first save.
    const fixturePipeline = shared.applyProjectTemplateLocks(shared.normalizePipelineFeatures({
      ...shared.getProjectTemplate("legal-contracts")!.pipeline,
      graphRag: true, propositionIndex: true,
    }), "legal-contracts");
    // propositionIndex is a non-graph setting the legal-contracts template
    // leaves unlocked; summarize is locked off by the template (strict
    // privacy forbids hosted summaries), so it is seeded as the template has it.
    await sql`
      insert into projects(id, org_id, user_id, name, template_key, pipeline)
      values ('ws-graph', 'org-graph', 'user-graph', 'Contracts', 'legal-contracts',
        ${sql.json(JSON.parse(JSON.stringify(fixturePipeline)))})
    `;
    await sql`
      insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, total_documents, pipeline)
      values ('run-graph', 'org-graph', 'user-graph', 'ws-graph', 'bulk-upload', 'completed', 'completed', 3, ${sql.json(JSON.parse(JSON.stringify(fixturePipeline)))})
    `;
    for (const [index, id] of ["doc-current", "doc-stale", "doc-missing"].entries()) {
      await sql`
        insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status)
        values (${id}, 'org-graph', 'user-graph', 'ws-graph', 'run-graph', ${`${id}.md`}, 'text/markdown', ${`raw/${id}`}, 'completed')
      `;
      await sql`
        insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text)
        values (${`${id}-c0`}, ${id}, 'run-graph', 'user-graph', 0, ${"Acme supplies Globex. ".repeat(500 * (index + 1))})
      `;
    }
    const pipeline = fixturePipeline;
    const currentHash = shared.graphConfigFingerprint(
      pipeline.graph,
      shared.resolvePipelineTextModel(pipeline, "graph-extraction", process.env.DOCSLURP_TEXT_MODEL?.trim() || undefined),
    );
    staleHash = "g1-00000000";
    await sql`
      insert into kg_document_state (document_id, project_id, config_hash, source, windows, input_tokens, output_tokens, duration_ms)
      values ('doc-current', 'ws-graph', ${currentHash}, 'llm', 1, 3000, 500, 4000),
             ('doc-stale', 'ws-graph', ${staleHash}, 'llm', 2, 6000, 900, 9000)
    `;
  });

  afterAll(async () => {
    await sql?.end();
  });

  it("reports coverage and estimates for the project's own scope", async () => {
    const status = await service.getProjectGraphStatus("ws-graph", "user-graph");
    expect(status.enabled).toBe(true);
    expect(status.coverage).toMatchObject({ documents: 3, current: 1, stale: 1, missing: 1 });
    expect(status.estimates.stale.documents).toBe(2);
    expect(status.estimates.full.documents).toBe(3);
    expect(status.estimates.fullByDepth.deep.costCents).toBeGreaterThan(status.estimates.fullByDepth.lean.costCents);
    expect(status.fallbackScope).toMatch(/^Project "Contracts": /);
    expect(status.activeJob).toBeNull();
  });

  it("updates only the graph fields and marks earlier extractions stale", async () => {
    const { getProject } = await import("../services/projects.js");
    const before = (await getProject("ws-graph", "user-graph"))!;
    expect(before.pipeline.privacyMode).toBe("strict-privacy");
    expect(before.pipeline.piiPolicy.enabled).toBe(true);
    const status = await service.updateProjectGraph("ws-graph", "user-graph", { depth: "deep", entityTypes: ["party", "clause"] });
    expect(status.config).toEqual({ domain: null, entityTypes: ["party", "clause"], depth: "deep" });
    expect(status.coverage).toMatchObject({ current: 0, stale: 2, missing: 1 });
    const [project] = await sql<{ pipeline: { summarize: boolean; graphRag: boolean; propositionIndex: boolean } }[]>`
      select pipeline from projects where id = 'ws-graph'
    `;
    expect(project?.pipeline).toMatchObject({ propositionIndex: true, summarize: false, graphRag: true });
    const after = (await getProject("ws-graph", "user-graph"))!;
    expect(after.pipeline.privacyMode).toBe(before.pipeline.privacyMode);
    expect(after.pipeline.piiPolicy).toEqual(before.pipeline.piiPolicy);
    expect(after.pipeline.embedding).toEqual(before.pipeline.embedding);

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
    const status = await service.getProjectGraphStatus("ws-graph", "user-graph");
    expect(status.activeJob?.id).toBe(job.id);

    const cancelled = await service.cancelGraphJob("ws-graph", "user-graph", job.id);
    expect(cancelled).toMatchObject({ status: "cancelled", phase: "done", cancelRequested: true });
  });

  it("refuses to rebuild once the graph is turned off", async () => {
    const status = await service.updateProjectGraph("ws-graph", "user-graph", { enabled: false });
    expect(status.enabled).toBe(false);
    await expect(service.startGraphRebuild("ws-graph", "user-graph", { mode: "full" })).rejects.toMatchObject({ status: 409 });
  });

  it("hides other users' projects", async () => {
    await expect(service.getProjectGraphStatus("ws-graph", "someone-else")).rejects.toMatchObject({ status: 404 });
  });
  it("preserves sparse non-template PII choices during a graph-only update over retained data", async () => {
    const shared = await import("@docslurp/shared");
    const { getProject } = await import("../services/projects.js");
    const sparse = { graphRag: true, propositionIndex: true, piiPolicy: { enabled: true, action: "redact_artifacts", patterns: ["ssn"], allowlistPatterns: ["safe-example"] } };
    await sql`insert into projects(id,org_id,user_id,name,pipeline) values ('sparse-graph','org-graph','user-graph','Sparse',${sql.json(sparse)})`;
    await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline) values ('sparse-run','org-graph','user-graph','sparse-graph','upload','completed','index',${sql.json(sparse)})`;
    await sql`insert into documents(id,org_id,user_id,project_id,run_id,filename,mime_type,source_key,status) values ('sparse-doc','org-graph','user-graph','sparse-graph','sparse-run','synthetic.txt','text/plain','synthetic','completed')`;
    const before = (await getProject("sparse-graph", "user-graph"))!;
    expect(before.pipeline.privacyMode).toBe("standard");
    expect(before.pipeline.piiPolicy).toEqual(shared.normalizePipelineFeatures(sparse as never).piiPolicy);
    await service.updateProjectGraph("sparse-graph", "user-graph", { depth: "deep" });
    const after = (await getProject("sparse-graph", "user-graph"))!;
    expect(after.pipeline.privacyMode).toBe(before.pipeline.privacyMode);
    expect(after.pipeline.piiPolicy).toEqual(before.pipeline.piiPolicy);
    expect(after.pipeline.propositionIndex).toBe(true);
    expect(after.pipeline.graph.depth).toBe("deep");
  });

  it("refuses an implicit locked-template policy change on a malformed retained fixture", async () => {
    const { getProject, resolveUpdatedPipeline } = await import("../services/projects.js");
    const sparse = { graphRag: true, summarize: false, propositionIndex: true };
    await sql`insert into projects(id,org_id,user_id,name,template_key,pipeline) values ('malformed-graph','org-graph','user-graph','Malformed','legal-contracts',${sql.json(sparse)})`;
    await sql`insert into project_runs(id,org_id,user_id,project_id,kind,status,stage,pipeline) values ('malformed-run','org-graph','user-graph','malformed-graph','upload','completed','index',${sql.json(sparse)})`;
    const before = (await getProject("malformed-graph", "user-graph"))!;
    expect(before.pipeline.privacyMode).toBe("standard"); expect(before.pipeline.piiPolicy.enabled).toBe(false);
    const resolved = await resolveUpdatedPipeline(before.id, before, { pipeline: { ...before.pipeline, graph: { ...before.pipeline.graph, depth: "deep" } } });
    expect(resolved.privacyMode).toBe("strict-privacy"); expect(resolved.piiPolicy.enabled).toBe(true);
    await expect(service.updateProjectGraph(before.id, "user-graph", { depth: "deep" })).rejects.toMatchObject({ status: 409, code: "policy_publication_unavailable" });
    expect((await getProject(before.id, "user-graph"))!.pipeline).toEqual(before.pipeline);
  });

});
