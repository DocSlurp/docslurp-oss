import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/** providerCostLossItems against a migrated database: item grouping, refunds, run status, org separation and the window. */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let attribution: typeof import("../services/usage-attribution.js");

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u1', 'One', 'one@example.test'), ('u2', 'Two', 'two@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o1', 'One', 'loss-one', 'u1'), ('o2', 'Two', 'loss-two', 'u2')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'One'), ('w2', 'o2', 'u2', 'Two')`;
  attribution = await import("../services/usage-attribution.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
beforeEach(async () => {
  await sql`delete from usage_events`;
  await sql`delete from workspace_runs`;
});

let seq = 0;
async function event(args: { org: string; workspace: string; user: string; credits?: number; providerCost?: number; metadata?: Record<string, unknown>; runId?: string; model?: string; at?: Date }) {
  seq += 1;
  const metadata = { ...(args.providerCost !== undefined ? { providerCostCents: args.providerCost } : {}), ...args.metadata };
  await sql`insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, metadata, created_at, org_id, workspace_id)
    values (${`ue-${seq}`}, ${args.user}, ${args.runId ?? null}, 'openrouter', ${args.model ?? "vendor/model"}, 'test', 1, 'token', ${args.credits ?? 0},
      ${sql.json(metadata as never)}, ${args.at ?? new Date(Date.now() - 10 * 60_000)}, ${args.org}, ${args.workspace})`;
}
const window = () => ({ since: new Date(Date.now() - 60 * 60_000), until: new Date(Date.now() - 60_000) });

describe("providerCostLossItems", () => {
  it("reports chat turns, finished runs and sessions whose provider cost exceeds their credits", async () => {
    const o1 = { org: "o1", workspace: "w1", user: "u1" };
    // Turn A loses 2 cents; turn B is profitable.
    await event({ ...o1, providerCost: 3, metadata: { chatTurnId: "tA", costSource: "provider" }, model: "vendor/expensive" });
    await event({ ...o1, credits: 1, metadata: { chatTurnId: "tA" } });
    await event({ ...o1, providerCost: 1, metadata: { chatTurnId: "tB", costSource: "provider" } });
    await event({ ...o1, credits: 5, metadata: { chatTurnId: "tB" } });
    // A refunded turn: its credits were voided.
    await event({ ...o1, providerCost: 2, metadata: { chatTurnId: "tC", costSource: "provider", chatTurnRefund: { reason: "error", credits: 1 } } });
    // A finished run priced from estimates, and a run still processing.
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values
      ('r-done', 'o1', 'u1', 'w1', 'bulk-upload', 'completed', 'completed', '{}'), ('r-busy', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'embed', '{}')`;
    await event({ ...o1, runId: "r-done", providerCost: 10, metadata: { costSource: "estimate" } });
    await event({ ...o1, runId: "r-done", credits: 4 });
    await event({ ...o1, runId: "r-busy", providerCost: 10, metadata: { costSource: "provider" } });
    // A search session.
    await event({ ...o1, providerCost: 0.5, metadata: { sessionId: "s1", costSource: "provider" } });

    const items = await attribution.providerCostLossItems(window());
    expect(items.map((item) => [item.kind, item.key, item.lossCents])).toEqual([
      ["run", "r-done", 6], ["chat-turn", "tA", 2], ["chat-turn", "tC", 2], ["search-session", "s1", 0.5],
    ]);
    expect(items.find((item) => item.key === "r-done")).toMatchObject({ estimatedCostCents: 10, creditCents: 4, refunded: false, orgId: "o1" });
    expect(items.find((item) => item.key === "tA")).toMatchObject({ topModel: "vendor/expensive", estimatedCostCents: 0 });
    expect(items.find((item) => item.key === "tC")?.refunded).toBe(true);
  });

  it("keeps organizations apart and honours the window", async () => {
    // The same turn id in two orgs never merges.
    await event({ org: "o1", workspace: "w1", user: "u1", providerCost: 2, metadata: { chatTurnId: "shared" } });
    await event({ org: "o2", workspace: "w2", user: "u2", credits: 10, metadata: { chatTurnId: "shared" } });
    // Older than the window, and too recent to have settled.
    await event({ org: "o1", workspace: "w1", user: "u1", providerCost: 5, metadata: { chatTurnId: "old" }, at: new Date(Date.now() - 2 * 60 * 60_000) });
    await event({ org: "o1", workspace: "w1", user: "u1", providerCost: 5, metadata: { chatTurnId: "fresh" }, at: new Date() });
    const items = await attribution.providerCostLossItems(window());
    expect(items.map((item) => [item.orgId, item.key, item.lossCents])).toEqual([["o1", "shared", 2]]);
  });
});
