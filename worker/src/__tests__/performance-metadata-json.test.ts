import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Store } from "../db/store.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { createStageExecution } from "../pipeline/stage-execution.js";
import type { Config } from "../config.js";
import type { Stage } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/** performance_log.metadata must be a JSON object so readers can use `metadata ->> 'key'`. */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('r1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 1, 1);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('d1', 'o1', 'u1', 'w', 'r1', 'a.pdf', 'application/pdf', 'k1', 'processing', 1);
  `);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

describe("performance_log metadata persistence", () => {
  it("stores metadata as a queryable JSON object, not a JSON-encoded string", async () => {
    const stage: Stage = {
      name: "extract",
      run: async (state) => {
        for (const document of [...state.documents]) {
          await runDocumentStage(state, document, "extract", `${document.id}:extract`, "x", async () => {
            state.pendingPerformance.push({ scope: "document", documentId: document.id, stageName: "extract", metric: "detected-language", value: 1, unit: "count", tags: [], metadata: { detectedLanguage: "en", nested: { n: 2 } } });
            return { stats: {} };
          });
        }
      },
    };
    const execution = createStageExecution({ store, stages: [stage], config: { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config });
    await execution.runStage({ stageName: "extract", runId: "r1", totalStages: 1, artifacts: {} }, { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1 });
    const rows = (await db.query<{ kind: string; language: string | null; n: string | null }>(
      `select jsonb_typeof(metadata) as kind, metadata ->> 'detectedLanguage' as language, metadata #>> '{nested,n}' as n from performance_log where run_id = 'r1' and metric = 'detected-language'`,
    )).rows;
    expect(rows).toEqual([{ kind: "object", language: "en", n: "2" }]);
  });
});
