import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defaultPipelineFeatures,
  projectStateSchema,
  projectSummaryTreeStateSchema,
  SUMMARY_TREE_CONSTANTS,
  type PipelineFeatures,
} from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The summary tree setting against a migrated Postgres: it changes only through its own service, a deployment with
 * the build switch off refuses to turn it on, and no other project write (a full-form save with a stale value, a
 * create, a clone, a planned change, a write handed a precomputed pipeline) can turn it on.
 */

let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, postgres.PostgresType>>;
let projects: typeof import("../services/projects.js");
let tree: typeof import("../services/project-summary-tree.js");
let configChange: typeof import("../services/config-change.js");
let projectState: typeof import("../services/project-state.js");

const ON = { DOCSLURP_SUMMARY_TREE_BUILD: "on", DOCSLURP_SUMMARY_TREE_SERVE: "on" };
const BUILD_ONLY = { DOCSLURP_SUMMARY_TREE_BUILD: "on" };
const OFF = {};

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  // The PGlite socket serves one connection at a time.
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", () => ({
    signalPipelineCancel: vi.fn(),
    signalPipelinePause: vi.fn(),
    signalPipelineResume: vi.fn(),
    startPipelineWorkflow: vi.fn(),
  }));
  vi.doMock("../services/project-naming.js", () => ({ refineProjectNames: async () => {}, markProjectAutoNamed: async () => {} }));
  projects = await import("../services/projects.js");
  tree = await import("../services/project-summary-tree.js");
  configChange = await import("../services/config-change.js");
  projectState = await import("../services/project-state.js");

  await sql`insert into "user"(id, name, email) values ('owner', 'Owner', 'owner@example.com'), ('stranger', 'Stranger', 'stranger@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('org', 'Org', 'org', 'owner'), ('org2', 'Org 2', 'org2', 'stranger')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('org', 'owner', 'owner'), ('org2', 'stranger', 'owner')`;
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await sql`delete from projects`;
  await sql`delete from document_cleanup_queue`;
  await sql`delete from storage_cleanup_queue`;
  await sql`insert into projects(id, org_id, user_id, name) values ('ws', 'org', 'owner', 'Contracts'), ('ws2', 'org', 'owner', 'Other')`;
});

async function stored(projectId = "ws") {
  const [row] = await sql<{ tree: { enabled: boolean } | null; summarize: boolean | null }[]>`
    select pipeline -> 'summaryTree' as tree, (pipeline ->> 'summarize')::boolean as summarize from projects where id = ${projectId}
  `;
  return row!;
}

const withTree = (enabled: boolean, overrides: Partial<PipelineFeatures> = {}): PipelineFeatures =>
  ({ ...defaultPipelineFeatures, ...overrides, summaryTree: { enabled } });

describe("summary tree setting", () => {
  it("is off for a new project, and its state reports the switches and the read-only constants", async () => {
    const state = await tree.getProjectSummaryTree("ws", "owner", OFF);
    expect(projectSummaryTreeStateSchema.parse(state)).toEqual(state);
    expect(state).toMatchObject({
      enabled: false, buildAvailable: false, serveAvailable: false, searchMode: "off", effectiveSearchMode: "off", status: "off",
      documents: { total: 0, ready: 0, building: 0, partial: 0, skipped: 0, missing: 0 }, nodes: 0,
    });
    expect(state.constants).toEqual(SUMMARY_TREE_CONSTANTS);
    expect(await tree.getProjectSummaryTree("ws", "owner", ON)).toMatchObject({ enabled: false, buildAvailable: true, serveAvailable: true, status: "off" });
  });

  it("refuses to enable while the build switch is off, unset or unknown", async () => {
    for (const env of [OFF, { DOCSLURP_SUMMARY_TREE_BUILD: "off" }, { DOCSLURP_SUMMARY_TREE_BUILD: "maybe" }, { DOCSLURP_SUMMARY_TREE_SERVE: "on" }]) {
      await expect(tree.updateProjectSummaryTree("ws", "owner", { enabled: true }, env))
        .rejects.toMatchObject({ status: 400, code: "summary_tree_unavailable" });
    }
    expect((await stored()).tree ?? { enabled: false }).toEqual({ enabled: false });
    expect((await projects.getProject("ws", "owner"))!.pipeline.summaryTree).toEqual({ enabled: false });
  });

  it("enables through its own endpoint, turns summaries on, and queues nothing", async () => {
    const state = await tree.updateProjectSummaryTree("ws", "owner", { enabled: true }, BUILD_ONLY);
    expect(state).toMatchObject({ enabled: true, buildAvailable: true, serveAvailable: false, status: "ready" });
    expect(await stored()).toEqual({ tree: { enabled: true }, summarize: true });
    expect(await sql`select count(*)::int as count from project_runs`).toEqual([{ count: 0 }]);
    expect(await sql`select count(*)::int as count from document_summary_trees`).toEqual([{ count: 0 }]);
    // The other project is untouched.
    expect((await stored("ws2")).tree ?? { enabled: false }).toEqual({ enabled: false });

    // Turning it off is always allowed, switch or no switch, and leaves summaries as they are.
    expect(await tree.updateProjectSummaryTree("ws", "owner", { enabled: false }, OFF)).toMatchObject({ enabled: false, status: "off" });
    expect(await stored()).toEqual({ tree: { enabled: false }, summarize: true });
  });

  it("a full-form save with a stale true enables nothing", async () => {
    // The form loaded while the tree was on; someone turned it off; the form saves the whole pipeline it loaded.
    await tree.updateProjectSummaryTree("ws", "owner", { enabled: true }, ON);
    await tree.updateProjectSummaryTree("ws", "owner", { enabled: false }, ON);
    await sql`update projects set pipeline = pipeline || '{"summarize": false}'::jsonb where id = 'ws'`;

    const saved = await projects.updateProject("ws", "owner", { name: "Renamed", pipeline: withTree(true, { pageIndex: true }) });
    expect(saved!.name).toBe("Renamed");
    expect(saved!.pipeline.pageIndex).toBe(true);
    expect(saved!.pipeline.summaryTree).toEqual({ enabled: false });
    // Nor does the stale value drag summaries on with it.
    expect(await stored()).toEqual({ tree: { enabled: false }, summarize: false });

    // The planned-change path (settings page, chat proposals) resolves the same pipeline.
    const plan = await configChange.planProjectChange({ projectId: "ws", userId: "owner", input: { pipeline: withTree(true) }, env: ON });
    expect(plan!.nextPipeline.summaryTree).toEqual({ enabled: false });
    const proposed = await configChange.planProjectChange({
      projectId: "ws", userId: "owner", input: {}, env: ON, pipelineOverrides: { summaryTree: { enabled: true }, summarize: false } as never,
    });
    expect(proposed!.nextPipeline.summaryTree).toEqual({ enabled: false });
  });

  it("a write handed a pipeline computed before a switch-off cannot store the stale value", async () => {
    await tree.updateProjectSummaryTree("ws", "owner", { enabled: true }, ON);
    const before = (await projects.getProject("ws", "owner"))!;
    expect(before.pipeline.summaryTree).toEqual({ enabled: true });
    await tree.updateProjectSummaryTree("ws", "owner", { enabled: false }, ON);

    // config-change applies a plan with a precomputed pipeline; the UPDATE itself keeps the row's current value.
    await projects.updateProject("ws", "owner", {}, { precomputed: { current: before, pipeline: before.pipeline } });
    expect((await stored()).tree).toEqual({ enabled: false });
  });

  it("a general save cannot turn a stored tree off either, or turn summaries off under it", async () => {
    await tree.updateProjectSummaryTree("ws", "owner", { enabled: true }, ON);
    const saved = await projects.updateProject("ws", "owner", { pipeline: withTree(false, { summarize: false }), summaries: false });
    expect(saved!.pipeline.summaryTree).toEqual({ enabled: true });
    expect(await stored()).toEqual({ tree: { enabled: true }, summarize: true });
  });

  it("never starts on: create ignores it, and a clone of an enabled project is off", async () => {
    const created = await projects.createProject({ userId: "owner", orgId: "org", name: "New", pipeline: withTree(true), summaries: false });
    expect(created.pipeline.summaryTree).toEqual({ enabled: false });
    expect((await stored(created.id)).tree ?? { enabled: false }).toEqual({ enabled: false });

    await tree.updateProjectSummaryTree("ws", "owner", { enabled: true }, ON);
    const clone = await projects.cloneProject("ws", "owner", "Copy");
    expect(clone.pipeline.summaryTree).toEqual({ enabled: false });
    expect((await stored(clone.id)).tree ?? { enabled: false }).toEqual({ enabled: false });
  });

  it("refuses the tree without embeddings and the vector index", async () => {
    await projects.updateProject("ws", "owner", { pipeline: { ...defaultPipelineFeatures, embed: false, indexVectors: false } });
    await expect(tree.updateProjectSummaryTree("ws", "owner", { enabled: true }, ON))
      .rejects.toMatchObject({ status: 400, code: "summary_tree_requires_vectors" });
    expect((await stored()).tree ?? { enabled: false }).toEqual({ enabled: false });

    // With the tree on, a save that drops embeddings is rejected instead of leaving a tree that cannot build.
    await projects.updateProject("ws", "owner", { pipeline: defaultPipelineFeatures });
    await tree.updateProjectSummaryTree("ws", "owner", { enabled: true }, ON);
    await expect(projects.updateProject("ws", "owner", { pipeline: { ...defaultPipelineFeatures, embed: false, indexVectors: false } }))
      .rejects.toThrow(/summary tree needs embeddings/);
    expect((await projects.getProject("ws", "owner"))!.pipeline).toMatchObject({ embed: true, indexVectors: true, summaryTree: { enabled: true } });
  });

  it("fails loudly under a template that locks document summaries off", async () => {
    await sql`update projects set template_key = 'legal-contracts' where id = 'ws'`;
    await expect(tree.updateProjectSummaryTree("ws", "owner", { enabled: true }, ON))
      .rejects.toMatchObject({ status: 409, code: "summary_tree_summarize_locked" });
    expect((await stored()).tree ?? { enabled: false }).toEqual({ enabled: false });
  });

  it("is not readable or writable by a user outside the project's organization", async () => {
    await expect(tree.getProjectSummaryTree("ws", "stranger", ON)).rejects.toMatchObject({ status: 404 });
    await expect(tree.updateProjectSummaryTree("ws", "stranger", { enabled: true }, ON)).rejects.toMatchObject({ status: 404 });
    expect((await stored()).tree ?? { enabled: false }).toEqual({ enabled: false });
  });
});

describe("summary tree state", () => {
  async function seedDocument(id: string, projectId: string, status = "completed", superseded = false) {
    await sql`
      insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id)
      values (${id}, 'org', 'owner', ${projectId}, null, ${`${id}.pdf`}, 'application/pdf', ${`owner/up/raw/${id}.pdf`}, ${status}, ${`/${id}`})
    `;
    if (superseded) await sql`update documents set superseded_at = now() where id = ${id}`;
  }
  async function seedTree(documentId: string, projectId: string, status: string, readyNodes = 0) {
    await sql`insert into document_summary_trees (document_id, org_id, project_id, status) values (${documentId}, 'org', ${projectId}, ${status})`;
    for (let index = 0; index < readyNodes; index += 1) {
      await sql`insert into document_summary_tree_nodes (id, document_id, org_id, project_id, node_hash, level, status, chunk_start, chunk_end)
        values (${`${documentId}:n${index}`}, ${documentId}, 'org', ${projectId}, ${`h${index}`}, 1, 'ready', ${index}, ${index})`;
    }
  }

  it("counts the project's current documents by tree status, and nothing of another project", async () => {
    for (const id of ["ready1", "ready2", "building", "pending", "partial", "skipped", "missing"]) await seedDocument(id, "ws");
    await seedDocument("old", "ws", "completed", true);
    await seedDocument("queued", "ws", "queued");
    await seedDocument("foreign", "ws2");
    await seedTree("ready1", "ws", "ready", 3);
    await seedTree("ready2", "ws", "ready", 2);
    await seedTree("building", "ws", "building");
    await seedTree("pending", "ws", "pending");
    await seedTree("partial", "ws", "partial", 1);
    await seedTree("skipped", "ws", "skipped");
    await seedTree("old", "ws", "ready", 4);
    await seedTree("foreign", "ws2", "ready", 7);
    await sql`insert into document_summary_tree_nodes (id, document_id, org_id, project_id, node_hash, level, status, chunk_start, chunk_end)
      values ('ready1:pending', 'ready1', 'org', 'ws', 'hp', 2, 'pending', 0, 2)`;

    // Not enabled: the counts are still reported, the status is off.
    expect(await tree.getProjectSummaryTree("ws", "owner", ON)).toMatchObject({
      status: "off", documents: { total: 7, ready: 2, building: 2, partial: 1, skipped: 1, missing: 1 }, nodes: 6,
    });

    await tree.updateProjectSummaryTree("ws", "owner", { enabled: true }, ON);
    expect((await tree.getProjectSummaryTree("ws", "owner", ON)).status).toBe("building");
    await sql`update document_summary_trees set status = 'ready' where document_id in ('building', 'pending')`;
    expect((await tree.getProjectSummaryTree("ws", "owner", ON)).status).toBe("partial");
    await sql`update document_summary_trees set status = 'ready' where document_id = 'partial'`;
    // One document still has no tree state.
    expect((await tree.getProjectSummaryTree("ws", "owner", ON)).status).toBe("partial");
    await seedTree("missing", "ws", "skipped");
    expect(await tree.getProjectSummaryTree("ws", "owner", ON)).toMatchObject({
      status: "ready", documents: { total: 7, ready: 5, building: 0, partial: 0, skipped: 2, missing: 0 },
    });
    expect(await tree.getProjectSummaryTree("ws2", "owner", ON)).toMatchObject({ status: "off", documents: { total: 1, ready: 1 }, nodes: 7 });
  });

  it("runs the stored search mode only with the tree enabled and the serve switch on", async () => {
    await sql`insert into project_search_settings (project_id, user_id, compat_metadata)
      values ('ws', 'owner', ${sql.json({ projectUi: { retrievalDefaults: { summaryTree: "guide" } } })})`;
    expect(await tree.getProjectSummaryTree("ws", "owner", ON)).toMatchObject({ enabled: false, searchMode: "guide", effectiveSearchMode: "off" });
    await tree.updateProjectSummaryTree("ws", "owner", { enabled: true }, ON);
    expect(await tree.getProjectSummaryTree("ws", "owner", ON)).toMatchObject({ searchMode: "guide", effectiveSearchMode: "guide" });
    expect(await tree.getProjectSummaryTree("ws", "owner", BUILD_ONLY)).toMatchObject({ searchMode: "guide", effectiveSearchMode: "off" });
    // An unknown stored value is off.
    await sql`update project_search_settings set compat_metadata = ${sql.json({ projectUi: { retrievalDefaults: { summaryTree: "everything" } } })} where project_id = 'ws'`;
    expect(await tree.getProjectSummaryTree("ws", "owner", ON)).toMatchObject({ searchMode: "off", effectiveSearchMode: "off" });
  });

  it("is part of GET /:projectId/state", async () => {
    const state = await projectState.getProjectState({ projectId: "ws", orgId: "org", recentWindowHours: 24 }, sql as never);
    expect(projectStateSchema.parse(state)).toEqual(state);
    expect(state.summaryTree).toMatchObject({ enabled: false, status: "off", constants: SUMMARY_TREE_CONSTANTS });
  });
});
