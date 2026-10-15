import { defaultPipelineFeatures } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * reprocessRun against a database built from server/db/migrations: the partial
 * reprocess validation reads real run, document and artifact rows.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let reprocessRun: typeof import("../services/runs.js").reprocessRun;
let isReprocessRejectedError: typeof import("../services/runs.js").isReprocessRejectedError;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  // One connection (the PGlite socket serves one at a time), with the app client's numeric parsing (src/api/db.ts).
  sql = postgres(pg.url, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 1000)`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner')`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W')`;
  ({ reprocessRun, isReprocessRejectedError } = await import("../services/runs.js"));
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  await sql`delete from documents`;
  await sql`delete from workspace_runs`;
});

const extraction = {
  "src:markdown": "s3://b/u1/run-src/markdown/src.md",
  "src:canonical-document": "s3://b/u1/run-src/canonical/src.json",
};

async function seedSource(args: { artifacts?: Record<string, string>; docStatus?: string; artifactsPurged?: boolean } = {}) {
  await sql`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, artifacts,
      total_documents, pages_total, artifacts_purged_at)
    values ('run-src', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'completed',
      ${sql.json(defaultPipelineFeatures as unknown as postgres.JSONValue)}, ${sql.json(args.artifacts ?? extraction)},
      1, 2, ${args.artifactsPurged ? new Date() : null})
  `;
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status,
      page_count, source_sha256)
    values ('src', 'o1', 'u1', 'w', 'run-src', 'a.pdf', 'application/pdf', 'raw/a.pdf', ${args.docStatus ?? "completed"},
      2, 'sha-a')
  `;
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(isReprocessRejectedError(error)).toBe(true);
  return error as { statusCode: number; code: string; details: Record<string, unknown> };
}

const runCount = async () => Number((await sql<{ n: number }[]>`select count(*)::int as n from workspace_runs`)[0]?.n);

describe("reprocessRun", () => {
  it("creates a partial run whose documents reuse the source versions", async () => {
    await seedSource();

    const run = await reprocessRun("run-src", "u1", { stageFrom: "embed" });

    expect(run?.pipeline.restartFromStage).toBe("embed");
    const [doc] = await sql<{ reused_from_document_id: string; previous_version_id: string; source_sha256: string }[]>`
      select reused_from_document_id, previous_version_id, source_sha256 from documents where run_id = ${run!.id}
    `;
    expect(doc).toEqual({ reused_from_document_id: "src", previous_version_id: "src", source_sha256: "sha-a" });
  });

  it("does not link a source for a full reprocess", async () => {
    await seedSource();
    const run = await reprocessRun("run-src", "u1");
    expect(run?.pipeline.restartFromStage).toBeUndefined();
    const [doc] = await sql<{ reused_from_document_id: string | null }[]>`
      select reused_from_document_id from documents where run_id = ${run!.id}
    `;
    expect(doc?.reused_from_document_id).toBeNull();
  });

  it("rejects with 409 when the source lacks inputs the executed stages read", async () => {
    await seedSource({ artifacts: { "src:normalizedFormat": "pdf" } });

    const error = await rejection(reprocessRun("run-src", "u1", { stages: ["embed", "index"] }));

    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("missing_stage_artifacts");
    expect(error.details.missing).toEqual([
      { documentId: "src", stage: "embed", anyOf: ["markdown", "canonical-document"] },
    ]);
    expect(await runCount()).toBe(1);
  });

  it("rejects with 409 when a source document did not complete", async () => {
    await seedSource({ docStatus: "failed" });
    const error = await rejection(reprocessRun("run-src", "u1", { stageFrom: "embed" }));
    expect(error).toMatchObject({ statusCode: 409, code: "source_not_reusable" });
    expect(await runCount()).toBe(1);
  });

  it("rejects with 409 when retention purged the source run's artifacts", async () => {
    await seedSource({ artifactsPurged: true });
    const error = await rejection(reprocessRun("run-src", "u1", { stages: ["embed", "index"] }));
    expect(error).toMatchObject({ statusCode: 409, code: "source_not_reusable", details: { reason: "artifacts_purged" } });
  });

  it("rejects with 400 when no requested stage is enabled", async () => {
    await seedSource();
    // page-index is disabled in the default pipeline.
    const error = await rejection(reprocessRun("run-src", "u1", { stages: ["page-index"] }));
    expect(error).toMatchObject({ statusCode: 400, code: "no_stages_to_run" });
    expect(await runCount()).toBe(1);
  });

  it("restarting from extraction needs no source artifacts", async () => {
    await seedSource({ artifacts: {} });
    const run = await reprocessRun("run-src", "u1", { stageFrom: "extract-markdown" });
    expect(run?.pipeline.restartFromStage).toBe("extract-markdown");
  });
});
