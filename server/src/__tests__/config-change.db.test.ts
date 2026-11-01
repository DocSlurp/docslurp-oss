import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures, type PipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let change: typeof import("../services/config-change.js");
let failLease: "none" | "throw-after-grant" | "refuse" = "none";
beforeAll(async () => {
  // A real migrated database is required for concurrent transactions. PGlite's
  // socket serves one connection, so ordinary local runs retain its max: 1.
  const databaseUrl = process.env.CONFIG_CHANGE_TEST_DATABASE_URL;
  const pg = databaseUrl ? null : await startMigratedPostgres();
  stop = pg?.stop ?? (async () => {});
  sql = postgres(databaseUrl ?? pg!.url, { max: databaseUrl ? 2 : 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/billing/credit-leases.js", async () => {
    const actual = await vi.importActual<typeof import("../services/billing/credit-leases.js")>("../services/billing/credit-leases.js");
    return { ...actual, grantRunCreditLease: async (...args: Parameters<typeof actual.grantRunCreditLease>) => {
      if (failLease === "refuse") return null;
      const result = await actual.grantRunCreditLease(...args);
      if (failLease === "throw-after-grant") throw new Error("injected failure after lease write");
      return result;
    } };
  });
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'config-admission@example.com') on conflict (id) do nothing`;
  change = await import("../services/config-change.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => { failLease = "none"; vi.stubEnv("WORKER_CREDIT_LEASES", "off"); });

const pipeline = (patch: Partial<PipelineFeatures> = {}): PipelineFeatures => ({ ...defaultPipelineFeatures, ...patch });

async function seed(args: { credits: number; autoConfirm?: boolean; documents?: number; vectorized?: boolean }) {
  await sql`delete from workspace_runs`;
  await sql`delete from documents`;
  await sql`delete from workspaces`;
  await sql`delete from organizations`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', ${args.credits})`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner')`;
  await sql`insert into workspaces(id, org_id, user_id, name, pipeline, auto_confirm_reindex)
    values ('w', 'o1', 'u1', 'W', ${sql.json(JSON.parse(JSON.stringify(pipeline())))}, ${args.autoConfirm ?? false})`;
  await sql`insert into workspace_search_settings(workspace_id, user_id) values ('w', 'u1') on conflict do nothing`.catch(() => undefined);
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, artifacts)
    values ('src', 'o1', 'u1', 'w', 'upload', 'completed', 'index', ${sql.json(JSON.parse(JSON.stringify(pipeline())))}, ${args.documents ?? 2}, ${sql.json(Object.fromEntries(Array.from({ length: args.documents ?? 2 }, (_, i) => [`d${i}:markdown`, `s3://b/d${i}.md`])))})`;
  for (let i = 0; i < (args.documents ?? 2); i += 1) {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id)
      values (${`d${i}`}, 'o1', 'u1', 'w', 'src', ${`f${i}.pdf`}, 'application/pdf', ${`k${i}`}, 'completed', 5, ${`c${i}`})`;
    if (args.vectorized) {
      await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
        values (${`v${i}`}, ${`d${i}`}, 'lancedb', 'b', 'p', 'm', 384)`;
    }
  }
}

const embeddingChange = () => ({ pipeline: pipeline({ embedding: { ...defaultPipelineFeatures.embedding, target: "local" as const, modelUri: "llm://transformers.js/Xenova/gte-small" as never } }) });

async function patch(input: Record<string, unknown>) {
  const plan = await change.planWorkspaceChange({ workspaceId: "w", userId: "u1", input: input as never });
  expect(plan).not.toBeNull();
  return { plan: plan!, applied: await change.applyWorkspaceChange({ plan: plan!, userId: "u1" }) };
}


async function splitSourceRuns() {
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, artifacts_purged_at)
    values ('src-purged', 'o1', 'u1', 'w', 'upload', 'completed', 'index', ${sql.json(JSON.parse(JSON.stringify(pipeline())))}, 1, now())`;
  await sql`update documents set run_id = 'src-purged' where id = 'd1'`;
}

describe("config-change transactional credit admission", () => {
  it.each([undefined, false, true])("uses the trusted request opt-in at low balance (%s)", async (speedBoost) => {
    await seed({ credits: 103 });
    const { applied } = await patch({ ...embeddingChange(), ...(speedBoost === undefined ? {} : { speedBoost }) });
    const runs = await sql`select id, status, blocked_reason, pipeline from workspace_runs where kind = 'reindex'`;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.pipeline.speedBoost).toBe(speedBoost === true);
    expect(runs[0]!.status).toBe(speedBoost ? "blocked" : "queued");
    expect(applied!.queuedRunIds).toEqual(speedBoost ? [] : [runs[0]!.id]);
    expect(applied!.workspace.pipeline.embedding.modelUri).toBe(embeddingChange().pipeline.embedding.modelUri);
  });

  it("admits each batch against earlier reservations and reports only queued IDs", async () => {
    await seed({ credits: 105 });
    await splitSourceRuns();
    const { applied } = await patch({ ...embeddingChange(), speedBoost: true });
    const runs = await sql`select id, status from workspace_runs where kind = 'reindex'`;
    expect(runs).toHaveLength(2);
    expect(runs.filter(r => r.status === "queued")).toHaveLength(1);
    expect(runs.filter(r => r.status === "blocked")).toHaveLength(1);
    expect(applied!.queuedRunIds).toEqual(runs.filter(r => r.status === "queued").map(r => r.id));
    expect(applied!.job!.runIds).toHaveLength(2);
  });

  it.skipIf(!process.env.CONFIG_CHANGE_TEST_DATABASE_URL)("serializes concurrent boosted admissions across workspaces in one organization", async () => {
    await seed({ credits: 105, documents: 1 });
    await sql`insert into workspaces(id, org_id, user_id, name, pipeline)
      values ('w2', 'o1', 'u1', 'Second', ${sql.json(JSON.parse(JSON.stringify(pipeline())))})`;
    await sql`insert into workspace_search_settings(workspace_id, user_id) values ('w2', 'u1')`;
    await sql`insert into workspace_runs(id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, artifacts)
      values ('src2', 'o1', 'u1', 'w2', 'upload', 'completed', 'index', ${sql.json(JSON.parse(JSON.stringify(pipeline())))}, 1,
        ${sql.json({ "d2:markdown": "s3://b/d2.md" })})`;
    await sql`insert into documents(id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id)
      values ('d2', 'o1', 'u1', 'w2', 'src2', 'second.pdf', 'application/pdf', 'k2', 'completed', 5, 'c2')`;
    const plans = await Promise.all(["w", "w2"].map(workspaceId => change.planWorkspaceChange({
      workspaceId, userId: "u1", input: { ...embeddingChange(), speedBoost: true },
    })));
    expect(plans.every(Boolean)).toBe(true);
    // Different workspace locks and two connections let the org admission lock
    // arbitrate these requests; neither request supersedes the other's job.
    const results = await Promise.all(plans.map(plan => change.applyWorkspaceChange({ plan: plan!, userId: "u1" })));
    const runs = await sql`select id, status, workspace_id from workspace_runs where kind = 'reindex' and org_id = 'o1'`;
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map(run => run.workspace_id)).size).toBe(2);
    expect(runs.filter(run => run.status === "queued")).toHaveLength(1);
    expect(runs.filter(run => run.status === "blocked")).toHaveLength(1);
    expect(results.flatMap(result => result!.queuedRunIds)).toEqual(runs.filter(run => run.status === "queued").map(run => run.id));
    const [spend] = await sql`select reserved from org_spend_status('o1', null, 1)`;
    expect(Number(spend!.reserved)).toBe(4);
  });

  it.each(["throw-after-grant", "refuse"] as const)("fails closed when lease acquisition %s", async (mode) => {
    vi.stubEnv("WORKER_CREDIT_LEASES", "on");
    await seed({ credits: 1000 });
    failLease = mode;
    const { applied } = await patch({ ...embeddingChange(), speedBoost: true });
    const runs = await sql`select id, status, blocked_reason from workspace_runs where kind = 'reindex'`;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "blocked", blocked_reason: "credits" });
    expect(applied!.queuedRunIds).toEqual([]);
    const leases = await sql`select * from credit_leases where holder_kind = 'run' and holder_id = ${runs[0]!.id} and status = 'active'`;
    expect(leases).toHaveLength(0);
    expect(applied!.workspace.pipeline.embedding.modelUri).toBe(embeddingChange().pipeline.embedding.modelUri);
  });
});
