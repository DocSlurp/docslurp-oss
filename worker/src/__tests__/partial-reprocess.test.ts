import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import {
  compilePipelinePlan,
  defaultPipelineFeatures,
  pipelineStageOrder,
  type PipelineFeatures,
} from "@docslurp/shared";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../config.js";
import { Store } from "../db/store.js";
import type { ArtifactStore } from "../tools/storage.js";
import { runDocumentStage, runDocuments } from "../pipeline/checkpoints.js";
import type { Stage } from "../pipeline/pipeline.js";
import { createStageExecution } from "../pipeline/stage-execution.js";
import { resolvePipelineWorkflowStageOrder } from "../temporal/pipeline-workflow-plan.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Partial reprocess end to end on a migrated database: the worker seeds the
 * stages a restartFromStage / stageSubset run skips from the source document,
 * executes only the planned stages, and bills only those.
 */
const config = { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config;

let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  store = new Store(`postgres://postgres@127.0.0.1:${port}/postgres`, 60_000, {
    poolMax: 1,
    workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 },
  });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  await sql`delete from usage_events`;
  await sql`delete from document_chunks`;
  await sql`delete from document_pages`;
  await sql`delete from document_run_stage_states`;
  await sql`delete from documents`;
  await sql`delete from workspace_runs`;
});

/** A completed source run whose document went through every enabled stage. */
async function seedSourceRun(pipeline: PipelineFeatures) {
  const artifacts = {
    "src:markdown": "s3://b/u1/run-src/markdown/src.md",
    "src:canonical-document": "s3://b/u1/run-src/canonical/src.json",
    "src:normalizedFormat": "pdf",
    "src:embeddings": "s3://b/u1/run-src/embeddings/src.json",
    "other:markdown": "s3://b/u1/run-src/markdown/other.md",
  };
  await sql`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, artifacts, total_documents, pages_total)
    values ('run-src', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'completed', ${sql.json(pipeline as unknown as postgres.JSONValue)},
      ${sql.json(artifacts)}, 1, 2)
  `;
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
    values ('src', 'o1', 'u1', 'w', 'run-src', 'a.pdf', 'application/pdf', 'raw/a.pdf', 'completed', 2)
  `;
  for (const stage of compilePipelinePlan(pipeline).stageOrder) {
    await sql`
      insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, artifact_uri, stats, completed_at)
      values ('run-src', 'src', ${stage}, 'completed', 1, ${`s3://b/u1/run-src/${stage}/src`}, '{}'::jsonb, now())
    `;
  }
  await sql`insert into document_pages (id, document_id, run_id, user_id, page_number, text) values ('src-p1', 'src', 'run-src', 'u1', 1, 'page one')`;
  await sql`
    insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, page_number, parent_page_id)
    values ('src-000', 'src', 'run-src', 'u1', 0, 'prior chunk', 1, 'src-p1')
  `;
  await sql`
    insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, metadata)
    values ('src-usage', 'u1', 'run-src', 'openai', 'vision', 'vision-tokens', 100, 'token', 5, '{}'::jsonb)
  `;
}

async function seedPartialRun(pipeline: PipelineFeatures, reusedFrom: string | null = "src") {
  await sql`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
    values ('run-re', 'o1', 'u1', 'w', 'bulk-upload', 'queued', 'queued', ${sql.json(pipeline as unknown as postgres.JSONValue)}, 1, 2)
  `;
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count,
      previous_version_id, reused_from_document_id)
    values ('re', 'o1', 'u1', 'w', 'run-re', 'a.pdf', 'application/pdf', 'raw/a.pdf', 'queued', 2, 'src', ${reusedFrom})
  `;
}

/** Fake stages for every pipeline stage; they log what they run and the inputs they read. */
function recordingStages() {
  const executed: string[] = [];
  const inputs: Record<string, string | undefined> = {};
  const stages: Stage[] = pipelineStageOrder.map((name) => ({
    name,
    async run(state, signal) {
      executed.push(name);
      await runDocuments(state.documents, 1, async (document) => {
        const slot = name === "embed" ? `${document.id}:embeddings` : `${document.id}:${name}`;
        await runDocumentStage(state, document, name, slot, `${name} ready`, async () => {
          if (name === "embed") {
            inputs.embedMarkdown = state.artifactLedger.readDocument(document.id, "markdown");
            inputs.embedCanonical = state.artifactLedger.readDocument(document.id, "canonical-document");
            state.usageLedger.record({
              provider: "openai", model: "text-embedding-3-small", metric: "embedding-tokens",
              amount: 40, unit: "token", inputTokens: 40, costCents: 0.01,
              metadata: { documentId: document.id },
            });
            return { artifactUri: `s3://b/u1/${state.run.id}/embeddings/${document.id}.json` };
          }
          if (name === "index") inputs.indexEmbeddings = state.artifactLedger.readDocument(document.id, "embeddings");
          if (name === "page-index") inputs.pageIndexMarkdown = state.artifactLedger.readDocument(document.id, "markdown");
          return { artifactUri: `s3://b/u1/${state.run.id}/${name}/${document.id}` };
        }, signal);
      });
    },
  }));
  return { stages, executed, inputs };
}

/** Drives Stage Execution the way the documentPipeline workflow does. */
async function runWorkflow(stages: Stage[], pipeline: PipelineFeatures) {
  const stageOrder = resolvePipelineWorkflowStageOrder({ stageOrder: compilePipelinePlan(pipeline).stageOrder });
  const execution = createStageExecution({ store, stages, config });
  const runtime = { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1, heartbeatIntervalMs: 3_600_000 };
  let { artifacts } = await execution.startRun({ runId: "run-re", totalStages: stageOrder.length });
  for (const stageName of stageOrder) {
    const result = await execution.runStage({ stageName, runId: "run-re", totalStages: stageOrder.length, artifacts }, runtime);
    artifacts = { ...artifacts, ...result.artifacts };
  }
  await execution.completeRun({ runId: "run-re" });
  return { stageOrder, artifacts };
}

describe("partial reprocess", () => {
  it("reindex (stageSubset embed+index) runs only embed and index on the source document's extraction", async () => {
    await seedSourceRun(defaultPipelineFeatures);
    const pipeline = { ...defaultPipelineFeatures, stageSubset: ["embed", "index"] };
    await seedPartialRun(pipeline);
    const { stages, executed, inputs } = recordingStages();

    const { stageOrder, artifacts } = await runWorkflow(stages, pipeline);

    expect(stageOrder).toEqual(["embed", "index"]);
    expect(executed).toEqual(["embed", "index"]);
    // embed reads the source document's extraction, re-keyed to the new document.
    expect(inputs.embedMarkdown).toBe("s3://b/u1/run-src/markdown/src.md");
    expect(inputs.embedCanonical).toBe("s3://b/u1/run-src/canonical/src.json");
    // index reads the embedding artifact embed wrote in this run, not the source's.
    expect(inputs.indexEmbeddings).toBe("s3://b/u1/run-re/embeddings/re.json");
    expect(artifacts["re:normalizedFormat"]).toBe("pdf");
    expect(Object.keys(artifacts).some((key) => key.startsWith("other:"))).toBe(false);

    // Skipped stages are checkpointed as reused; executed ones as this run's work.
    const states = await sql<{ stage_name: string; reused: boolean }[]>`
      select stage_name, coalesce((stats->>'reused')::boolean, false) as reused
      from document_run_stage_states where run_id = 'run-re' and document_id = 're'
    `;
    const byStage = new Map(states.map((row) => [row.stage_name, row.reused]));
    expect(byStage.get("extract-markdown")).toBe(true);
    expect(byStage.get("quarantine")).toBe(true);
    expect(byStage.get("embed")).toBe(false);
    expect(byStage.get("index")).toBe(false);

    // Only executed stages are billed: no usage copied from the source run, and
    // local compute only for embed and index.
    const usage = await sql<{ metric: string; stage: string | null }[]>`
      select metric, metadata->>'stage' as stage from usage_events where run_id = 'run-re' order by metric, stage
    `;
    expect(usage.filter((row) => row.metric === "worker-stage").map((row) => row.stage).sort()).toEqual(["embed", "index"]);
    expect(usage.map((row) => row.metric)).not.toContain("vision-tokens");
    expect(usage.filter((row) => row.metric === "embedding-tokens")).toHaveLength(1);

    const [run] = await sql<{ status: string }[]>`select status from workspace_runs where id = 'run-re'`;
    expect(run?.status).toBe("completed");
    // The run start pinned the legacy vision routing version in the persisted run artifacts.
    expect(artifacts["run:vision-routing-version"]).toBe("v1");
    const [pinned] = await sql<{ version: string | null }[]>`
      select artifacts->>'run:vision-routing-version' as version from workspace_runs where id = 'run-re'`;
    expect(pinned?.version).toBe("v1");
  }, 60_000);

  it("restartFromStage reuses earlier stages' rows, including prior chunks when embed is skipped", async () => {
    const base = { ...defaultPipelineFeatures, indexVectors: false, pageIndex: true };
    await seedSourceRun(base);
    const pipeline = { ...base, restartFromStage: "page-index" };
    await seedPartialRun(pipeline);
    const { stages, executed, inputs } = recordingStages();

    await runWorkflow(stages, pipeline);

    expect(executed).toEqual(["page-index"]);
    expect(inputs.pageIndexMarkdown).toBe("s3://b/u1/run-src/markdown/src.md");
    const chunks = await sql<{ text: string; run_id: string }[]>`select text, run_id from document_chunks where document_id = 're'`;
    expect(chunks).toEqual([{ text: "prior chunk", run_id: "run-re" }]);
    // Copied chunks are complete at run start, so keyword search may serve them early.
    const [marked] = await sql<{ lexical: boolean }[]>`select lexical_searchable_at is not null as lexical from documents where id = 're'`;
    expect(marked?.lexical).toBe(true);

    // Seeding is idempotent: a retried run start copies nothing twice.
    const plan = compilePipelinePlan(pipeline);
    await store.seedReusedStageOutputs("run-re", plan.reusedStages);
    expect(await sql`select id from document_chunks where document_id = 're'`).toHaveLength(1);
  }, 60_000);

  it("retention skips a source run while a partial run reuses it, and run start re-checks after a purge", async () => {
    await seedSourceRun(defaultPipelineFeatures);
    await sql`update workspaces set artifact_retention_days = 1 where id = 'w'`;
    await sql`update workspace_runs set created_at = now() - interval '10 days' where id = 'run-src'`;
    const pipeline = { ...defaultPipelineFeatures, restartFromStage: "embed" };
    await seedPartialRun(pipeline);
    const deleted: string[] = [];
    const storage = { bucket: "b", deleteKeys: async (keys: string[]) => { deleted.push(...keys); } } as unknown as ArtifactStore;
    const purge = () => (store as unknown as {
      purgeExpiredArtifacts(storage: ArtifactStore, batchSize: number): Promise<void>;
    }).purgeExpiredArtifacts(storage, 10);

    try {
      await purge();
      expect(deleted).toEqual([]);
      expect(await sql`select id from workspace_runs where artifacts_purged_at is not null`).toEqual([]);

      // Once the reusing run is terminal, retention proceeds as usual.
      await sql`update workspace_runs set status = 'failed' where id = 'run-re'`;
      await purge();
      expect(deleted).toContain("u1/run-src/markdown/src.md");

      // A run created before the purge finds the artifacts gone and fails clearly.
      await sql`update workspace_runs set status = 'queued' where id = 'run-re'`;
      const { stages, executed } = recordingStages();
      const execution = createStageExecution({ store, stages, config });
      await expect(execution.startRun({ runId: "run-re", totalStages: 2 }))
        .rejects.toThrow(/purged by retention.*Reprocess every stage instead/);
      expect(executed).toEqual([]);
    } finally {
      await sql`update workspaces set artifact_retention_days = null where id = 'w'`;
    }
  }, 60_000);

  it("fails the run start instead of running everything when no source document is linked", async () => {
    await seedSourceRun(defaultPipelineFeatures);
    const pipeline = { ...defaultPipelineFeatures, restartFromStage: "embed" };
    await seedPartialRun(pipeline, null);
    const { stages, executed } = recordingStages();
    const execution = createStageExecution({ store, stages, config });

    await expect(execution.startRun({ runId: "run-re", totalStages: 2 })).rejects.toThrow(/has no source document/);
    expect(executed).toEqual([]);
  }, 60_000);
});
