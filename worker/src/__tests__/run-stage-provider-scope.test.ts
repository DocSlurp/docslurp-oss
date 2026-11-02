import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Store } from "../db/store.js";
import { currentProviderPolicy, currentProviderRateOrg } from "../lib/provider-rate-limit.js";
import { createStageExecution } from "../pipeline/stage-execution.js";
import type { Config } from "../config.js";
import type { Stage } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Run-level stages (graph-enrich, page-range shards) call providers from
 * stage.run itself, not through runDocumentStage. On 2026-11-02 they ran with
 * no provider scope: every graph call was restricted to non-China providers and
 * 404ed for a model only Alibaba serves, though the run allowed it, and its
 * requests counted against no org in the fair-share limiter.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com');
    insert into organizations(id, name, slug, created_by_user_id, allow_china_providers) values
      ('o-allow', 'Allow', 'allow', 'u1', true), ('o-deny', 'Deny', 'deny', 'u1', false);
    insert into workspaces(id, org_id, user_id, name, allow_china_providers) values
      ('w-allow', 'o-allow', 'u1', 'A', true), ('w-deny-in-allowing-org', 'o-allow', 'u1', 'B', false),
      ('w-allow-in-denying-org', 'o-deny', 'u1', 'C', true);
  `);
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`delete from workspace_runs`);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

type Seen = { orgId: string | null; allowChinaProviders: boolean };

async function scopeSeenByRunStage(orgId: string, workspaceId: string, runId = "r1", during?: () => Promise<void>) {
  await db.query(`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total)
    values ($3, $1, 'u1', $2, 'upload', 'processing', 'graph-enrich', '{}', 0, 0)`, [orgId, workspaceId, runId]);
  const seen: Seen[] = [];
  const read = () => seen.push({ orgId: currentProviderRateOrg(), allowChinaProviders: currentProviderPolicy().allowChinaProviders });
  const stage: Stage = {
    name: "graph-enrich",
    // Read before and after yielding, so a concurrent run's scope would show.
    run: async () => { read(); await during?.(); read(); },
  };
  const execution = createStageExecution({ store, stages: [stage], config: { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config });
  await execution.runStage({ stageName: "graph-enrich", runId, totalStages: 1, artifacts: {} },
    { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1 });
  expect(new Set(seen.map((value) => JSON.stringify(value))).size).toBe(1);
  return seen[0];
}

describe("run-level stage provider scope", () => {
  it("attributes provider calls to the run's org and applies its policy", async () => {
    expect(await scopeSeenByRunStage("o-allow", "w-allow")).toEqual({ orgId: "o-allow", allowChinaProviders: true });
  });

  it("stays restricted when the workspace or the org does not allow China-based providers", async () => {
    expect(await scopeSeenByRunStage("o-allow", "w-deny-in-allowing-org")).toEqual({ orgId: "o-allow", allowChinaProviders: false });
    await db.exec(`delete from workspace_runs`);
    expect(await scopeSeenByRunStage("o-deny", "w-allow-in-denying-org")).toEqual({ orgId: "o-deny", allowChinaProviders: false });
  });

  it("keeps concurrent runs of different orgs in their own scopes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const [allowing, denying] = await Promise.all([
      scopeSeenByRunStage("o-allow", "w-allow", "r-allow", () => gate),
      (async () => { const seen = await scopeSeenByRunStage("o-deny", "w-allow-in-denying-org", "r-deny"); release(); return seen; })(),
    ]);
    expect(allowing).toEqual({ orgId: "o-allow", allowChinaProviders: true });
    expect(denying).toEqual({ orgId: "o-deny", allowChinaProviders: false });
  });

  it("restricts provider calls outside any run scope", () => {
    expect(currentProviderPolicy().allowChinaProviders).toBe(false);
    expect(currentProviderRateOrg()).toBeNull();
  });
});
