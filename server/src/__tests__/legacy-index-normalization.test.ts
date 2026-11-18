import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures, indexConfigHash, indexConfigOf, legacyIndexConfigHash, type PipelineFeatures } from "@docslurp/shared";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Indexes built before normalization joined the index identity carry the legacy hash. The backfill records their
 * normalization only when every document's run snapshot proves it; everything else keeps failing closed.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let backfill: typeof import("../search/legacy-index-normalization.js");
let serving: typeof import("../search/index-serving.js");

const withModel = (modelUri: string, normalize?: boolean): PipelineFeatures => ({
  ...defaultPipelineFeatures,
  embedding: { ...defaultPipelineFeatures.embedding, target: "local" as const, modelUri: modelUri as never, ...(normalize === undefined ? {} : { normalize }) },
});
const C = withModel("llm://transformers.js/Xenova/bge-m3");
const B = withModel("llm://transformers.js/Xenova/gte-small");
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const legacy = (pipeline: PipelineFeatures) => legacyIndexConfigHash(indexConfigOf(pipeline));
const withoutNormalize = (pipeline: PipelineFeatures) => {
  const { embedding, ...rest } = json(pipeline);
  delete embedding.normalize;
  return { ...rest, embedding };
};

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  backfill = await import("../search/legacy-index-normalization.js");
  serving = await import("../search/index-serving.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  await sql`delete from document_run_stage_states`;
  await sql`delete from vector_indexes`;
  await sql`delete from documents`;
  await sql`delete from project_runs`;
  await sql`delete from projects`;
  await sql`delete from organizations`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1'), ('o2', 'Org2', 'org2', 'u1')`;
});

async function project(id: string, org: string, pipeline: PipelineFeatures = C, configs: Record<string, unknown> | null = null) {
  await sql`insert into projects(id, org_id, user_id, name, pipeline, index_configs)
    values (${id}, ${org}, 'u1', ${id}, ${sql.json(json(pipeline))}, ${configs ? sql.json(json(configs)) : null})`;
}
async function run(id: string, projectId: string, org: string, pipeline: unknown) {
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents)
    values (${id}, ${org}, 'u1', ${projectId}, 'upload', 'completed', 'index', ${sql.json(json(pipeline))}, 1)`;
}
let docs = 0;
async function doc(projectId: string, org: string | null, runId: string | null, hash: string | null, opts: { reusedFrom?: string; purged?: boolean } = {}) {
  const id = `d${++docs}`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, index_config_hash, reused_from_document_id, purged_at)
    values (${id}, ${org}, 'u1', ${projectId}, ${runId}, ${id}, 'application/pdf', ${id}, 'completed', 1, ${hash}, ${opts.reusedFrom ?? null}, ${opts.purged ? new Date() : null})`;
  // A legacy document by date, whatever today is: the candidate query only walks projects with documents from before the cutoff.
  await sql`update documents set created_at = ${backfill.LEGACY_STAMP_CUTOFF}::timestamptz - interval '1 day' where id = ${id}`;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
    values (${`v${id}`}, ${id}, 'lancedb', 'b', 'p', 'm', 1024)`;
  return id;
}
async function configsOf(projectId: string) {
  const [row] = await sql<{ index_configs: Record<string, { normalize?: boolean }> | null }[]>`select index_configs from projects where id = ${projectId}`;
  return row?.index_configs ?? null;
}
async function serve(projectId: string, pipeline: PipelineFeatures = C) {
  const [row] = await sql<{ index_configs: unknown }[]>`select index_configs from projects where id = ${projectId}`;
  const calls: Array<{ normalize: boolean | undefined; hash: string | undefined }> = [];
  await serving.servedVectorSearch({
    projectId, pipeline, indexConfigs: serving.parseIndexConfigs(row?.index_configs), queryVector: [1], query: "q", sql: sql as never,
    deps: {
      search: async (_vector, serve) => { calls.push({ normalize: serve?.embedding.normalize, hash: serve?.hash?.value }); return []; },
      embed: async () => [1],
    },
  });
  return calls;
}

describe("legacy index normalization backfill", () => {
  it("records the normalization a legacy index was provably built with, and search then serves it", async () => {
    await project("w", "o1");
    await run("r", "w", "o1", C);
    const d = await doc("w", "o1", "r", legacy(C));
    await expect(serve("w")).rejects.toMatchObject({ code: "index_rebuild_required" });

    const outcome = await backfill.backfillProjectLegacyNormalization("w", sql as never);
    expect(outcome.recorded).toEqual([legacy(C)]);
    expect((await configsOf("w"))![legacy(C)]).toEqual(json({ ...indexConfigOf(C), normalize: true }));
    // Documents keep their identity.
    const [row] = await sql<{ index_config_hash: string }[]>`select index_config_hash from documents where id = ${d}`;
    expect(row!.index_config_hash).toBe(legacy(C));
    const calls = await serve("w");
    expect(calls).toContainEqual({ normalize: true, hash: legacy(C) });
  });

  it("treats an absent run setting as the profile default and records an explicit false as false", async () => {
    await project("w", "o1");
    await run("r1", "w", "o1", withoutNormalize(C));
    await doc("w", "o1", "r1", legacy(C));
    const off = withModel("llm://transformers.js/Xenova/gte-small", false);
    await run("r2", "w", "o1", off);
    await doc("w", "o1", "r2", legacy(off));
    await backfill.backfillProjectLegacyNormalization("w", sql as never);
    const configs = (await configsOf("w"))!;
    expect(configs[legacy(C)]!.normalize).toBe(true);
    expect(configs[legacy(off)]!.normalize).toBe(false);
    expect(await serve("w")).toContainEqual({ normalize: false, hash: legacy(off) });
  });

  it.each([
    ["an empty run snapshot", async () => { await run("r", "w", "o1", {}); await doc("w", "o1", "r", legacy(C)); }, "run-pipeline-missing"],
    ["a run that cannot reproduce the hash", async () => { await run("r", "w", "o1", B); await doc("w", "o1", "r", legacy(C)); }, "run-config-mismatch"],
    ["a document without a run", async () => { await doc("w", "o1", null, legacy(C)); }, "document-without-run"],
    ["runs that disagree", async () => {
      await run("r1", "w", "o1", C); await run("r2", "w", "o1", withModel("llm://transformers.js/Xenova/bge-m3", false));
      await doc("w", "o1", "r1", legacy(C)); await doc("w", "o1", "r2", legacy(C));
    }, "runs-disagree"],
    ["an unreadable normalize value", async () => {
      await run("r", "w", "o1", { ...json(C), embedding: { ...json(C).embedding, normalize: "yes" } }); await doc("w", "o1", "r", legacy(C));
    }, "run-normalize-unreadable"],
  ])("leaves %s unknown and search still refuses", async (_name, arrange, reason) => {
    await project("w", "o1");
    await arrange();
    const outcome = await backfill.backfillProjectLegacyNormalization("w", sql as never);
    expect(outcome.recorded).toEqual([]);
    expect(outcome.unprovable[0]!.reason).toBe(reason);
    expect(await configsOf("w")).toBeNull();
    await expect(serve("w")).rejects.toMatchObject({ code: "index_rebuild_required" });
  });

  it("one unprovable document keeps its whole legacy identity unknown", async () => {
    await project("w", "o1");
    await run("r", "w", "o1", C);
    await doc("w", "o1", "r", legacy(C));
    await doc("w", "o1", null, legacy(C));
    const outcome = await backfill.backfillProjectLegacyNormalization("w", sql as never);
    expect(outcome.recorded).toEqual([]);
    expect(await configsOf("w")).toBeNull();
  });

  it("never uses another project's or organization's run as proof, and only writes its own project", async () => {
    await project("w1", "o1");
    await project("w2", "o2");
    await run("r1", "w1", "o1", C);
    await doc("w1", "o1", "r1", legacy(C));
    // A document in w2 pointing at w1's run (should never happen; must not be proven by it).
    await doc("w2", "o2", "r1", legacy(C));
    const first = await backfill.backfillProjectLegacyNormalization("w2", sql as never);
    expect(first.recorded).toEqual([]);
    expect(first.unprovable[0]!.reason).toBe("run-missing");
    expect(await configsOf("w1")).toBeNull();
    await backfill.backfillProjectLegacyNormalization("w1", sql as never);
    expect((await configsOf("w1"))![legacy(C)]!.normalize).toBe(true);
    expect(await configsOf("w2")).toBeNull();
  });

  it("is idempotent and never replaces a recorded normalization", async () => {
    const recorded = { ...indexConfigOf(C), normalize: false };
    const other = withModel("llm://transformers.js/Xenova/gte-small");
    await project("w", "o1", C, { [legacy(C)]: recorded });
    await run("r", "w", "o1", C);
    await run("r2", "w", "o1", other);
    await doc("w", "o1", "r", legacy(C));
    await doc("w", "o1", "r2", legacy(other));
    await backfill.backfillProjectLegacyNormalization("w", sql as never);
    const once = await configsOf("w");
    expect(once![legacy(C)]).toEqual(json(recorded));
    expect(once![legacy(other)]!.normalize).toBe(true);
    const again = await backfill.backfillProjectLegacyNormalization("w", sql as never);
    expect(again.recorded).toEqual([]);
    expect(await configsOf("w")).toEqual(once);
  });

  it("completes an entry recorded before normalization was tracked, and refuses one that describes another index", async () => {
    const { normalize: _n, ...before } = indexConfigOf(C);
    await project("w", "o1", B, { [legacy(C)]: before });
    await run("r", "w", "o1", C);
    await doc("w", "o1", "r", legacy(C));
    await backfill.backfillProjectLegacyNormalization("w", sql as never);
    expect((await configsOf("w"))![legacy(C)]).toEqual(json({ ...before, normalize: true }));

    const { normalize: _m, ...wrong } = indexConfigOf(B);
    await sql`update projects set index_configs = ${sql.json(json({ [legacy(C)]: wrong }))} where id = 'w'`;
    const outcome = await backfill.backfillProjectLegacyNormalization("w", sql as never);
    expect(outcome.unprovable[0]!.reason).toBe("stored-entry-mismatch");
    expect((await configsOf("w"))![legacy(C)]).toEqual(json(wrong));
  });

  it("ignores documents already on the current identity", async () => {
    await project("w", "o1");
    await run("r", "w", "o1", C);
    await doc("w", "o1", "r", indexConfigHash(indexConfigOf(C)));
    const outcome = await backfill.backfillProjectLegacyNormalization("w", sql as never);
    expect(outcome).toEqual({ projectId: "w", recorded: [], unprovable: [], unhashed: 0 });
    expect(await configsOf("w")).toBeNull();
  });

  it("walks every project in pages", async () => {
    for (const [id, org] of [["w1", "o1"], ["w2", "o2"], ["w3", "o1"]] as const) {
      await project(id, org);
      await run(`r-${id}`, id, org, C);
      await doc(id, org, `r-${id}`, legacy(C));
    }
    const totals = await backfill.backfillLegacyIndexNormalization(sql as never, { pageSize: 1, log: () => {} });
    expect(totals).toEqual({ projects: 3, recorded: 3, unprovable: 0 });
    for (const id of ["w1", "w2", "w3"]) expect((await configsOf(id))![legacy(C)]!.normalize).toBe(true);
    expect(await backfill.backfillLegacyIndexNormalization(sql as never, { pageSize: 1, log: () => {} })).toEqual({ projects: 0, recorded: 0, unprovable: 0 });
  });

  it("follows reused embeddings to the run that embedded them, including purged sources", async () => {
    const off = withModel("llm://transformers.js/Xenova/bge-m3", false);
    const both = { ...C, vectorBackends: ["lancedb", "milvus"] } as PipelineFeatures;
    await project("w", "o1", both);
    await run("r-old", "w", "o1", off);
    await run("r-new", "w", "o1", both);
    const source = await doc("w", "o1", "r-old", legacy(off), { purged: true });
    const reusing = await doc("w", "o1", "r-new", legacy(both), { reusedFrom: source });
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, stats)
      values ('r-new', ${reusing}, 'embed', 'completed', ${sql.json({ reused: true, reusedFromDocumentId: source, reusedFromRunId: "r-old" })})`;
    const outcome = await backfill.backfillProjectLegacyNormalization("w", sql as never);
    expect(outcome.recorded).toEqual([]);
    expect(outcome.unprovable[0]!.reason).toBe("reuse-disagrees");
    expect(await configsOf("w")).toBeNull();
  });

  it("refuses a reuse recorded only in stage state when its source is gone", async () => {
    await project("w", "o1");
    await run("r", "w", "o1", C);
    const d = await doc("w", "o1", "r", legacy(C));
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, stats)
      values ('r', ${d}, 'embed', 'completed', ${sql.json({ reused: true, reusedFromDocumentId: "gone", reusedFromRunId: "r0" })})`;
    const outcome = await backfill.backfillProjectLegacyNormalization("w", sql as never);
    expect(outcome.unprovable[0]!.reason).toBe("reuse-source-missing");
  });

  it("proves reuse whose whole chain agrees", async () => {
    await project("w", "o1");
    await run("r1", "w", "o1", C);
    await run("r2", "w", "o1", C);
    const source = await doc("w", "o1", "r1", legacy(C));
    const reusing = await doc("w", "o1", "r2", legacy(C), { reusedFrom: source });
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, stats)
      values ('r2', ${reusing}, 'embed', 'completed', ${sql.json({ reused: true, reusedFromDocumentId: source, reusedFromRunId: "r1" })})`;
    expect((await backfill.backfillProjectLegacyNormalization("w", sql as never)).recorded).toEqual([legacy(C)]);
  });

  it("a document of the project outside its organization blocks the proof instead of being served unproven", async () => {
    await project("w", "o1");
    await run("r", "w", "o1", C);
    await doc("w", "o1", "r", legacy(C));
    await doc("w", null, "r", legacy(C));
    const outcome = await backfill.backfillProjectLegacyNormalization("w", sql as never);
    expect(outcome.unprovable[0]!.reason).toBe("document-org-mismatch");
    expect(await configsOf("w")).toBeNull();
  });

  it("reports only what it wrote and counts documents without an identity", async () => {
    await project("w", "o1", C, { [legacy(C)]: { ...indexConfigOf(C), normalize: true } });
    await run("r", "w", "o1", C);
    await doc("w", "o1", "r", legacy(C));
    await doc("w", "o1", "r", null);
    const outcome = await backfill.backfillProjectLegacyNormalization("w", sql as never);
    expect(outcome).toEqual({ projectId: "w", recorded: [], unprovable: [], unhashed: 1 });
  });

  it("does not select projects whose documents all postdate the legacy identity", async () => {
    await project("w", "o1");
    await run("r", "w", "o1", C);
    const d = await doc("w", "o1", "r", legacy(C));
    await sql`update documents set created_at = ${backfill.LEGACY_STAMP_CUTOFF}::timestamptz + interval '1 day' where id = ${d}`;
    expect((await backfill.backfillLegacyIndexNormalization(sql as never, { log: () => {} })).projects).toBe(0);
  });
});
