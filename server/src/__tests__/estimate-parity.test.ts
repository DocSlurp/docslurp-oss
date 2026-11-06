import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures, estimatePipelineWork } from "@docslurp/shared";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/** Each estimate twin returns the value its mutation reports as `job.estimate`, computed by the same function. */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let work: typeof import("../services/work-estimates.js");
let retained: typeof import("../services/billing/retained-storage.js");
let mode: typeof import("../services/project-indexing-mode.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {}, types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } } }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", () => ({ signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn() }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner')`;
  await sql`insert into projects(id, org_id, user_id, name, pipeline) values ('w', 'o1', 'u1', 'W', ${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))})`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
    values ('run', 'o1', 'u1', 'w', 'upload', 'completed', 'index', ${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))}, 2, 7)`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, file_size)
    values ('d1', 'o1', 'u1', 'w', 'run', 'a.pdf', 'application/pdf', 'k1', 'completed', 3, 1000),
           ('d2', 'o1', 'u1', 'w', 'run', 'b.pdf', 'application/pdf', 'k2', 'completed', 4, 2000)`;
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, file_size, archived_at, superseded_at)
    values ('d3', 'o1', 'u1', 'w', 'run', 'a.pdf', 'application/pdf', 'k3', 'completed', 2, 5000, now(), now())`;
  work = await import("../services/work-estimates.js");
  retained = await import("../services/billing/retained-storage.js");
  mode = await import("../services/project-indexing-mode.js");
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
    const one = await work.estimateDocumentReprocess({ documentIds: ["d1"], userId: "u1", projectId: "w" });
    const both = await work.estimateDocumentReprocess({ documentIds: ["d1", "d2"], userId: "u1" });
    expect(one).toMatchObject({ documents: 1, pages: 3 });
    expect(both).toMatchObject({ documents: 2, pages: 7 });
    expect(await work.estimateDocumentReprocess({ documentIds: ["d1", "d2"], userId: "u1", projectId: "w" })).toEqual(both);
  });

  it("billing disabled estimates never carry credits", async () => {
    const estimate = await work.estimateRunReprocess({ runId: "run", userId: "u1", env: {} });
    expect(estimate).toMatchObject({ billing: "disabled", credits: null });
    expect(estimate!.seconds).not.toBeNull();
  });

  it("upload estimate centres on pages assumed from size, and says the count is a range, when the client does not know them", async () => {
    const project = { pipeline: defaultPipelineFeatures, orgId: "o1" };
    // An explicit empty environment: billing off, whatever STRIPE_SECRET_KEY the machine running the test has.
    const sized = await work.estimateUpload({ files: [{ name: "a.pdf", size: 75 * 1024 * 10 }], project, env: {} });
    const known = await work.estimateUpload({ files: [{ name: "a.pdf", size: 1, pages: 10 }], project, env: {} });
    expect(sized.estimate.pages).toBe(10);
    // Counted pages are exact; uncounted ones span the pages the size allows, so the range is wider and says so.
    expect(known.estimate.pagesRange).toBeUndefined();
    expect(sized.estimate).toMatchObject({ unmeasuredFiles: 1, pagesRange: { low: 3, high: 47 } });
    expect(sized.estimate.credits).toBeNull();
    expect(sized.profile).toEqual(known.profile);
    expect(sized.media).toBeNull();
  });

  it("prices audio and video by duration on top of the paged files, with the cheaper audio-track option", async () => {
    const project = { pipeline: defaultPipelineFeatures, orgId: "o1" };
    const env = { STRIPE_SECRET_KEY: "sk_test" };
    const docs = await work.estimateUpload({ files: [{ name: "a.pdf", size: 1, pages: 10 }], project, env });
    const mixed = await work.estimateUpload({
      files: [{ name: "a.pdf", size: 1, pages: 10 }, { name: "demo.mp4", size: 1, durationSeconds: 600 }],
      project,
      env,
    });
    expect(mixed.estimate.pages).toBe(10);
    expect(mixed.estimate.documents).toBe(docs.estimate.documents + 1);
    expect(mixed.media).toMatchObject({ videoFiles: 1, videoMinutes: 10, videoFrames: true });
    expect(mixed.media!.credits.high).toBeGreaterThan(mixed.media!.credits.low);
    expect(mixed.media!.lighter).toMatchObject({ pipeline: { mediaVideo: { enabled: false } } });
    expect(mixed.estimate.credits!.high).toBeCloseTo(docs.estimate.credits!.high + mixed.media!.credits.high);
    expect(mixed.estimate.credits!.low).toBeCloseTo(docs.estimate.credits!.low + mixed.media!.credits.low);
  });

  it("prices a media-only upload and offers no lighter option when the project already skips video frames", async () => {
    const project = { pipeline: { ...defaultPipelineFeatures, mediaVideo: { enabled: false } }, orgId: "o1" };
    const result = await work.estimateUpload({ files: [{ name: "talk.mp3", size: 1, durationSeconds: 1800 }], project, env: { STRIPE_SECRET_KEY: "sk_test" } });
    expect(result.estimate.pages).toBe(0);
    expect(result.estimate.credits!.low).toBeCloseTo(result.media!.credits.low);
    expect(result.media!.lighter).toBeNull();
  });

  it("full-index estimate is null without a project and prices only unindexed pages otherwise", async () => {
    const none = await mode.estimateFullIndex({ projectId: "w", orgId: "o1" });
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

it("upload estimates require explicit boost even when the project snapshot was boosted", async () => {
  const args = { files: [{ name: "a.pdf", size: 1, pages: 10 }], project: { orgId: "o1", pipeline: { ...defaultPipelineFeatures, speedBoost: true } }, env: BILLED };
  // The quote's validity window moves with the clock; compare everything else.
  const timeless = <T extends { quote: { validUntil: string } }>(value: T) => ({ ...value, quote: { ...value.quote, validUntil: "" } });
  const omitted = await work.estimateUpload(args);
  const off = await work.estimateUpload({ ...args, speedBoost: false });
  const on = await work.estimateUpload({ ...args, speedBoost: true });
  expect(timeless(omitted)).toEqual(timeless(off));
  expect(on.quote.ingest.credits!.high).toBeGreaterThan(off.quote.ingest.credits!.high);
  expect(on.estimate.credits!.low).toBe(off.estimate.credits!.low * 4);
  expect(on.estimate.credits!.high).toBe(off.estimate.credits!.high * 4);
  expect(on.estimate.seconds).toEqual(off.estimate.seconds);
});

it('scales both video and audio-only alternative credits only for explicit boost', async () => {
 const args = { files: [{ name: 'clip.mp4', size: 100, durationSeconds: 600 }], project: { pipeline: defaultPipelineFeatures, orgId:'o1' }, env: BILLED };
 const base = await work.estimateUpload(args);
 const timeless = <T extends { quote: { validUntil: string } }>(value: T) => ({ ...value, quote: { ...value.quote, validUntil: "" } });
 expect(timeless(await work.estimateUpload({ ...args, speedBoost: false }))).toEqual(timeless(base));
 const boosted = await work.estimateUpload({ ...args, speedBoost: true });
 expect(base.media?.lighter).toBeTruthy();
 for (const bound of ['low', 'high'] as const) {
  expect(boosted.media!.credits[bound]).toBeCloseTo(base.media!.credits[bound] * 4);

 }
 expect(boosted.media!.lighter!.credits).toBeCloseTo(base.media!.lighter!.credits * 4);
 expect(boosted.media!.lighter!.savedCredits).toBeCloseTo(base.media!.lighter!.savedCredits * 4);
 expect(boosted.media!.lighter!.pipeline).toEqual(base.media!.lighter!.pipeline);
});
