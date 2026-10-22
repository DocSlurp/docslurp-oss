import { defaultPipelineFeatures, estimatePageEmbedCredits, pipelineVersionFeatures, setPrivateModelEndpointRegistryForTests } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/** Indexing-mode API against a database built from db/migrations. */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
const queryLog: string[] = [];
let svc: typeof import("../services/workspace-indexing-mode.js");
let ws: typeof import("../services/workspaces.js");
let intake: typeof import("../services/workspace-intake.js");
let creation: typeof import("../services/run-creation.js");

const actor = { type: "session", userId: "u1", sessionId: "s", user: { id: "u1", email: "a@x", name: "A" } } as never;
const serverPolicy = { maxPagesPerQuery: 40, maxCreditsPerQuery: 25, deadlineMs: 20000, allowFullIndexRequest: true, allowAgentDiscovery: true, mapRouter: "always" as const };

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    debug: (_conn: number, query: string) => { queryLog.push(query); },
    types: { numeric: { to: 1700, from: [1700], serialize: (v: unknown) => String(v), parse: (v: string): unknown => Number(v) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/source-metadata.js", () => ({ resolveSourceMetadata: async () => ({ pageCount: 1, sourceSha256: null }) }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  // free: starter credits only; gold and funded: funded (a paid grant set funded_at, migration 0068).
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('free', 'Free', 'free', 'u1', 0)`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents, funded_at) values ('gold', 'Gold', 'gold', 'u1', 1000, now())`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents, funded_at) values ('funded', 'Funded', 'funded', 'u1', 1000, now())`;
  for (const org of ["free", "gold", "funded"]) await sql`insert into org_memberships(org_id, user_id, role) values (${org}, 'u1', 'owner')`;
  await sql`insert into credit_grants(org_id, source, credits) values ('funded', 'topup', 50)`;
  await sql`insert into credit_grants(org_id, source, credits) values ('free', 'starter', 20)`;
  svc = await import("../services/workspace-indexing-mode.js");
  ws = await import("../services/workspaces.js");
  intake = await import("../services/workspace-intake.js");
  creation = await import("../services/run-creation.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(() => {
  process.env.DOCSLURP_DEFERRED_PROFILES = "1";
});
afterEach(async () => {
  delete process.env.DOCSLURP_DEFERRED_PROFILES;
  setPrivateModelEndpointRegistryForTests(undefined);
  await sql`delete from workspaces where id like 't-%'`;
});

async function seedWorkspace(id: string, orgId: string, mode: "full" | "map" | "visual", pipeline: Record<string, unknown> = {}) {
  await sql`insert into workspaces(id, org_id, user_id, name, pipeline) values (${id}, ${orgId}, 'u1', ${id}, ${sql.json({ ...defaultPipelineFeatures, ...pipeline, indexingMode: mode } as never)})`;
}

/** A completed deferred document with `indexed` of `pages` pages searchable. */
async function seedDoc(id: string, workspaceId: string, orgId: string, pages: number, indexed: number, mode: "full" | "map" | "visual" = "map") {
  await sql`insert into workspace_runs(id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
    values (${`run-${id}`}, ${orgId}, 'u1', ${workspaceId}, 'bulk-upload', 'completed', 'completed', ${sql.json(defaultPipelineFeatures as never)}, 1, ${pages})`;
  await sql`insert into documents(id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, indexing_mode)
    values (${id}, ${orgId}, 'u1', ${workspaceId}, ${`run-${id}`}, ${`${id}.pdf`}, 'application/pdf', ${`raw/${id}.pdf`}, 'completed', ${pages}, ${mode})`;
  for (let page = 1; page <= indexed; page += 1) {
    await sql`insert into document_page_states(document_id, page_number, state) values (${id}, ${page}, 'indexed')`;
  }
}

describe("plan defaults", () => {
  it("defaults document summaries on, persists opt-outs, and preserves privacy locks", async () => {
    const enabled = await ws.createWorkspace({ userId: "u1", orgId: "gold", name: "Summaries" });
    expect(enabled.summaries).toBe(true);
    expect(enabled.pipeline.summarize).toBe(true);
    expect(enabled.pipeline.pageIndex).toBe(false);
    const disabled = await ws.createWorkspace({ userId: "u1", orgId: "gold", name: "No summaries", summaries: false });
    expect(disabled.summaries).toBe(false);
    expect(disabled.pipeline.summarize).toBe(false);
    expect((await ws.updateWorkspace(enabled.id, "u1", { summaries: false }))?.summaries).toBe(false);
    expect((await ws.updateWorkspace(enabled.id, "u1", { name: "Renamed" }))?.summaries).toBe(false);
    expect((await ws.updateWorkspace(enabled.id, "u1", { summaries: true }))?.pipeline.summarize).toBe(true);
    const privateWorkspace = await ws.createWorkspace({ userId: "u1", orgId: "gold", name: "Private", templateKey: "legal-contracts" });
    expect(privateWorkspace.summaries).toBe(false);
    expect((await ws.updateWorkspace(privateWorkspace.id, "u1", { summaries: true }))?.summaries).toBe(false);
    const defaultWorkspace = await ws.ensureDefaultWorkspace({ userId: "u1", orgId: "gold" });
    expect(defaultWorkspace.summaries).toBe(true);
  });

  it("defaults a free org without purchases to map, paid or funded orgs to full", async () => {
    const mk = (orgId: string) => ws.createWorkspace({ userId: "u1", orgId, name: "W" });
    expect((await mk("free")).pipeline.indexingMode).toBe("map");
    expect((await mk("free")).indexingMode).toBe("map");
    expect((await mk("gold")).pipeline.indexingMode).toBe("full");
    expect((await mk("funded")).pipeline.indexingMode).toBe("full");
  });

  it("honours an explicit mode and pins full while the flag is off", async () => {
    const explicit = await ws.createWorkspace({ userId: "u1", orgId: "gold", name: "E", pipeline: { ...defaultPipelineFeatures, indexingMode: "map" } });
    expect(explicit.indexingMode).toBe("map");
    process.env.DOCSLURP_DEFERRED_PROFILES = "0";
    const off = await ws.createWorkspace({ userId: "u1", orgId: "free", name: "Off" });
    expect(off).toMatchObject({ indexingMode: "full", deferredIndexingAvailable: false });
    expect(off.pipeline.indexingMode).toBe("full");
    await sql`update workspaces set pipeline = jsonb_set(pipeline, '{indexingMode}', '"visual"') where id = ${off.id}`;
    expect((await ws.getWorkspace(off.id, "u1"))?.indexingMode).toBe("full");
  });
});

describe("workspace record", () => {
  it("reports indexedPageCount from page states plus full-mode pages, and availability", async () => {
    await seedWorkspace("t-count", "gold", "map");
    await seedDoc("t-count-a", "t-count", "gold", 10, 4);
    await seedDoc("t-count-b", "t-count", "gold", 6, 0, "full");
    const record = await ws.getWorkspace("t-count", "u1");
    expect(record).toMatchObject({ totalPageCount: 16, indexedPageCount: 10, indexingMode: "map", deferredIndexingAvailable: true });
    expect((await ws.listWorkspaces("u1")).find((w) => w.id === "t-count")?.indexedPageCount).toBe(10);
    // A PII-blocked page can never become searchable: resolved, like the deferred hot check treats it (M6).
    await sql`insert into document_page_states(document_id, page_number, state) values ('t-count-a', 5, 'blocked-pii')`;
    expect((await ws.getWorkspace("t-count", "u1"))?.indexedPageCount).toBe(11);
    expect((await ws.listWorkspaces("u1")).find((w) => w.id === "t-count")?.indexedPageCount).toBe(11);
  });
});

describe("mode switching", () => {
  it("rejects visual when the PII policy blocks indexing or privacy forbids hosted embedding", async () => {
    await seedWorkspace("t-pii", "gold", "map", { piiPolicy: { ...defaultPipelineFeatures.piiPolicy, enabled: true, action: "block_indexing" } });
    await expect(ws.updateWorkspace("t-pii", "u1", {}, { indexingMode: "visual" })).rejects.toMatchObject({ status: 400, code: "visual_mode_privacy" });
    await seedWorkspace("t-priv", "gold", "map", { privacyMode: "local-only", embedding: { profile: "good-fast-local" } });
    await expect(ws.updateWorkspace("t-priv", "u1", {}, { indexingMode: "visual" })).rejects.toMatchObject({ code: "visual_mode_privacy" });
  });

  it("returns 402 for full on a free org without credits, allows it when funded", async () => {
    await seedWorkspace("t-free", "free", "map");
    await expect(ws.updateWorkspace("t-free", "u1", {}, { indexingMode: "full" })).rejects.toMatchObject({ status: 402, code: "credits_required_for_full_index" });
    await seedWorkspace("t-funded", "funded", "map");
    expect((await ws.updateWorkspace("t-funded", "u1", {}, { indexingMode: "full" }))?.indexingMode).toBe("full");
  });

  it("keeps the mode when the pipeline is edited without an explicit mode", async () => {
    await seedWorkspace("t-keep", "gold", "map");
    const updated = await ws.updateWorkspace("t-keep", "u1", { pipeline: { ...defaultPipelineFeatures } });
    expect(updated?.indexingMode).toBe("map");
  });

  it("starts one page-embed reprocess run per document on map -> visual", async () => {
    await seedWorkspace("t-vis", "gold", "map");
    await seedDoc("t-vis-a", "t-vis", "gold", 5, 5);
    await seedDoc("t-vis-b", "t-vis", "gold", 5, 2);
    const before = (await ws.getWorkspace("t-vis", "u1"))!;
    const after = (await ws.updateWorkspace("t-vis", "u1", {}, { indexingMode: "visual" }))!;
    const started = await svc.startModeSwitchJobs({ before, after, indexAll: false, actor, policy: serverPolicy });
    expect(started.runIds).toHaveLength(2);
    const runs = await sql<{ pipeline: { stageSubset: string[]; indexingMode: string } }[]>`select pipeline from workspace_runs where id = any(${started.runIds})`;
    for (const run of runs) expect(run.pipeline).toMatchObject({ stageSubset: ["page-embed"], indexingMode: "visual" });
    const docs = await sql<{ reused_from_document_id: string; indexing_mode: string }[]>`select reused_from_document_id, indexing_mode from documents where run_id = any(${started.runIds})`;
    expect(docs.map((d) => d.indexing_mode)).toEqual(["visual", "visual"]);
    expect(docs.every((d) => d.reused_from_document_id)).toBe(true);
  });

  it("starts a document-map run on visual -> map, and no job on full -> deferred", async () => {
    await seedWorkspace("t-back", "gold", "visual");
    await seedDoc("t-back-a", "t-back", "gold", 5, 5, "visual");
    const before = (await ws.getWorkspace("t-back", "u1"))!;
    const after = (await ws.updateWorkspace("t-back", "u1", {}, { indexingMode: "map" }))!;
    const started = await svc.startModeSwitchJobs({ before, after, indexAll: false, actor, policy: serverPolicy });
    const [run] = await sql<{ pipeline: { stageSubset: string[] } }[]>`select pipeline from workspace_runs where id = ${started.runIds[0]!}`;
    expect(run?.pipeline.stageSubset).toEqual(["document-map"]);
    const fullBefore = { ...before, pipeline: { ...before.pipeline, indexingMode: "full" as const } };
    expect((await svc.startModeSwitchJobs({ before: fullBefore, after, indexAll: false, actor, policy: serverPolicy })).runIds).toEqual([]);
  });

  it("full-indexes only on indexAll and only documents with unindexed pages", async () => {
    await seedWorkspace("t-all", "gold", "map");
    await seedDoc("t-all-a", "t-all", "gold", 10, 10);
    await seedDoc("t-all-b", "t-all", "gold", 8, 3);
    const before = (await ws.getWorkspace("t-all", "u1"))!;
    const after = (await ws.updateWorkspace("t-all", "u1", {}, { indexingMode: "full" }))!;
    expect((await svc.startModeSwitchJobs({ before, after, indexAll: false, actor, policy: serverPolicy })).runIds).toEqual([]);
    const started = await svc.startModeSwitchJobs({ before, after, indexAll: true, actor, policy: serverPolicy });
    expect(started.runIds).toHaveLength(1);
    const docs = await sql<{ previous_version_id: string; indexing_mode: string }[]>`select previous_version_id, indexing_mode from documents where run_id = ${started.runIds[0]!}`;
    expect(docs).toEqual([{ previous_version_id: "t-all-b", indexing_mode: "full" }]);
  });
});

describe("workspace self-titling from the Index Map (M10)", () => {
  it("names an upload-titled deferred workspace from documents.metadata.mapTitle when no chunks exist", async () => {
    await seedWorkspace("t-title", "gold", "map");
    await sql`update workspaces set name = 'upload-name' where id = 't-title'`;
    await seedDoc("t-title-a", "t-title", "gold", 10, 0);
    await sql`update documents set metadata = ${sql.json({ mapTitle: "Annual Safety Report" } as never)} where id = 't-title-a'`;
    const naming = await import("../services/workspace-naming.js");
    await naming.markWorkspaceAutoNamed("t-title", "u1", "upload-name");
    await naming.refineWorkspaceNames(["t-title"]);
    const [row] = await sql<{ name: string }[]>`select name from workspaces where id = 't-title'`;
    expect(row?.name).toBe("Annual Safety Report");
  });
});

describe("switch validation cost (M1)", () => {
  it("validates every document of a switch with one reuse check, not one per document", async () => {
    await seedWorkspace("t-many", "gold", "map");
    for (const id of ["a", "b", "c", "d"]) await seedDoc(`t-many-${id}`, "t-many", "gold", 3, 0);
    const before = await ws.getWorkspace("t-many", "u1");
    queryLog.length = 0;
    const prepared = await svc.prepareModeSwitchJobs({ workspace: before!, to: "visual", indexAll: false, actor, policy: serverPolicy });
    expect(prepared.batches).toHaveLength(4);
    expect(queryLog.filter((q) => /from workspace_runs where id = any/.test(q))).toHaveLength(1);
    expect(queryLog.filter((q) => /from documents\s+where id = any/.test(q))).toHaveLength(1);
  });
});

describe("estimateModeSwitch", () => {
  beforeEach(() => { process.env.STRIPE_SECRET_KEY = "sk_test_x"; });
  afterEach(() => { delete process.env.STRIPE_SECRET_KEY; });
  it("counts only unindexed pages", async () => {
    await seedWorkspace("t-est", "gold", "map");
    await seedDoc("t-est-a", "t-est", "gold", 10, 10);
    await seedDoc("t-est-b", "t-est", "gold", 8, 3);
    const estimate = await svc.estimateModeSwitch("t-est", "full");
    expect(estimate).toMatchObject({ pages: 5, job: "full-index" });
    expect(estimate.estimatedCredits).toBeCloseTo(5 * svc.fullIndexCreditsPerPage());
    expect(await svc.estimateModeSwitch("t-est", "map")).toMatchObject({ pages: 0, job: "none" });
    const visual = await svc.estimateModeSwitch("t-est", "visual");
    expect(visual).toMatchObject({ job: "embed-pages", pages: 18 });
    // The page-image embedding cost is part of the estimate the user confirms.
    expect(visual.estimatedCredits).toBeGreaterThan(0);
    expect((await svc.estimateModeSwitch("t-est", "visual")).estimatedCredits).toBeCloseTo(estimatePageEmbedCredits(18), 3);
  });
});

describe("estimateModeSwitch visual pricing follows the resolved embedder", () => {
  const registry = [{
    alias: "gpu1", baseUrl: "https://gpu1.example.com/v1", auth: { tokenEnv: "TEST_PAGE_EMBED_TOKEN" },
    models: [{ id: "jinaai/jina-embeddings-v5-omni-nano", capability: "embedding", dimensions: 768 }],
    attestation: { tenancy: "single-tenant", hostProvider: "runpod", region: "us-east" },
    pricing: { usdPerMTokInput: 0.1 },
  }];

  beforeEach(() => { process.env.STRIPE_SECRET_KEY = "sk_test_x"; });
  afterEach(() => { delete process.env.STRIPE_SECRET_KEY; });

  it("without billing, estimates carry pages and billing \"disabled\" with null credits", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await seedWorkspace("t-nb", "gold", "map");
    await seedDoc("t-nb-a", "t-nb", "gold", 10, 4);
    expect(await svc.estimateModeSwitch("t-nb", "visual")).toMatchObject({ pages: 10, estimatedCredits: null, billing: "disabled", job: "embed-pages" });
    expect(await svc.estimateModeSwitch("t-nb", "full")).toMatchObject({ pages: 6, estimatedCredits: null, billing: "disabled", job: "full-index" });
    process.env.DOCSLURP_BILL_COMPUTE = "true";
    try {
      expect(await svc.estimateModeSwitch("t-nb", "full")).toMatchObject({ billing: "enforced" });
    } finally {
      delete process.env.DOCSLURP_BILL_COMPUTE;
    }
  });

  it("prices pages embedded as images as Rich pages, whichever route embeds them", async () => {
    await seedWorkspace("t-vp", "gold", "map", { visualPages: { route: "auto", coarseFallback: false } });
    await seedDoc("t-vp-a", "t-vp", "gold", 1000, 0);
    const hosted = await svc.estimateModeSwitch("t-vp", "visual");
    expect(hosted.estimatedCredits).toBeCloseTo(estimatePageEmbedCredits(1000, "gemini"), 6);
    expect(hosted.estimatedCredits).toBeCloseTo(250, 6);
    setPrivateModelEndpointRegistryForTests(registry);
    expect((await svc.estimateModeSwitch("t-vp", "visual")).estimatedCredits).toBeCloseTo(250, 6);
  });
});

describe("requestFullIndex", () => {
  it("is refused by a policy without allowFullIndexRequest", async () => {
    await seedWorkspace("t-pol", "gold", "map");
    await seedDoc("t-pol-a", "t-pol", "gold", 4, 1);
    await expect(svc.requestFullIndex({ orgId: "gold", workspaceId: "t-pol", actor, policy: { ...serverPolicy, allowFullIndexRequest: false } }))
      .rejects.toMatchObject({ status: 403, code: "full_index_not_allowed" });
  });

  it("is blocked by spend admission when the org has no credits", async () => {
    await sql`delete from credit_grants where org_id = 'free'`;
    await seedWorkspace("t-nospend", "free", "map");
    await seedDoc("t-nospend-a", "t-nospend", "free", 4, 1);
    await expect(svc.requestFullIndex({ orgId: "free", workspaceId: "t-nospend", actor, policy: serverPolicy })).rejects.toMatchObject({ statusCode: 402 });
  });
});

describe("version hash", () => {
  it("does not change across modes, so switching never marks chunks stale", async () => {
    const hash = (mode: "full" | "map" | "visual") => JSON.stringify(pipelineVersionFeatures({ ...defaultPipelineFeatures, indexingMode: mode }));
    expect(hash("map")).toBe(hash("full"));
    expect(hash("visual")).toBe(hash("full"));
  });
});

describe("upload indexingMode", () => {
  it("stamps documents visual in a full workspace and pins full with the flag off", async () => {
    // Loaded here, after the db mock: the fakes import run-creation, which must not bind the real client.
    const { createWorkspaceIntakeFakes, fakeWorkspace } = await import("./helpers/workspace-intake-fakes.js");
    const fakes = createWorkspaceIntakeFakes({ workspaces: [fakeWorkspace({ pipeline: { ...defaultPipelineFeatures, indexingMode: "full" } })] });
    const run = async () => {
      await intake.intakeIntoWorkspace({
        userId: "u1", workspaceId: "ws-existing", kind: "bulk-upload", indexingMode: "visual",
        items: [{ filename: "a.pdf", mimeType: "application/pdf", content: { bytes: Buffer.from("x") } }],
      }, fakes.ports);
      return fakes.runs.at(-1)!;
    };
    expect((await run()).pipeline.indexingMode).toBe("visual");
    process.env.DOCSLURP_DEFERRED_PROFILES = "0";
    expect((await run()).pipeline.indexingMode).toBe("full");
  });

  it("writes documents.indexing_mode from the run pipeline", async () => {
    await seedWorkspace("t-up", "gold", "full");
    const result = await creation.runCreation.create({
      userId: "u1", workspaceId: "t-up", kind: "bulk-upload",
      pipeline: { ...defaultPipelineFeatures, indexingMode: "visual" },
      sources: { kind: "files", files: [{ filename: "a.pdf", mimeType: "application/pdf", sourceKey: "raw/a.pdf", fileSize: 1 }] },
    });
    const [doc] = await sql<{ indexing_mode: string }[]>`select indexing_mode from documents where id = ${result.documents[0]!.id}`;
    expect(doc?.indexing_mode).toBe("visual");
  });
});
