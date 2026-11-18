import { normalizePipelineFeatures } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * A project row whose stored settings no longer validate (owner, 2026-11-18: "just drop the invalid field, rather than
 * give users a dead end"), against a database built from server/db/migrations: it is listed, opened, uploaded to and
 * saved; the save writes the reset values back; guarded settings fall to their strictest value; a caller's own invalid
 * value is still refused.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let projects: typeof import("../services/projects.js");
let runCreation: ReturnType<typeof import("../services/run-creation.js").createRunCreation>;
const prepare = vi.fn();
const pdfFacts = { declaredMimeType: "application/pdf", sniffedMimeType: "application/pdf", mimeType: "application/pdf", format: "pdf", container: null, encoding: null, mismatch: "none" };

/** The shapes found in old rows: a refused vision model by catalog id, a retired enum, unreadable guarded values. */
const staleRow = {
  quality: "no-such-quality",
  summarize: true,
  privacyMode: "Local-Only",
  piiPolicy: { enabled: "yes", action: "block" },
  webTools: "off",
  webhooks: { enabled: true, events: "run.completed" },
  maxCostCents: "lots",
  ladder: { maxRung: "gold" },
  visionFallback: "sometimes",
  mediaVideo: { enabled: true, maxFrames: 999_999 },
  embedding: { profile: "cheapest-local" },
  vision: { model: "gpt-4.1-mini", prompt: "<OCR>", baseUrl: null, runtime: "remote-openai", benchmarkProfile: "difficult-pages", remoteFallbackModel: "gpt-4.1-mini" },
  summaryTree: { enabled: "maybe" },
  indexingMode: "no-such-mode",
};

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/source-metadata.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../services/source-metadata.js")>(),
    resolveSourceMetadata: prepare,
  }));
  vi.doMock("../lib/temporal.js", () => ({
    startPipelineWorkflow: vi.fn(async () => {}), signalPipelineCancel: vi.fn(), signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(),
    isTemporalClientConnected: () => true, onTemporalClientConnected: vi.fn(), warmTemporalClient: vi.fn(),
  }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 1000)`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner')`;
  projects = await import("../services/projects.js");
  const creation = await import("../services/run-creation.js");
  runCreation = creation.createRunCreation({ sql: sql as never, start: vi.fn(async () => ({ status: "started" })) as never });
}, 300_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  prepare.mockReset().mockResolvedValue({ pageCount: 3, sourceSha256: "abc", fileFacts: pdfFacts });
  await sql`delete from documents`;
  await sql`delete from project_runs`;
  await sql`delete from audit_log`;
  await sql`delete from projects`;
  await sql`insert into projects(id, org_id, user_id, name, pipeline) values ('w', 'o1', 'u1', 'W', ${sql.json(staleRow as never)})`;
});

const storedPipeline = async () => (await sql<{ pipeline: unknown }[]>`select pipeline from projects where id = 'w'`)[0]!.pipeline;

/** The values a row with every guarded setting unreadable must read as. */
const strictest = {
  privacyMode: "strict-privacy",
  piiPolicy: { enabled: true, action: "block_indexing" },
  webTools: false,
  webhooks: { enabled: false, events: [] },
  maxCostCents: 1,
  ladder: { maxRung: "fast" },
  visionFallback: false,
  mediaVideo: { enabled: false },
};

describe("a project whose stored settings no longer validate", () => {
  it("is listed and opened with each invalid field reset, the guarded ones at their strictest, and the drops named", async () => {
    const [listed] = await projects.listProjects("u1");
    expect(listed?.id).toBe("w");
    const opened = await projects.getProject("w", "u1");
    for (const project of [listed!, opened!]) {
      expect(project.pipeline).toMatchObject({ ...strictest, summarize: true, embedding: { profile: "cheapest-local" } });
      expect(project.pipeline.vision.profile).toBe("cheapest-local");
      expect(project.pipeline.summaryTree.enabled).toBe(false);
      expect(project.settingsRepairs).toEqual(expect.arrayContaining([
        { path: "pipeline.quality", reason: "invalid" },
        { path: "pipeline.privacyMode", reason: "restricted" },
        { path: "pipeline.maxCostCents", reason: "restricted" },
        { path: "pipeline.webhooks", reason: "restricted" },
      ]));
      // Generic: no stored values, no model names.
      expect(JSON.stringify(project.settingsRepairs)).not.toMatch(/gpt|no-such|lots|gold/);
      expect(JSON.stringify(project.pipeline)).not.toContain("gpt-4.1-mini");
    }
  });

  it("can be saved: the save writes the reset values back, so the row validates and reads with no repairs", async () => {
    const saved = await projects.updateProject("w", "u1", { name: "Renamed" });
    expect(saved).not.toBeNull();
    const stored = await storedPipeline();
    expect(() => normalizePipelineFeatures(stored as never)).not.toThrow();
    expect(stored).toMatchObject({ ...strictest, summarize: true, summaryTree: { enabled: false }, indexingMode: "full" });
    expect(JSON.stringify(stored)).not.toContain("gpt-4.1-mini");
    const reread = await projects.getProject("w", "u1");
    expect(reread?.name).toBe("Renamed");
    expect(reread).not.toHaveProperty("settingsRepairs");
  });

  it("a save that sets a guarded setting to a valid value keeps that value", async () => {
    const current = (await projects.getProject("w", "u1"))!;
    await projects.updateProject("w", "u1", { pipeline: { ...current.pipeline, privacyMode: "local-only", maxCostCents: 500, webTools: false } });
    expect(await storedPipeline()).toMatchObject({ privacyMode: "local-only", maxCostCents: 500 });
    expect(await projects.getProject("w", "u1")).not.toHaveProperty("settingsRepairs");
  });

  it("still refuses a caller's own invalid value, naming the field, and leaves the row unchanged", async () => {
    const current = (await projects.getProject("w", "u1"))!;
    const error = await projects.updateProject("w", "u1", { pipeline: { ...current.pipeline, quality: "bogus" } as never }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: expect.arrayContaining(["quality"]) })]) });
    expect(await storedPipeline()).toEqual(staleRow);
  });

  it("can be uploaded to: the run starts with the reset settings, never a weaker guarded value", async () => {
    const project = (await projects.getProject("w", "u1"))!;
    const created = await runCreation.create({
      userId: "u1", projectId: "w", kind: "bulk-upload", pipeline: project.pipeline,
      sources: { kind: "files", files: [{ filename: "a.pdf", mimeType: "application/pdf", sourceKey: "u1/raw/a.pdf", fileSize: 1000 }] },
    } as never);
    expect(created.run.id).toBeTruthy();
    const [run] = await sql<{ pipeline: Record<string, unknown> }[]>`select pipeline from project_runs where id = ${created.run.id}`;
    expect(run!.pipeline).toMatchObject({ privacyMode: "strict-privacy", webTools: false, maxCostCents: 1, visionFallback: false, mediaVideo: { enabled: false }, webhooks: { enabled: false } });
    expect(run!.pipeline.piiPolicy).toMatchObject({ enabled: true, action: "block_indexing" });
  });

  it("a pipeline stored as a non-object reads, saves and uploads as defaults with the guarded settings strictest", async () => {
    await sql`update projects set pipeline = ${sql.json("garbage" as never)} where id = 'w'`;
    const project = (await projects.getProject("w", "u1"))!;
    expect(project.pipeline).toMatchObject(strictest);
    expect(project.settingsRepairs).toEqual([{ path: "pipeline", reason: "restricted" }]);
    await projects.updateProject("w", "u1", { name: "Fixed" });
    const stored = await storedPipeline();
    expect(stored).toMatchObject(strictest);
    expect(await projects.getProject("w", "u1")).not.toHaveProperty("settingsRepairs");
  });
});
