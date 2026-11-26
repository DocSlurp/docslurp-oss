import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { normalizePipelineFeatures } from "@docslurp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fromEnv } from "../config.js";
import { Store } from "../db/store.js";
import { resolvedRunModels } from "../pipeline/resolved-models.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

describe("resolvedRunModels", () => {
  it("names each service's model as an llm:// URI with the level that chose it", () => {
    const config = { ...fromEnv(), textGenerationModel: "vendor/text-1" };
    const models = resolvedRunModels(config, normalizePipelineFeatures({ textGeneration: { model: null, models: { "structured-extraction": "vendor/fields-1" } } }));
    expect(models.text).toEqual({ uri: "llm://openrouter/vendor/text-1" });
    expect(models.structuredExtraction).toEqual({ uri: "llm://openrouter/vendor/fields-1" });
    expect(models.embedding?.uri).toMatch(/^llm:\/\/[a-z0-9.-]+\/.+\?dimensions=\d+$/);
    expect(models.embedding?.class).toMatch(/^embeddingProfile=/);
    expect(models.vision?.uri).toMatch(/^llm:\/\//);
    expect(models.vision?.class).toMatch(/visionProfile=/);
    // A record only: nothing about where a model lives.
    expect(JSON.stringify(models)).not.toMatch(/https?:|api[_-]?key/i);
  });

  it("omits a service it cannot resolve instead of failing", () => {
    const config = { ...fromEnv(), textGenerationModel: "vendor/text-1" };
    const models = resolvedRunModels(config, { ...normalizePipelineFeatures(null), embedding: { modelUri: "not a uri" } } as never);
    expect(models.embedding).toBeUndefined();
    expect(models.text).toBeDefined();
  });
});

describe("project_runs.resolved_models", () => {
  let db: PGlite;
  let server: PGLiteSocketServer;
  let store: Store;
  beforeAll(async () => {
    db = await createMigratedDatabase();
    await db.exec(`
      insert into "user"(id, name, email) values ('u1', 'A', 'a@resolved.test');
      insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
      insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
      insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline)
        values (100, 'run-1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}');
    `);
    const served = await serveOnRandomPort(db);
    server = served.server;
    store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000);
  }, 120_000);
  afterAll(async () => { await server?.stop(); await db?.close(); });

  it("is written by the first-pickup stamp and kept on a resume", async () => {
    expect(await store.markRunMilestone("run-1", "worker_started", { resolvedModels: { text: { uri: "llm://openrouter/vendor/text-1" } } })).not.toBeNull();
    // A resume: the stamp is already set, so neither the milestone nor the models change.
    expect(await store.markRunMilestone("run-1", "worker_started", { resolvedModels: { text: { uri: "llm://openrouter/vendor/text-2" } } })).toBeNull();
    // Another milestone without models leaves them alone.
    await store.markRunMilestone("run-1", "first_page_extracted");
    await store.close();
    const rows = await db.query<{ resolved_models: unknown }>(`select resolved_models from project_runs where id = 'run-1'`);
    expect(rows.rows).toEqual([{ resolved_models: { text: { uri: "llm://openrouter/vendor/text-1" } } }]);
  });
});
