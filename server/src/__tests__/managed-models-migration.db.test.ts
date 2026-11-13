import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyRemainingMigrations, createMigratedDatabase } from "@docslurp/worker/testing";

/**
 * Migration 0158 (managed models): operator private routes and index-bound embedding URIs move into explicit overrides;
 * every other stored model value (legacy customer choices, former defaults such as the DeepSeek vision route) is removed
 * so the current defaults apply. It runs twice without change.
 */
const MIGRATION = "managed_models";
const migrationSql = readFileSync(new URL("../../db/migrations/0158_managed_models.sql", import.meta.url), "utf8");
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;

const legacy = {
  textGeneration: { model: "z-ai/glm-5.3-flash", models: { "document-summary": "llm://private/gpu1/acme/summary", "document-map": "qwen/qwen3.5-flash-02-23" } },
  structuredExtraction: { model: "llm://private/gpu1/acme/extract" },
  embedding: { profile: "cheapest-hosted", modelUri: "llm://openrouter/perplexity/pplx-embed-v1-0.6b", target: "hosted" },
  vision: { profile: "good-fast-hosted", modelUri: "llm://openrouter/deepseek/deepseek-v4.1-flash-1017", target: "hosted", remoteFallbackModelUri: "llm://openrouter/google/gemini-2.5-flash-lite" },
  visualPages: { route: "gemini", coarseFallback: false },
  pageRouter: { router: "heuristic", decisionModel: ["openai/gpt-6-luna-decisions"] },
  chartExport: { enabled: false, generatorModel: "llm://openrouter/z-ai/glm-5.3-flash" },
  quality: "good",
};
const customEmbedding = { embedding: { profile: "cheapest-hosted", modelUri: "llm://transformers.js/Xenova/gte-small", target: "local" }, quality: "auto" };

async function row(id: string): Promise<{ pipeline: Record<string, Record<string, unknown>>; managed: Record<string, unknown> }> {
  const { rows } = await db.query<{ pipeline: Record<string, Record<string, unknown>>; managed: Record<string, unknown> }>(
    `select pipeline, managed_models as managed from projects where id = $1`, [id],
  );
  return rows[0]!;
}

beforeAll(async () => {
  db = await createMigratedDatabase({ stopBefore: MIGRATION });
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'U', 'u1@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'O', 'o1-slug', 'u1');
  `);
  await db.query(`insert into projects(id, org_id, user_id, name, pipeline) values ('legacy', 'o1', 'u1', 'L', $1), ('embed', 'o1', 'u1', 'E', $2), ('empty', 'o1', 'u1', 'Z', '{}'::jsonb), ('scalar', 'o1', 'u1', 'S', '"x"'::jsonb)`,
    [JSON.stringify(legacy), JSON.stringify(customEmbedding)]);
  await applyRemainingMigrations(db, MIGRATION);
}, 300_000);

afterAll(async () => { await db?.close(); });

describe("migration 0158 managed models", () => {
  it("keeps operator private routes as explicit overrides and drops every other stored model value", async () => {
    const { pipeline, managed } = await row("legacy");
    expect(managed).toEqual({ pipeline: {
      textGeneration: { models: { "document-summary": "llm://private/gpu1/acme/summary" } },
      structuredExtraction: { model: "llm://private/gpu1/acme/extract" },
    } });
    expect(pipeline.textGeneration).toEqual({ models: { "document-summary": "llm://private/gpu1/acme/summary" } });
    expect(pipeline.structuredExtraction).toEqual({ model: "llm://private/gpu1/acme/extract" });
    expect(pipeline.vision).toEqual({ profile: "good-fast-hosted" });
    expect(pipeline.embedding).toEqual({ profile: "cheapest-hosted" });
    expect(pipeline.visualPages).toEqual({ coarseFallback: false });
    expect(pipeline.pageRouter).toEqual({ router: "heuristic" });
    expect(pipeline.chartExport).toEqual({ enabled: false });
    expect(pipeline.quality).toBe("good");
    expect(JSON.stringify(pipeline)).not.toMatch(/deepseek|gemini|glm|qwen|luna/);
  });

  it("keeps an index-bound embedding URI that differs from its profile default", async () => {
    const { pipeline, managed } = await row("embed");
    expect(managed).toEqual({ pipeline: { embedding: { modelUri: "llm://transformers.js/Xenova/gte-small" } } });
    expect(pipeline.embedding).toEqual({ profile: "cheapest-hosted", modelUri: "llm://transformers.js/Xenova/gte-small" });
  });

  it("leaves empty and non-object pipelines alone", async () => {
    expect((await row("empty")).pipeline).toEqual({});
    expect((await row("scalar")).pipeline).toBe("x");
  });

  it("is idempotent: running it again changes nothing", async () => {
    const before = await db.query(`select id, pipeline, managed_models from projects order by id`);
    for (const statement of migrationSql.split("--> statement-breakpoint")) {
      const text = statement.trim();
      if (text) await db.exec(text.replace(/^SET LOCAL[^;]*;/m, ""));
    }
    const after = await db.query(`select id, pipeline, managed_models from projects order by id`);
    expect(after.rows).toEqual(before.rows);
  });
});
