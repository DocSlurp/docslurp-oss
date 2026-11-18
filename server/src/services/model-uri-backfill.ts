import {
  embeddingRouteSpaceUri,
  indexConfigHash,
  indexConfigOf,
  modelClassLabel,
  modelRecordUri,
  parseStoredPipelineFeatures,
  resolveEmbeddingRoute,
  runModelClass,
  withModelProvenance,
  type EmbeddingConfig,
  type PipelineFeatures,
} from "@docslurp/shared";

import type { SqlClient } from "../db.js";
import { pageQuerySpaceUri } from "../search/deferred/page-query-embedder.js";
import { effectiveProjectIndexing, embeddingConfigFor, parseIndexConfigs, type IndexConfigMap } from "../search/index-serving.js";

/**
 * One-off backfill of the exact model records migrations 0191/0192 added (core #485/#495) for rows written before
 * them. It fills only what can be derived deterministically and never a value that could make search hide a vector:
 *
 * - `vector_indexes.embedding_model_uri` is the space URI the current read path computes for the row's document
 *   (search.ts / eligible-documents.ts: `embeddingRouteSpaceUri(resolveEmbeddingRoute(<serving config>), dims)`, the
 *   serving config chosen as index-serving.ts does from the document's `index_config_hash`), written only when that
 *   route's bare model id and dimensions equal the row's. Readers match `coalesce(uri = expected, true)`, so a URI
 *   equal to `expected` serves exactly the rows a null did. `embedding_model_class` is the embedding profile of the
 *   document's run (as the writer stores it) when that run's route names the same space.
 * - `document_page_states.embedding_model_uri`: the same derivation (nothing filters on it).
 * - `document_page_vectors.model_uri`: `pageQuerySpaceUri(model, dims)`, the value the page-vector locator queries with.
 * - `usage_events.metadata.modelUri`: `withModelProvenance`'s URI for the row, plus `modelUriBackfilled: true`.
 * - `project_runs.resolved_models` (null only): per service from the run's usage, in the worker's shape.
 * - `document_page_extracts.model_uri`/`model_class`: vision-model reads whose run and document saw exactly one model.
 *
 * Every target pages by primary key, touches only null fields (rerunning writes nothing), and runs each batch in its
 * own transaction with a statement and lock timeout. Dry run (the default) computes the same counts and writes nothing.
 */

export const MODEL_URI_BACKFILL_TARGETS = ["vector-indexes", "page-states", "page-vectors", "usage-events", "runs", "page-extracts"] as const;
export type ModelUriBackfillTarget = (typeof MODEL_URI_BACKFILL_TARGETS)[number];

export interface ModelUriBackfillOptions {
  targets?: readonly ModelUriBackfillTarget[];
  /** Apply the updates; otherwise count only. */
  write?: boolean;
  /** Rows read (and at most written) per batch statement. */
  batchSize?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  /** Progress lines; defaults to stderr. */
  log?: (line: string) => void;
}

export interface TargetReport {
  scanned: number;
  /** Rows written (or, in a dry run, rows that would be). */
  updated: number;
  /** Rows a value was looked for but none could be proven, by reason. */
  unmatched: Record<string, number>;
  /** Rows with nothing to record (not a model call, a pass no model served), by reason. */
  skipped: Record<string, number>;
  /** Extra notes (e.g. services that saw more than one model). */
  notes?: Record<string, number>;
}

export type ModelUriBackfillReport = { mode: "write" | "dry-run"; batchSize: number } & Partial<Record<ModelUriBackfillTarget, TargetReport>>;

/**
 * Usage metrics that name the model serving a `resolved_models` service (worker/src/pipeline/resolved-models.ts):
 * `text` is the pipeline's text model (summaries, chunk preambles, graph extraction), `structuredExtraction` the
 * schema extraction model, `vision` the model reading pages, `embedding` the ingestion embedding model. The page
 * router (`page-route-decision`) has no key in the worker's map and is left out.
 */
export const RESOLVED_MODEL_SERVICE_BY_METRIC: Readonly<Record<string, "text" | "structuredExtraction" | "vision" | "embedding">> = {
  "summary-generation": "text",
  "contextual-chunk-preamble": "text",
  "graphrag-extract": "text",
  "community-summary": "text",
  "structured-extract": "structuredExtraction",
  "page-analysis": "vision",
  "embedding-tokens": "embedding",
  "summary-embedding": "embedding",
};

/** The usage metric of a vision-model page read (vision-extract.ts, materialize-pages.ts). */
const VISION_READ_METRIC = "page-analysis";

const emptyReport = (): TargetReport => ({ scanned: 0, updated: 0, unmatched: {}, skipped: {} });
const bump = (bucket: Record<string, number>, key: string, by = 1) => { bucket[key] = (bucket[key] ?? 0) + by; };

type Indexing = { pipeline: PipelineFeatures; indexConfigs: IndexConfigMap; currentHash: string };

function readProjectIndexing(row: { id: string; pipeline: unknown; index_configs: unknown }): Indexing | { reason: string } {
  try {
    // The reader search uses (session-setup.ts loadProjectIndexing), including the private model mode.
    const { pipeline, indexConfigs } = effectiveProjectIndexing(parseStoredPipelineFeatures(row.pipeline ?? null, `project ${row.id}`), parseIndexConfigs(row.index_configs));
    return { pipeline, indexConfigs, currentHash: indexConfigHash(indexConfigOf(pipeline)) };
  } catch {
    return { reason: "project-pipeline-unreadable" };
  }
}

/**
 * The embedding config search serves a document with (index-serving.ts servedVectorSearch): the current pipeline for
 * documents built with the current index config, the recorded config (embeddingConfigFor) for one built with another.
 * A document with no hash, or one whose config is not recorded or has unknown normalization, is not served by any
 * config, so no URI can be proven for it.
 */
export function servingEmbeddingFor(indexing: Indexing, hash: string | null): EmbeddingConfig | { reason: string } {
  if (!hash) return { reason: "document-without-index-config-hash" };
  if (hash === indexing.currentHash) return indexing.pipeline.embedding;
  const config = indexing.indexConfigs[hash];
  if (!config) return { reason: "index-config-not-recorded" };
  if (config.normalize === undefined) return { reason: "index-config-normalization-unknown" };
  return embeddingConfigFor(indexing.pipeline.embedding, config);
}

/** The space URI readers expect for a vector row of `embeddingModel` × `dimension` served by `embedding`, or why none. */
export function expectedSpaceUri(embedding: EmbeddingConfig, embeddingModel: string, dimension: number | null): { uri: string; route: ReturnType<typeof resolveEmbeddingRoute> } | { reason: string } {
  let route: ReturnType<typeof resolveEmbeddingRoute>;
  try {
    route = resolveEmbeddingRoute(embedding);
  } catch {
    return { reason: "route-unresolvable" };
  }
  // Readers filter `embedding_model = route.model and dimension = <query vector length>`, exact strings.
  if (route.model !== embeddingModel) return { reason: "model-mismatch" };
  const dims = dimension ?? route.dimensions;
  if (route.dimensions !== dims) return { reason: "dimension-mismatch" };
  const uri = embeddingRouteSpaceUri(route, dims);
  return uri ? { uri, route } : { reason: "no-space-uri" };
}

function parseRunPipeline(id: string, pipeline: unknown): PipelineFeatures | null {
  try {
    return parseStoredPipelineFeatures(pipeline ?? null, `run ${id}`);
  } catch {
    return null;
  }
}

/** The writer's class (index-vectors.ts): the run's embedding profile, when the run's route names the same space. */
function runEmbeddingClass(runPipeline: PipelineFeatures | null, uri: string, dimension: number | null): string | null {
  if (!runPipeline) return null;
  try {
    const route = resolveEmbeddingRoute(runPipeline.embedding);
    if (embeddingRouteSpaceUri(route, dimension ?? route.dimensions) !== uri) return null;
  } catch {
    return null;
  }
  return modelClassLabel({ embeddingProfile: runPipeline.embedding.profile });
}

type Ctx = { sql: SqlClient; write: boolean; batchSize: number; statementTimeoutMs: number; lockTimeoutMs: number; log: (line: string) => void };

async function inBatch<T>(ctx: Ctx, work: (tx: SqlClient) => Promise<T>): Promise<T> {
  return await ctx.sql.begin(async (tx) => {
    const client = tx as unknown as SqlClient;
    if (!ctx.write) await client.unsafe("set transaction read only");
    await client.unsafe(`set local statement_timeout = ${Math.max(1, Math.floor(ctx.statementTimeoutMs))}`);
    await client.unsafe(`set local lock_timeout = ${Math.max(1, Math.floor(ctx.lockTimeoutMs))}`);
    return await work(client);
  }) as T;
}

/** Projects and runs read once per backfill. */
class Lookups {
  private projects = new Map<string, Indexing | { reason: string }>();
  private runs = new Map<string, { pipeline: PipelineFeatures | null }>();

  async project(tx: SqlClient, ids: string[]): Promise<Map<string, Indexing | { reason: string }>> {
    const missing = [...new Set(ids)].filter((id) => !this.projects.has(id));
    if (missing.length) {
      const rows = await tx<{ id: string; pipeline: unknown; index_configs: unknown }[]>`
        select id, pipeline, index_configs from projects where id in (select unnest(${missing}::text[]))
      `;
      for (const row of rows) this.projects.set(row.id, readProjectIndexing(row));
      for (const id of missing) if (!this.projects.has(id)) this.projects.set(id, { reason: "project-missing" });
    }
    return this.projects;
  }

  async run(tx: SqlClient, ids: Array<string | null>): Promise<Map<string, { pipeline: PipelineFeatures | null }>> {
    const missing = [...new Set(ids.filter((id): id is string => Boolean(id)))].filter((id) => !this.runs.has(id));
    if (missing.length) {
      const rows = await tx<{ id: string; pipeline: unknown }[]>`
        select id, pipeline from project_runs where id in (select unnest(${missing}::text[]))
      `;
      for (const row of rows) this.runs.set(row.id, { pipeline: parseRunPipeline(row.id, row.pipeline) });
      for (const id of missing) if (!this.runs.has(id)) this.runs.set(id, { pipeline: null });
    }
    return this.runs;
  }
}

/** Resolves a document's expected space for a vector row: project read path, then the bare-id and dimension checks. */
function resolveRowSpace(lookups: Map<string, Indexing | { reason: string }>, row: { project_id: string; index_config_hash: string | null }, embeddingModel: string, dimension: number | null) {
  const indexing = lookups.get(row.project_id);
  if (!indexing || "reason" in indexing) return { reason: indexing?.reason ?? "project-missing" };
  const embedding = servingEmbeddingFor(indexing, row.index_config_hash);
  if ("reason" in embedding) return embedding;
  return expectedSpaceUri(embedding, embeddingModel, dimension);
}

async function backfillVectorIndexes(ctx: Ctx, lookups: Lookups): Promise<TargetReport> {
  const report = emptyReport();
  let cursor = "";
  for (;;) {
    const done = await inBatch(ctx, async (tx) => {
      const rows = await tx<{ id: string; embedding_model: string; dimension: number; project_id: string; index_config_hash: string | null; run_id: string | null; class: string | null }[]>`
        select vi.id, vi.embedding_model, vi.dimension, d.project_id, d.index_config_hash, d.run_id, vi.embedding_model_class as class
        from vector_indexes vi join documents d on d.id = vi.document_id
        where vi.embedding_model_uri is null and vi.id > ${cursor}
        order by vi.id
        limit ${ctx.batchSize}
      `;
      if (rows.length === 0) return true;
      cursor = rows[rows.length - 1]!.id;
      report.scanned += rows.length;
      const projects = await lookups.project(tx, rows.map((row) => row.project_id));
      const runs = await lookups.run(tx, rows.map((row) => row.run_id));
      const ids: string[] = [], uris: string[] = [], classes: Array<string | null> = [], models: string[] = [], dims: number[] = [];
      for (const row of rows) {
        const space = resolveRowSpace(projects, row, row.embedding_model, row.dimension);
        if ("reason" in space) { bump(report.unmatched, space.reason); continue; }
        ids.push(row.id); uris.push(space.uri); models.push(row.embedding_model); dims.push(row.dimension);
        classes.push(row.class ?? runEmbeddingClass(row.run_id ? runs.get(row.run_id)?.pipeline ?? null : null, space.uri, row.dimension));
      }
      if (ids.length && ctx.write) {
        const updated = await tx`
          update vector_indexes v
          set embedding_model_uri = x.uri, embedding_model_class = coalesce(v.embedding_model_class, x.class)
          from unnest(${ids}::text[], ${uris}::text[], ${classes as string[]}::text[], ${models}::text[], ${dims}::int[]) as x(id, uri, class, model, dimension)
          where v.id = x.id and v.embedding_model_uri is null and v.embedding_model = x.model and v.dimension = x.dimension
        `;
        report.updated += updated.count;
      } else {
        report.updated += ids.length;
      }
      return rows.length < ctx.batchSize;
    });
    ctx.log(`[model-uri-backfill] vector-indexes scanned=${report.scanned} ${ctx.write ? "updated" : "would-update"}=${report.updated}`);
    if (done) break;
  }
  return report;
}

async function backfillPageStates(ctx: Ctx, lookups: Lookups): Promise<TargetReport> {
  const report = emptyReport();
  let cursor: [string, number] = ["", 0];
  for (;;) {
    const done = await inBatch(ctx, async (tx) => {
      const rows = await tx<{ document_id: string; page_number: number; embedding_model: string; project_id: string; index_config_hash: string | null }[]>`
        select s.document_id, s.page_number, s.embedding_model, d.project_id, d.index_config_hash
        from document_page_states s join documents d on d.id = s.document_id
        where s.embedding_model_uri is null and s.embedding_model is not null
          and (s.document_id, s.page_number) > (${cursor[0]}, ${cursor[1]})
        order by s.document_id, s.page_number
        limit ${ctx.batchSize}
      `;
      if (rows.length === 0) return true;
      const last = rows[rows.length - 1]!;
      cursor = [last.document_id, last.page_number];
      report.scanned += rows.length;
      const projects = await lookups.project(tx, rows.map((row) => row.project_id));
      const docs: string[] = [], pages: number[] = [], uris: string[] = [], models: string[] = [];
      for (const row of rows) {
        // No dimension on the row: the writer (materialize-pages.ts) records the route's own.
        const space = resolveRowSpace(projects, row, row.embedding_model, null);
        if ("reason" in space) { bump(report.unmatched, space.reason); continue; }
        docs.push(row.document_id); pages.push(row.page_number); uris.push(space.uri); models.push(row.embedding_model);
      }
      if (docs.length && ctx.write) {
        const updated = await tx`
          update document_page_states s set embedding_model_uri = x.uri
          from unnest(${docs}::text[], ${pages}::int[], ${uris}::text[], ${models}::text[]) as x(document_id, page_number, uri, model)
          where s.document_id = x.document_id and s.page_number = x.page_number and s.embedding_model_uri is null and s.embedding_model = x.model
        `;
        report.updated += updated.count;
      } else {
        report.updated += docs.length;
      }
      return rows.length < ctx.batchSize;
    });
    ctx.log(`[model-uri-backfill] page-states scanned=${report.scanned} ${ctx.write ? "updated" : "would-update"}=${report.updated}`);
    if (done) break;
  }
  return report;
}

async function backfillPageVectors(ctx: Ctx): Promise<TargetReport> {
  const report = emptyReport();
  let cursor: [string, number, string] = ["", 0, ""];
  for (;;) {
    const done = await inBatch(ctx, async (tx) => {
      const rows = await tx<{ document_id: string; page_number: number; model: string; dims: number }[]>`
        select document_id, page_number, model, dims from document_page_vectors
        where model_uri is null and (document_id, page_number, model) > (${cursor[0]}, ${cursor[1]}, ${cursor[2]})
        order by document_id, page_number, model
        limit ${ctx.batchSize}
      `;
      if (rows.length === 0) return true;
      const last = rows[rows.length - 1]!;
      cursor = [last.document_id, last.page_number, last.model];
      report.scanned += rows.length;
      const docs: string[] = [], pages: number[] = [], models: string[] = [], uris: string[] = [];
      for (const row of rows) {
        // The value the page-vector locator queries with for this model and vector length.
        const uri = pageQuerySpaceUri(row.model, row.dims);
        if (!uri) { bump(report.unmatched, "no-space-uri"); continue; }
        docs.push(row.document_id); pages.push(row.page_number); models.push(row.model); uris.push(uri);
      }
      if (docs.length && ctx.write) {
        const updated = await tx`
          update document_page_vectors v set model_uri = x.uri
          from unnest(${docs}::text[], ${pages}::int[], ${models}::text[], ${uris}::text[]) as x(document_id, page_number, model, uri)
          where v.document_id = x.document_id and v.page_number = x.page_number and v.model = x.model and v.model_uri is null
        `;
        report.updated += updated.count;
      } else {
        report.updated += docs.length;
      }
      return rows.length < ctx.batchSize;
    });
    ctx.log(`[model-uri-backfill] page-vectors scanned=${report.scanned} ${ctx.write ? "updated" : "would-update"}=${report.updated}`);
    if (done) break;
  }
  return report;
}

/** `withModelProvenance`'s URI for a stored usage row, or null when the row is not a model call. */
export function usageEventModelUri(row: { provider: string | null; model: string | null; modelConfig?: unknown; unitCharge?: unknown }): string | null {
  const metadata: Record<string, unknown> = {};
  if (row.modelConfig !== undefined && row.modelConfig !== null) metadata.modelConfig = row.modelConfig;
  if (row.unitCharge !== undefined && row.unitCharge !== null) metadata.unitCharge = row.unitCharge;
  const uri = withModelProvenance({ provider: row.provider, model: row.model, metadata }).metadata?.modelUri;
  return typeof uri === "string" ? uri : null;
}

async function backfillUsageEvents(ctx: Ctx): Promise<TargetReport> {
  const report = emptyReport();
  let cursor = "";
  for (;;) {
    const done = await inBatch(ctx, async (tx) => {
      const rows = await tx<{ id: string; provider: string; model: string; model_config: unknown; unit_charge: unknown }[]>`
        select id, provider, model, metadata -> 'modelConfig' as model_config, metadata -> 'unitCharge' as unit_charge
        from usage_events
        where id > ${cursor} and not (metadata ? 'modelUri')
        order by id
        limit ${ctx.batchSize}
      `;
      if (rows.length === 0) return true;
      cursor = rows[rows.length - 1]!.id;
      report.scanned += rows.length;
      const ids: string[] = [], uris: string[] = [];
      for (const row of rows) {
        const uri = usageEventModelUri({ provider: row.provider, model: row.model, modelConfig: row.model_config, unitCharge: row.unit_charge });
        if (!uri) { bump(report.skipped, "not-a-model-call"); continue; }
        ids.push(row.id); uris.push(uri);
      }
      if (ids.length && ctx.write) {
        // Only adds keys: an existing modelUri is never replaced, and no other field is touched.
        const updated = await tx`
          update usage_events u
          set metadata = u.metadata || jsonb_build_object('modelUri', x.uri, 'modelUriBackfilled', true)
          from unnest(${ids}::text[], ${uris}::text[]) as x(id, uri)
          where u.id = x.id and jsonb_typeof(u.metadata) = 'object' and not (u.metadata ? 'modelUri')
        `;
        report.updated += updated.count;
      } else {
        report.updated += ids.length;
      }
      return rows.length < ctx.batchSize;
    });
    ctx.log(`[model-uri-backfill] usage-events scanned=${report.scanned} ${ctx.write ? "updated" : "would-update"}=${report.updated}`);
    if (done) break;
  }
  return report;
}

export interface BackfilledRunModel {
  uri: string;
  class?: string;
  /** Derived from usage after the fact, not resolved by the worker when the run started. */
  backfilled: true;
  /** Other models the service's usage named (the entry is the one with the most input tokens). */
  otherModels?: number;
}

type RunUsageRow = { run_id: string; metric: string; provider: string; model: string; input_tokens: number | string };
type RunVectorRow = { run_id: string; embedding_model: string; uri: string; class: string | null };

/**
 * A run's `resolved_models` from its usage (worker shape, resolved-models.ts, plus `backfilled`): per service the model
 * with the most input tokens. `embedding` is the vector space the run's documents were indexed into (the worker names
 * the space, `llm://…?dimensions=N`), only when exactly one is recorded and the run's embedding usage names its model.
 */
export function deriveResolvedModels(
  usage: readonly Omit<RunUsageRow, "run_id">[],
  vectors: readonly Omit<RunVectorRow, "run_id">[],
  runPipeline: PipelineFeatures | null,
): { models: Record<string, BackfilledRunModel>; notes: string[] } {
  const notes: string[] = [];
  const byService = new Map<string, Map<string, { tokens: number; model: string }>>();
  for (const row of usage) {
    const service = RESOLVED_MODEL_SERVICE_BY_METRIC[row.metric];
    if (!service || !usageEventModelUri({ provider: row.provider, model: row.model })) continue;
    // The worker names a service's model without its call settings.
    const uri = service === "embedding" ? `${row.provider}\u0000${row.model}` : modelRecordUri({ provider: row.provider, model: row.model });
    if (!uri) continue;
    const models = byService.get(service) ?? new Map<string, { tokens: number; model: string }>();
    const entry = models.get(uri) ?? { tokens: 0, model: row.model };
    entry.tokens += Number(row.input_tokens) || 0;
    models.set(uri, entry);
    byService.set(service, models);
  }
  const out: Record<string, BackfilledRunModel> = {};
  for (const [service, models] of byService) {
    const ranked = [...models].sort(([a, x], [b, y]) => y.tokens - x.tokens || a.localeCompare(b));
    const [topKey, top] = ranked[0]!;
    const otherModels = ranked.length - 1;
    if (otherModels > 0) notes.push(`${service}-multiple-models`);
    let entry: BackfilledRunModel;
    if (service === "embedding") {
      const spaces = new Map(vectors.map((row) => [row.uri, row]));
      if (spaces.size !== 1) { notes.push(spaces.size ? "embedding-multiple-spaces" : "embedding-no-recorded-space"); continue; }
      const [space] = spaces.values();
      if (space!.embedding_model !== top.model) { notes.push("embedding-usage-vector-mismatch"); continue; }
      entry = { uri: space!.uri, ...(space!.class ? { class: space!.class } : {}), backfilled: true };
    } else {
      const cls = service === "vision" ? modelClassLabel({ visionProfile: runPipeline?.vision?.profile, quality: runPipeline?.quality }) : null;
      entry = { uri: topKey, ...(cls ? { class: cls } : {}), backfilled: true };
    }
    if (otherModels > 0) entry.otherModels = otherModels;
    out[service] = entry;
  }
  return { models: out, notes };
}

async function backfillRuns(ctx: Ctx, lookups: Lookups): Promise<TargetReport> {
  const report: TargetReport = { ...emptyReport(), notes: {} };
  const metrics = Object.keys(RESOLVED_MODEL_SERVICE_BY_METRIC);
  let cursor = "";
  for (;;) {
    const done = await inBatch(ctx, async (tx) => {
      const runs = await tx<{ id: string }[]>`
        select id from project_runs where resolved_models is null and id > ${cursor} order by id limit ${ctx.batchSize}
      `;
      if (runs.length === 0) return true;
      cursor = runs[runs.length - 1]!.id;
      report.scanned += runs.length;
      const ids = runs.map((run) => run.id);
      const usage = await tx<RunUsageRow[]>`
        select run_id, metric, provider, model, sum(input_tokens)::bigint as input_tokens
        from usage_events
        where run_id in (select unnest(${ids}::text[])) and metric in (select unnest(${metrics}::text[]))
        group by run_id, metric, provider, model
      `;
      const vectors = await tx<RunVectorRow[]>`
        select distinct d.run_id, vi.embedding_model, vi.embedding_model_uri as uri, vi.embedding_model_class as class
        from documents d join vector_indexes vi on vi.document_id = d.id
        where d.run_id in (select unnest(${ids}::text[])) and vi.embedding_model_uri is not null
      `;
      const pipelines = await lookups.run(tx, ids);
      const writeIds: string[] = [], values: string[] = [];
      for (const id of ids) {
        const { models, notes } = deriveResolvedModels(usage.filter((row) => row.run_id === id), vectors.filter((row) => row.run_id === id), pipelines.get(id)?.pipeline ?? null);
        for (const note of notes) bump(report.notes!, note);
        if (Object.keys(models).length === 0) { bump(report.skipped, "no-derivable-model"); continue; }
        writeIds.push(id); values.push(JSON.stringify(models));
      }
      if (writeIds.length && ctx.write) {
        // Only resolved_models changes: no trigger on project_runs watches it, and updated_at is left alone.
        const updated = await tx`
          update project_runs r set resolved_models = x.models::jsonb
          from unnest(${writeIds}::text[], ${values}::text[]) as x(id, models)
          where r.id = x.id and r.resolved_models is null
        `;
        report.updated += updated.count;
      } else {
        report.updated += writeIds.length;
      }
      return runs.length < ctx.batchSize;
    });
    ctx.log(`[model-uri-backfill] runs scanned=${report.scanned} ${ctx.write ? "updated" : "would-update"}=${report.updated}`);
    if (done) break;
  }
  return report;
}

async function backfillPageExtracts(ctx: Ctx, lookups: Lookups): Promise<TargetReport> {
  const report = emptyReport();
  let cursor: [string, number, string, string] = ["", 0, "", ""];
  for (;;) {
    const done = await inBatch(ctx, async (tx) => {
      const rows = await tx<{ document_id: string; page_number: number; run_id: string; pass: string; method: string; engine: string | null }[]>`
        select document_id, page_number, run_id, pass, method, engine from document_page_extracts
        where model_uri is null and (document_id, page_number, run_id, pass) > (${cursor[0]}, ${cursor[1]}, ${cursor[2]}, ${cursor[3]})
        order by document_id, page_number, run_id, pass
        limit ${ctx.batchSize}
      `;
      if (rows.length === 0) return true;
      const last = rows[rows.length - 1]!;
      cursor = [last.document_id, last.page_number, last.run_id, last.pass];
      report.scanned += rows.length;
      // Only a vision-model read names a model this backfill can prove; text layers, OCR engines and corrections do not.
      const reads = rows.filter((row) => row.pass === "vision" && row.method === "vision" && row.engine === "vision-model");
      const readSet = new Set(reads);
      for (const row of rows) if (!readSet.has(row)) bump(report.skipped, `no-model-pass:${row.pass}/${row.method}`);
      if (reads.length === 0) return rows.length < ctx.batchSize;
      const pairs = [...new Set(reads.map((row) => `${row.run_id}\u0000${row.document_id}`))].map((key) => key.split("\u0000") as [string, string]);
      const usage = await tx<{ run_id: string; document_id: string; provider: string; model: string }[]>`
        select distinct e.run_id, coalesce(e.document_id, e.metadata ->> 'documentId') as document_id, e.provider, e.model
        from usage_events e
        join unnest(${pairs.map(([run]) => run)}::text[], ${pairs.map(([, doc]) => doc)}::text[]) as p(run_id, document_id)
          on e.run_id = p.run_id and coalesce(e.document_id, e.metadata ->> 'documentId') = p.document_id
        where e.metric = ${VISION_READ_METRIC}
      `;
      const runs = await lookups.run(tx, reads.map((row) => row.run_id));
      const modelsFor = new Map<string, Set<string>>();
      for (const row of usage) {
        if (!usageEventModelUri(row)) continue;
        const uri = modelRecordUri({ provider: row.provider, model: row.model });
        if (!uri) continue;
        const key = `${row.run_id}\u0000${row.document_id}`;
        modelsFor.set(key, (modelsFor.get(key) ?? new Set()).add(uri));
      }
      const docs: string[] = [], pages: number[] = [], runIds: string[] = [], passes: string[] = [], uris: string[] = [], classes: Array<string | null> = [];
      for (const row of reads) {
        const models = modelsFor.get(`${row.run_id}\u0000${row.document_id}`);
        if (!models || models.size === 0) { bump(report.unmatched, "no-vision-usage"); continue; }
        if (models.size > 1) { bump(report.unmatched, "multiple-vision-models"); continue; }
        docs.push(row.document_id); pages.push(row.page_number); runIds.push(row.run_id); passes.push(row.pass);
        uris.push([...models][0]!);
        // The writer's class: the run's levels as its usage ledger records them (page-extracts.ts).
        classes.push(modelClassLabel(runModelClass(runs.get(row.run_id)?.pipeline ?? null)));
      }
      if (docs.length && ctx.write) {
        const updated = await tx`
          update document_page_extracts e set model_uri = x.uri, model_class = coalesce(e.model_class, x.class)
          from unnest(${docs}::text[], ${pages}::int[], ${runIds}::text[], ${passes}::text[], ${uris}::text[], ${classes as string[]}::text[])
            as x(document_id, page_number, run_id, pass, uri, class)
          where e.document_id = x.document_id and e.page_number = x.page_number and e.run_id = x.run_id and e.pass = x.pass
            and e.model_uri is null
        `;
        report.updated += updated.count;
      } else {
        report.updated += docs.length;
      }
      return rows.length < ctx.batchSize;
    });
    ctx.log(`[model-uri-backfill] page-extracts scanned=${report.scanned} ${ctx.write ? "updated" : "would-update"}=${report.updated}`);
    if (done) break;
  }
  return report;
}

/** Runs the backfill for the given targets in dependency order (vector URIs before run maps). */
export async function backfillModelUris(sql: SqlClient, options: ModelUriBackfillOptions = {}): Promise<ModelUriBackfillReport> {
  const targets = new Set(options.targets ?? MODEL_URI_BACKFILL_TARGETS);
  const batchSize = Math.max(1, Math.min(10_000, Math.floor(options.batchSize ?? 2_000)));
  const ctx: Ctx = {
    sql,
    write: options.write === true,
    batchSize,
    statementTimeoutMs: options.statementTimeoutMs ?? 30_000,
    lockTimeoutMs: options.lockTimeoutMs ?? 5_000,
    log: options.log ?? ((line) => console.error(line)),
  };
  const lookups = new Lookups();
  const report: ModelUriBackfillReport = { mode: ctx.write ? "write" : "dry-run", batchSize };
  if (targets.has("vector-indexes")) report["vector-indexes"] = await backfillVectorIndexes(ctx, lookups);
  if (targets.has("page-states")) report["page-states"] = await backfillPageStates(ctx, lookups);
  if (targets.has("page-vectors")) report["page-vectors"] = await backfillPageVectors(ctx);
  if (targets.has("usage-events")) report["usage-events"] = await backfillUsageEvents(ctx);
  if (targets.has("runs")) report.runs = await backfillRuns(ctx, lookups);
  if (targets.has("page-extracts")) report["page-extracts"] = await backfillPageExtracts(ctx, lookups);
  return report;
}
