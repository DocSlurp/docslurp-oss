import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { Store } from "../db/store.js";
import { currentProviderPolicy, currentProviderRateOrg } from "../lib/provider-rate-limit.js";
import type { Stage } from "../pipeline/pipeline.js";
import { createStageExecution } from "../pipeline/stage-execution.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Run-level stages (graph-enrich, community summaries) call providers outside any per-document scope. They must
 * carry the run's own org and China-provider policy: without it every call failed closed to non-China providers,
 * which 404s for models only China-based providers serve (2026-11-01).
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    delete from workspace_runs; delete from workspaces; delete from organizations;
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x') on conflict do nothing;
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1'), ('o2', 'Other', 'other', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'W2');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('r1', 'o1', 'u1', 'w', 'upload', 'processing', 'graph-enrich', '{}', 0, 0);
  `);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function observedScope() {
  let seen: { policy: ReturnType<typeof currentProviderPolicy>; org: string | null } | undefined;
  const stage: Stage = { name: "graph-enrich", run: async () => { seen = { policy: currentProviderPolicy(), org: currentProviderRateOrg() }; } };
  const execution = createStageExecution({ store, stages: [stage], config: { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config });
  await execution.runStage({ stageName: "graph-enrich", runId: "r1", totalStages: 1, artifacts: {} },
    { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1 });
  return seen!;
}

describe("run-level stage provider scope", () => {
  it("carries the run's org and allows China-based providers only when the org and workspace both do", async () => {
    await db.exec(`update organizations set allow_china_providers = true; update workspaces set allow_china_providers = true;`);
    expect(await observedScope()).toEqual({ policy: { allowChinaProviders: true, speedBoost: false }, org: "o1" });
  });

  it("stays restricted when the workspace turned China-based providers off", async () => {
    await db.exec(`update organizations set allow_china_providers = true; update workspaces set allow_china_providers = false where id = 'w';
      update workspaces set allow_china_providers = true where id = 'w2';`);
    expect((await observedScope()).policy.allowChinaProviders).toBe(false);
  });

  it("stays restricted when the run's org turned them off, whatever another org allows", async () => {
    await db.exec(`update organizations set allow_china_providers = (id = 'o2'); update workspaces set allow_china_providers = true;`);
    expect(await observedScope()).toEqual({ policy: { allowChinaProviders: false, speedBoost: false }, org: "o1" });
  });

  it("keeps concurrent runs' scopes apart", async () => {
    await db.exec(`update organizations set allow_china_providers = true; update workspaces set allow_china_providers = (id = 'w');
      insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
        values ('r2', 'o2', 'u1', 'w2', 'upload', 'processing', 'graph-enrich', '{}', 0, 0);`);
    const seen = new Map<string, { allow: boolean; org: string | null }>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // r1 reads its policy only after r2's stage has started, so both scopes are live at once.
    const stage: Stage = {
      name: "graph-enrich",
      run: async (state) => {
        if (state.run.id === "r1") await gate;
        else release();
        seen.set(state.run.id, { allow: currentProviderPolicy().allowChinaProviders, org: currentProviderRateOrg() });
      },
    };
    const execution = createStageExecution({ store, stages: [stage], config: { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config });
    const runtime = { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1 };
    await Promise.all(["r1", "r2"].map((runId) => execution.runStage({ stageName: "graph-enrich", runId, totalStages: 1, artifacts: {} }, runtime)));
    expect(Object.fromEntries(seen)).toEqual({ r1: { allow: true, org: "o1" }, r2: { allow: false, org: "o2" } });
  });

  it("leaves no scope behind after the stage", async () => {
    await db.exec(`update organizations set allow_china_providers = true; update workspaces set allow_china_providers = true;`);
    await observedScope();
    expect(currentProviderPolicy().allowChinaProviders).toBe(false);
    expect(currentProviderRateOrg()).toBeNull();
  });
});
