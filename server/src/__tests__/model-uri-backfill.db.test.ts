import {
  embeddingRouteSpaceUri,
  indexConfigHash,
  indexConfigOf,
  parseStoredPipelineFeatures,
  resolveEmbeddingRoute,
  type IndexConfig,
} from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The one-off model URI backfill (services/model-uri-backfill.ts) against a migrated database: it writes the space URI
 * the read path expects (so search still serves every vector it served before), leaves rows it cannot prove null,
 * stamps only model-call usage rows, derives run model maps in the worker's shape, and is idempotent.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let backfill: typeof import("../services/model-uri-backfill.js");
let eligible: typeof import("../search/eligible-documents.js");

const DEFAULT_PIPELINE = {};
const defaultFeatures = parseStoredPipelineFeatures(DEFAULT_PIPELINE);
const defaultRoute = resolveEmbeddingRoute(defaultFeatures.embedding);
const DIM = defaultRoute.dimensions;
const defaultUri = embeddingRouteSpaceUri(defaultRoute, DIM)!;
const defaultHash = indexConfigHash(indexConfigOf(defaultFeatures));

// Project b: indexes with hosted bge-m3 now; some documents were built with the default (OpenRouter) model before.
const B_PIPELINE = { embedding: { profile: "cheapest-hosted", modelUri: "llm://deepinfra/BAAI/bge-m3" } };
const bFeatures = parseStoredPipelineFeatures(B_PIPELINE);
const bHash = indexConfigHash(indexConfigOf(bFeatures));
const oldConfig: IndexConfig = indexConfigOf(defaultFeatures);
const legacyConfig: IndexConfig = { ...indexConfigOf(defaultFeatures), chunking: { ...oldConfig.chunking, lateChunkingWindow: 7 } };
delete (legacyConfig as { normalize?: boolean }).normalize;
const legacyHash = "legacy-hash-without-normalize";

const quiet = () => {};
const run = (write: boolean, targets?: readonly import("../services/model-uri-backfill.js").ModelUriBackfillTarget[]) =>
  backfill.backfillModelUris(sql as never, { write, batchSize: 2, log: quiet, ...(targets ? { targets } : {}) });

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'backfill@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('org1', 'Org', 'backfill', 'u')`;
  await sql`insert into projects (id, org_id, user_id, name, pipeline) values ('a', 'org1', 'u', 'A', ${sql.json(DEFAULT_PIPELINE)})`;
  await sql`insert into projects (id, org_id, user_id, name, pipeline, index_configs) values ('b', 'org1', 'u', 'B', ${sql.json(B_PIPELINE)},
    ${sql.json({ [bHash]: indexConfigOf(bFeatures), [defaultHash]: oldConfig, [legacyHash]: legacyConfig } as never)})`;
  for (const [id, project, status] of [["run1", "a", "completed"], ["run2", "a", "completed"], ["runb", "b", "completed"], ["run-live", "a", "processing"]] as const) {
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, monthly_reservation_cents)
      values (${id}, 'org1', 'u', ${project}, 'bulk-upload', ${status}, ${status}, ${sql.json(project === "b" ? B_PIPELINE : DEFAULT_PIPELINE)}, 1)`;
  }
  const docs: Array<[id: string, project: string, run: string, hash: string | null, model: string, dim: number]> = [
    ["match", "a", "run1", defaultHash, defaultRoute.model, DIM],
    ["bare-id-mismatch", "a", "run1", defaultHash, "pplx-embed-v1-0.6b", DIM],
    ["dim-mismatch", "a", "run1", defaultHash, defaultRoute.model, 512],
    ["no-hash", "a", "run1", null, defaultRoute.model, DIM],
    ["b-current", "b", "runb", bHash, "BAAI/bge-m3", 1024],
    ["b-old", "b", "runb", defaultHash, defaultRoute.model, DIM],
    ["b-legacy", "b", "runb", legacyHash, defaultRoute.model, DIM],
    ["b-unrecorded", "b", "runb", "not-recorded", defaultRoute.model, DIM],
  ];
  for (const [id, project, runId, hash, model, dim] of docs) {
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, index_config_hash)
      values (${id}, 'org1', 'u', ${project}, ${runId}, ${`${id}.pdf`}, 'application/pdf', ${`k-${id}`}, 'completed', ${hash})`;
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
      values (${`vi-${id}`}, ${id}, 'lancedb', 'b', 'p', ${model}, ${dim})`;
  }
  const events: Array<[id: string, run: string | null, doc: string | null, provider: string, model: string, metric: string, input: number, metadata: Record<string, unknown>]> = [
    ["e-embed", "run1", "match", "openrouter", defaultRoute.model, "embedding-tokens", 100, { modelConfig: { dimensions: DIM, baseUrl: "https://x" } }],
    ["e-summary", "run1", "match", "openrouter", "qwen/qwen3.5-flash-02-23", "summary-generation", 500, {}],
    ["e-preamble", "run1", "match", "openrouter", "other/text-model", "contextual-chunk-preamble", 50, {}],
    ["e-vision", "run1", "match", "openrouter", "openai/gpt-6-luna", "page-analysis", 900, {}],
    ["e-router", "run1", "match", "openrouter", "typesafe/jev-1.13", "page-route-decision", 10, {}],
    ["e-compute", "run1", null, "local-compute", "lean:extract", "worker-stage", 0, {}],
    ["e-modal", "run1", null, "modal", "modal:parsers", "sandbox_compute", 0, {}],
    ["e-card", null, null, "docslurp", "price-card", "search-query", 0, {}],
    ["e-unit", "run1", null, "openrouter", "x/y", "ingest-page-rich", 0, { unitCharge: true }],
    ["e-stamped", "run1", null, "openrouter", "z-ai/glm-5.3-flash", "workspace-chat-tools", 5, { modelUri: "llm://openrouter/kept" }],
    ["e-query", null, null, "transformers.js", "Xenova/bge-m3", "embed-query", 7, {}],
    ["e-live", "run-live", null, "openrouter", "qwen/qwen3.5-flash-02-23", "summary-generation", 40, {}],
  ];
  for (const [id, runId, doc, provider, model, metric, input, metadata] of events) {
    await sql`insert into usage_events (id, user_id, run_id, document_id, provider, model, metric, amount, unit, input_tokens, metadata, org_id, project_id)
      values (${id}, 'u', ${runId}, ${doc}, ${provider}, ${model}, ${metric}, 1, 'token', ${input}, ${sql.json(metadata as never)}, 'org1', 'a')`;
  }
  for (const [page, pass, method, engine] of [[1, "vision", "vision", "vision-model"], [2, "extract", "text-layer", "pandoc"]] as const) {
    await sql`insert into document_page_extracts (document_id, org_id, project_id, run_id, page_number, pass, method, engine)
      values ('match', 'org1', 'a', 'run1', ${page}, ${pass}, ${method}, ${engine})`;
  }
  backfill = await import("../services/model-uri-backfill.js");
  eligible = await import("../search/eligible-documents.js");
}, 120_000);

afterEach(() => eligible.resetEligibleDocumentCachesForTests());
afterAll(async () => { await sql?.end(); await stop?.(); });

const vectorRows = async () => Object.fromEntries((await sql<{ document_id: string; uri: string | null; class: string | null }[]>`
  select document_id, embedding_model_uri as uri, embedding_model_class as class from vector_indexes`).map((row) => [row.document_id, row]));

const readyIn = async (projectId: string, route: ReturnType<typeof resolveEmbeddingRoute>, dim: number) => {
  const set = await eligible.loadEligibleDocuments({ projectId, embeddingModel: route.model, dimension: dim, embeddingModelUri: embeddingRouteSpaceUri(route, dim) });
  return set.documents.filter((document) => document.vectorReady).map((document) => document.id).sort();
};

describe("model URI backfill", () => {
  it("dry run counts and writes nothing", async () => {
    const before = await sql`select count(*)::int as n from usage_events where metadata ? 'modelUri'`;
    const report = await run(false);
    expect(report.mode).toBe("dry-run");
    expect(report["vector-indexes"]).toMatchObject({ scanned: 8, updated: 3 });
    expect(report["vector-indexes"]!.unmatched).toEqual({
      "model-mismatch": 1, "dimension-mismatch": 1, "document-without-index-config-hash": 1,
      "index-config-normalization-unknown": 1, "index-config-not-recorded": 1,
    });
    expect(report["usage-events"]).toMatchObject({ scanned: 11, updated: 7, skipped: { "not-a-model-call": 4 } });
    expect(report.runs).toMatchObject({ scanned: 3 });
    expect(Object.values(await vectorRows()).every((row) => row.uri === null)).toBe(true);
    expect(await sql`select count(*)::int as n from usage_events where metadata ? 'modelUri'`).toEqual(before);
    expect(await sql`select count(*)::int as n from project_runs where resolved_models is not null`).toEqual([{ n: 0 }]);
  });

  it("writes the reader's space URI only where the route's bare id and dimensions match the row", async () => {
    const vectorsBefore = { a: await readyIn("a", defaultRoute, DIM) };
    const report = await backfill.backfillModelUris(sql as never, { write: true, batchSize: 2, log: quiet, verify: true });
    expect(report["vector-indexes"]).toMatchObject({ updated: 3 });
    expect(report.verify).toMatchObject({ ok: true, decreased: {} });
    expect(report.verify!.spaces).toBeGreaterThanOrEqual(3);
    const rows = await vectorRows();
    expect(rows.match).toMatchObject({ uri: defaultUri, class: "embeddingProfile=cheapest-hosted" });
    const bRoute = resolveEmbeddingRoute(bFeatures.embedding);
    expect(rows["b-current"]!.uri).toBe(embeddingRouteSpaceUri(bRoute, 1024));
    // Served through the recorded older config: the old model's space. Its run used bge-m3, so no class is claimed.
    expect(rows["b-old"]).toMatchObject({ uri: defaultUri, class: null });
    for (const id of ["bare-id-mismatch", "dim-mismatch", "no-hash", "b-legacy", "b-unrecorded"]) expect(rows[id]!.uri).toBeNull();
    // Search still serves exactly what it served before.
    expect(await readyIn("a", defaultRoute, DIM)).toEqual(vectorsBefore.a);
    expect(await readyIn("a", defaultRoute, DIM)).toContain("match");
    expect(await readyIn("b", bRoute, 1024)).toEqual(["b-current"]);
    expect(await readyIn("b", defaultRoute, DIM)).toEqual(["b-legacy", "b-old", "b-unrecorded"]);
  });

  it("stamps model-call usage rows with withModelProvenance's URI and a marker, and leaves the rest", async () => {
    const rows = Object.fromEntries((await sql<{ id: string; metadata: Record<string, unknown> }[]>`select id, metadata from usage_events`).map((row) => [row.id, row.metadata]));
    expect(rows["e-embed"]).toMatchObject({ modelUri: `llm://openrouter/${defaultRoute.model}?dimensions=${DIM}`, modelUriBackfilled: true });
    // The original modelConfig (address included) is not rewritten; only the URI is added.
    expect(rows["e-embed"]!.modelConfig).toEqual({ dimensions: DIM, baseUrl: "https://x" });
    expect(rows["e-summary"]).toMatchObject({ modelUri: "llm://openrouter/qwen/qwen3.5-flash-02-23", modelUriBackfilled: true });
    expect(rows["e-query"]).toMatchObject({ modelUri: "llm://transformers.js/Xenova/bge-m3" });
    for (const id of ["e-compute", "e-modal", "e-card", "e-unit"]) expect(rows[id]).not.toHaveProperty("modelUri");
    expect(rows["e-stamped"]).toEqual({ modelUri: "llm://openrouter/kept" });
  });

  it("derives run model maps in the worker's shape", async () => {
    const runs = Object.fromEntries((await sql<{ id: string; resolved_models: unknown }[]>`select id, resolved_models from project_runs`).map((row) => [row.id, row.resolved_models]));
    expect(runs.run1).toEqual({
      text: { uri: "llm://openrouter/qwen/qwen3.5-flash-02-23", backfilled: true, otherModels: 1 },
      vision: { uri: "llm://openrouter/openai/gpt-6-luna", class: expect.stringContaining("visionProfile="), backfilled: true },
      embedding: { uri: defaultUri, class: "embeddingProfile=cheapest-hosted", backfilled: true },
    });
    expect(runs.run2).toBeNull();
    // A run that is still processing keeps a null map: the worker sets it, and its usage is not final.
    expect(runs["run-live"]).toBeNull();
    expect(runs.runb).toBeNull();
  });

  it("names the model of vision reads only", async () => {
    const rows = await sql<{ page_number: number; model_uri: string | null; model_class: string | null }[]>`
      select page_number, model_uri, model_class from document_page_extracts order by page_number`;
    expect(rows[0]).toMatchObject({ model_uri: "llm://openrouter/openai/gpt-6-luna", model_class: expect.stringContaining("embeddingProfile=cheapest-hosted") });
    expect(rows[1]).toMatchObject({ model_uri: null, model_class: null });
  });

  it("--verify reports a space whose vector-ready count fell", async () => {
    const before = await backfill.vectorReadyCounts(sql as never);
    await sql`update vector_indexes set embedding_model_uri = 'llm://another-host/x' where id = 'vi-match'`;
    try {
      const decreased = backfill.vectorReadyDecreases(before, await backfill.vectorReadyCounts(sql as never));
      expect(decreased).toEqual({ [`a|${defaultUri}`]: { before: before[`a|${defaultUri}`], after: before[`a|${defaultUri}`]! - 1 } });
    } finally {
      await sql`update vector_indexes set embedding_model_uri = ${defaultUri} where id = 'vi-match'`;
    }
  });

  it("summarizes the model environment and project routes without secrets", async () => {
    const summary = await backfill.modelEnvironmentSummary(sql as never, {});
    expect(summary).toMatchObject({ modelMode: "hosted", privateEndpointRegistry: null, privateServiceMap: null, mappedServices: [], unreadableProjects: 0 });
    expect(summary.projectEmbeddings).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: defaultRoute.model, dimensions: DIM, spaceUri: defaultUri, projects: 1 }),
      expect.objectContaining({ model: "BAAI/bge-m3", projects: 1 }),
    ]));
    expect(JSON.stringify(summary)).not.toContain("http");
    const digested = await backfill.modelEnvironmentSummary(sql as never, { DOCSLURP_PRIVATE_MODEL_ENDPOINTS: "[]", DOCSLURP_PRIVATE_TEXT_MODEL: "llm://private/a/b" });
    expect(digested.privateEndpointRegistry).toMatch(/^[0-9a-f]{16}$/);
    expect(digested.privateServiceMap).toMatch(/^[0-9a-f]{16}$/);
    expect(digested.mappedServices).toEqual(["text"]);
  });

  it("retries a batch on a lock timeout, deadlock or statement timeout, and fails on other errors", async () => {
    let failures = ["55P03", "40P01", "57014"];
    const flaky = new Proxy(sql, {
      get(target, key, receiver) {
        if (key !== "begin") return Reflect.get(target, key, receiver);
        return (fn: never) => {
          const code = failures.shift();
          if (code) return Promise.reject(Object.assign(new Error("transient"), { code }));
          return target.begin(fn);
        };
      },
    });
    const lines: string[] = [];
    const report = await backfill.backfillModelUris(flaky as never, { targets: ["usage-events"], write: true, retryBaseMs: 1, log: (line) => lines.push(line) });
    expect(report["usage-events"]!.updated).toBe(0);
    expect(lines.filter((line) => line.includes("retry"))).toHaveLength(3);
    failures = ["55P03", "55P03", "55P03", "55P03"];
    await expect(backfill.backfillModelUris(flaky as never, { targets: ["usage-events"], write: true, retryBaseMs: 1, log: quiet })).rejects.toMatchObject({ code: "55P03" });
    failures = ["23505"];
    await expect(backfill.backfillModelUris(flaky as never, { targets: ["usage-events"], write: true, retryBaseMs: 1, log: quiet })).rejects.toMatchObject({ code: "23505" });
  });

  it("is idempotent: a rerun updates nothing", async () => {
    const report = await run(true);
    for (const target of backfill.MODEL_URI_BACKFILL_TARGETS) expect(report[target]!.updated, target).toBe(0);
  });
});

describe("deriveResolvedModels", () => {
  it("skips non-model rows and the page router, and ranks by input tokens", () => {
    const { models, notes } = (backfill as typeof import("../services/model-uri-backfill.js")).deriveResolvedModels([
      { metric: "graphrag-extract", provider: "openrouter", model: "a/one", input_tokens: 10 },
      { metric: "graphrag-extract", provider: "openrouter", model: "b/two", input_tokens: "20" },
      { metric: "page-route-decision", provider: "openrouter", model: "r/router", input_tokens: 99 },
      { metric: "structured-extract", provider: "docslurp", model: "price-card", input_tokens: 5 },
      { metric: "embedding-tokens", provider: "openrouter", model: "m", input_tokens: 5 },
    ], [], null);
    expect(models).toEqual({ text: { uri: "llm://openrouter/b/two", backfilled: true, otherModels: 1 } });
    expect(notes).toEqual(expect.arrayContaining(["text-multiple-models", "embedding-no-recorded-space"]));
  });
});
