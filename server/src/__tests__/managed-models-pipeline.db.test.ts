import { defaultPipelineFeatures, normalizePipelineFeatures } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Managed pipeline models against a database built from server/db/migrations: only explicit admin overrides
 * (projects.managed_models.pipeline) are ever applied; stored legacy values, former defaults, version snapshots and
 * template pipelines never select a model (council H1, H2, M4).
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let projects: typeof import("../services/projects.js");
let managedModels: typeof import("../services/managed-models.js");

const DEEPSEEK_VISION = "llm://openrouter/deepseek/deepseek-v4.1-flash-1017";
const legacyPipeline = {
  ...defaultPipelineFeatures,
  vision: { profile: "good-fast-hosted", modelUri: DEEPSEEK_VISION, target: "hosted", remoteFallbackModelUri: null },
  textGeneration: { model: "z-ai/glm-5.3-flash", models: {} },
  visualPages: { route: "gemini", coarseFallback: false },
};

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 1000)`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner')`;
  projects = await import("../services/projects.js");
  managedModels = await import("../services/managed-models.js");
}, 300_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  await sql`delete from audit_log`;
  await sql`delete from projects`;
  await sql`insert into projects(id, org_id, user_id, name, pipeline) values ('w', 'o1', 'u1', 'W', ${sql.json(legacyPipeline as never)})`;
});

const storedPipeline = async () => (await sql<{ pipeline: Record<string, Record<string, unknown>> }[]>`select pipeline from projects where id = 'w'`)[0]!.pipeline;
const currentDefaultVision = normalizePipelineFeatures(defaultPipelineFeatures).vision.modelUri;

describe("managed pipeline models", () => {
  it("reads a project with a former-default DeepSeek vision URI on the current default, and never its legacy text model", async () => {
    const project = await projects.getProject("w", "u1");
    expect(project!.pipeline.vision.modelUri).toBe(currentDefaultVision);
    expect(project!.pipeline.vision.modelUri).not.toBe(DEEPSEEK_VISION);
    expect(project!.pipeline.textGeneration.model).toBeNull();
    expect(project!.pipeline.visualPages.route).toBe("auto");
  });

  it("stores a customer save without model values, and with the explicit overrides", async () => {
    // An operator private text route (its registry is checked when the stage calls it) is an explicit override.
    await managedModels.setProjectManagedModels("w", { pipeline: { textGeneration: { model: "llm://private/gpu1/acme/text" } } }, { userId: "u1" });
    const current = await projects.getProject("w", "u1");
    expect(current!.pipeline.textGeneration.model).toBe("llm://private/gpu1/acme/text");
    await projects.updateProject("w", "u1", { pipeline: { ...current!.pipeline, summarize: true } });
    const stored = await storedPipeline();
    expect(stored.textGeneration.model).toBe("llm://private/gpu1/acme/text");
    expect(stored.vision).not.toHaveProperty("modelUri");
    expect(stored.visualPages).not.toHaveProperty("route");
    expect(JSON.stringify(stored)).not.toContain("deepseek");
    expect((await projects.getProject("w", "u1"))!.pipeline.summarize).toBe(true);
  });

  it("applies an admin vision override, keeps it across customer saves, and records an audit row", async () => {
    const override = "llm://openrouter/google/gemini-2.5-flash-lite";
    await managedModels.setProjectManagedModels("w", { pipeline: { vision: { modelUri: override } } }, { userId: "u1" });
    expect((await storedPipeline()).vision.modelUri).toBe(override);
    const current = await projects.getProject("w", "u1");
    expect(current!.pipeline.vision.modelUri).toBe(override);
    await projects.updateProject("w", "u1", { pipeline: { ...current!.pipeline, vision: { ...current!.pipeline.vision, modelUri: currentDefaultVision } } });
    expect((await projects.getProject("w", "u1"))!.pipeline.vision.modelUri).toBe(override);
    const audit = await sql<{ action: string }[]>`select action from audit_log where project_id = 'w'`;
    expect(audit.map((row) => row.action)).toContain("project.managed_models.updated");
  });

  it("rolls back to a pre-0146 snapshot without restoring its model choices, and keeps a removed override removed", async () => {
    await managedModels.setProjectManagedModels("w", { pipeline: { vision: { modelUri: "llm://openrouter/google/gemini-2.5-flash-lite" } } }, { userId: "u1" });
    await managedModels.setProjectManagedModels("w", { pipeline: null }, { userId: "u1" });
    await sql`insert into audit_log(id, org_id, user_id, project_id, action, resource_type, metadata) values (
      'v-old', 'o1', 'u1', 'w', 'project.updated', 'project',
      ${sql.json({ snapshot: { name: "W", templateKey: null, systemPrompt: null, pipeline: {
        ...legacyPipeline,
        vision: { profile: "good-fast-hosted", modelUri: "llm://openrouter/google/gemini-2.5-flash-lite", target: "hosted", remoteFallbackModelUri: null },
        structuredExtraction: { model: "openai/gpt-6.1-sol", supportingPrompt: null, maxOutputTokens: 4096 },
      } } } as never)})`;
    const restored = await projects.rollbackProjectVersion("w", "u1", "v-old");
    expect(restored.pipeline.vision.modelUri).toBe(currentDefaultVision);
    expect(restored.pipeline.structuredExtraction.model).toBeNull();
    expect(restored.pipeline.textGeneration.model).toBeNull();
    expect(JSON.stringify(await storedPipeline())).not.toMatch(/gemini|gpt-6|glm|deepseek/);
  });

  it("drops an admin hosted fallback when the customer switches to local-only, and the stored pipeline stays valid", async () => {
    await managedModels.setProjectManagedModels("w", { pipeline: { vision: { remoteFallbackModelUri: "llm://openrouter/google/gemini-2.5-flash-lite" } } }, { userId: "u1" });
    const current = await projects.getProject("w", "u1");
    expect(current!.pipeline.vision.remoteFallbackModelUri).toBe("llm://openrouter/google/gemini-2.5-flash-lite");
    await projects.updateProject("w", "u1", { pipeline: {
      ...current!.pipeline, privacyMode: "local-only", vision: { profile: "cheapest-local" } as never, embedding: { profile: "cheapest-local" } as never,
      visionFallback: false,
    } as never });
    const after = await projects.getProject("w", "u1");
    expect(after!.pipeline.privacyMode).toBe("local-only");
    expect(after!.pipeline.vision.remoteFallbackModelUri).toBeNull();
    // The stored row parses: no hosted fallback was written back under local-only.
    expect((await storedPipeline()).vision).not.toHaveProperty("remoteFallbackModelUri");
  });

  it("refuses a denied, unpriced or uncatalogued admin model before writing", async () => {
    for (const pipeline of [
      { vision: { modelUri: DEEPSEEK_VISION } },
      { textGeneration: { model: "openai/gpt-6-sol-pro?reasoning=high" } },
      { textGeneration: { model: "acme/unpriced-model" } },
      { vision: { modelUri: "llm://openrouter/acme/unlisted-vision" } },
    ]) {
      await expect(managedModels.setProjectManagedModels("w", { pipeline }, { userId: "u1" })).rejects.toThrow(/never selected automatically|prohibited|no verified price|not a reviewed/);
    }
    expect((await sql`select managed_models from projects where id = 'w'`)[0]!.managed_models).toEqual({});
  });
});
