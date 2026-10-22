import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures, estimatePipelineWork } from "@docslurp/shared";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/** Each estimate twin returns the value its mutation reports as `job.estimate`, computed by the same function. */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let work: typeof import("../services/work-estimates.js");
let retained: typeof import("../services/billing/retained-storage.js");
let mode: typeof import("../services/workspace-indexing-mode.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {}, types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } } }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", () => ({ signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn() }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner')`;
  await sql`insert into workspaces(id, org_id, user_id, name, pipeline) values ('w', 'o1', 'u1', 'W', ${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))})`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
    values ('run', 'o1', 'u1', 'w', 'upload', 'completed', 'index', ${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))}, 2, 7)`;
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, file_size)
    values ('d1', 'o1', 'u1', 'w', 'run', 'a.pdf', 'application/pdf', 'k1', 'completed', 3, 1000),
           ('d2', 'o1', 'u1', 'w', 'run', 'b.pdf', 'application/pdf', 'k2', 'completed', 4, 2000)`;
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, file_size, archived_at, superseded_at)
    values ('d3', 'o1', 'u1', 'w', 'run', 'a.pdf', 'application/pdf', 'k3', 'completed', 2, 5000, now(), now())`;
  work = await import("../services/work-estimates.js");
  retained = await import("../services/billing/retained-storage.js");
  mode = await import("../services/workspace-indexing-mode.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

const BILLED = { STRIPE_SECRET_KEY: "sk_test" };

describe("estimate parity", () => {
  it("run reprocess estimate is stable and prices the run's pages", async () => {
    const a = await work.estimateRunReprocess({ runId: "run", userId: "u1", options: {}, env: BILLED });
    const b = await work.estimateRunReprocess({ runId: "run", userId: "u1", options: {}, env: BILLED });
    expect(a).toEqual(b);
    expect(a).toMatchObject({ documents: 2, pages: 7 });
    const narrower = await work.estimateRunReprocess({ runId: "run", userId: "u1", options: { stages: ["embed"] }, env: BILLED });
    expect(narrower!.credits!.high).toBeLessThan(a!.credits!.high);
  });

  it("bulk document reprocess estimate sums the selected documents", async () => {
    const one = await work.estimateDocumentReprocess({ documentIds: ["d1"], userId: "u1", workspaceId: "w" });
    const both = await work.estimateDocumentReprocess({ documentIds: ["d1", "d2"], userId: "u1" });
    expect(one).toMatchObject({ documents: 1, pages: 3 });
    expect(both).toMatchObject({ documents: 2, pages: 7 });
    expect(await work.estimateDocumentReprocess({ documentIds: ["d1", "d2"], userId: "u1", workspaceId: "w" })).toEqual(both);
  });

  it("billing disabled estimates never carry credits", async () => {
    const estimate = await work.estimateRunReprocess({ runId: "run", userId: "u1", env: {} });
    expect(estimate).toMatchObject({ billing: "disabled", credits: null });
    expect(estimate!.seconds).not.toBeNull();
  });

  it("upload estimate assumes pages from size when the client does not know them", async () => {
    const workspace = { pipeline: defaultPipelineFeatures, orgId: "o1" };
    const sized = await work.estimateUpload({ files: [{ name: "a.pdf", size: 75 * 1024 * 10 }], workspace });
    const known = await work.estimateUpload({ files: [{ name: "a.pdf", size: 1, pages: 10 }], workspace });
    expect(sized.pages).toBe(10);
    expect(sized).toEqual(known);
  });

  it("full-index estimate is null without a workspace and prices only unindexed pages otherwise", async () => {
    const none = await mode.estimateFullIndex({ workspaceId: "w", orgId: "o1" });
    expect(none).toMatchObject({ documents: 0, pages: 0 });
  });

  it("shared estimator agrees with the service wrapper", async () => {
    const direct = estimatePipelineWork({ features: defaultPipelineFeatures, stages: ["embed"], pages: 7, documents: 2, env: process.env });
    expect(direct.pages).toBe(7);
  });
});

describe("retained version storage", () => {
  it("sums archived, unpurged documents and prices them only when billing is enforced", async () => {
    expect(await retained.getRetainedVersionStorage("o1", {})).toEqual({ bytes: 5000, pages: 2, monthlyCredits: null, billingEnforced: false });
    const billed = await retained.getRetainedVersionStorage("o1", { STRIPE_SECRET_KEY: "sk_test" });
    expect(billed.bytes).toBe(5000);
    expect(billed.monthlyCredits).toBeGreaterThan(0);
  });
});
