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
async function event(args: { org: string; workspace: string; user: string; credits?: number; providerCost?: unknown; metadata?: Record<string, unknown>; runId?: string; model?: string; metric?: string; at?: Date }) {
  seq += 1;
  const metadata = { ...(args.providerCost !== undefined ? { providerCostCents: args.providerCost } : {}), ...args.metadata };
  await sql`insert into usage_events (id, user_id, run_id, provider, model, metric, amount, unit, cost_cents, metadata, created_at, org_id, workspace_id)
    values (${`ue-${seq}`}, ${args.user}, ${args.runId ?? null}, 'openrouter', ${args.model ?? "vendor/model"}, ${args.metric ?? "test"}, 1, 'token', ${args.credits ?? 0},
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
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, updated_at) values
      ('r-done', 'o1', 'u1', 'w1', 'bulk-upload', 'completed', 'completed', '{}', ${tenMinutesAgo}),
      ('r-busy', 'o1', 'u1', 'w1', 'bulk-upload', 'processing', 'embed', '{}', ${tenMinutesAgo})`;
    await event({ ...o1, runId: "r-done", providerCost: 10, metadata: { costSource: "estimate" } });
    await event({ ...o1, runId: "r-done", credits: 4 });
    await event({ ...o1, runId: "r-busy", providerCost: 10, metadata: { costSource: "provider" } });
    // A charged search session, and chat-session work outside any turn (no search charge: never an item).
    await event({ ...o1, providerCost: 0.6, metadata: { sessionId: "s1", costSource: "provider" } });
    await event({ ...o1, credits: 0.1, metric: "search-query", metadata: { sessionId: "s1" } });
    await event({ ...o1, providerCost: 9, metadata: { sessionId: "chat-session", costSource: "provider" } });
    // A non-numeric cost counts as 0 instead of failing the query.
    await event({ ...o1, providerCost: "lots", metadata: { chatTurnId: "tBad" } });

    const { items, orgs } = await attribution.providerCostLossItems(window());
    expect(items.map((item) => [item.kind, item.key, item.lossCents])).toEqual([
      ["run", "r-done", 6], ["chat-turn", "tA", 2], ["chat-turn", "tC", 2], ["search-session", "s1", 0.5],
    ]);
    // Org totals exclude the refunded turn.
    expect(orgs).toEqual([expect.objectContaining({ orgId: "o1", lossCents: 8.5, items: 3, refundedItems: 1 })]);
    expect(items.find((item) => item.key === "r-done")).toMatchObject({ estimatedCostCents: 10, creditCents: 4, refunded: false, orgId: "o1" });
    expect(items.find((item) => item.key === "tA")).toMatchObject({ topModel: "vendor/expensive", estimatedCostCents: 0 });
    expect(items.find((item) => item.key === "tC")?.refunded).toBe(true);
  });

  it("flags an OCR run at the 4000 px opt-in with escalation: VM cost at the sandbox rate plus the escalation read exceed the Rich page", async () => {
    const { modalSandboxCostCents } = await import("@docslurp/shared");
    const o1 = { org: "o1", workspace: "w1", user: "u1" };
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, updated_at) values
      ('r-ocr-4000', 'o1', 'u1', 'w1', 'bulk-upload', 'completed', 'completed', '{}', ${tenMinutesAgo}),
      ('r-ocr-2000', 'o1', 'u1', 'w1', 'bulk-upload', 'completed', 'completed', '{}', ${tenMinutesAgo})`;
    // One dense image each: the OCR VM's sandbox_compute event (cost at the sandbox rate, 2 cores), the escalation read's
    // provider cost (DeepInfra Qwen3-VL-30B, 1,500 in / 800 out tokens: 0.0705 cents) and the one Rich page charged (0.25).
    const escalationCents = (1_500 * 0.15 + 800 * 0.6) / 1e6 * 100;
    for (const [runId, seconds, memoryGib] of [["r-ocr-4000", 18.6, 3], ["r-ocr-2000", 14.1, 2]] as const) {
      await event({ ...o1, runId, model: "ocr-vm", metric: "sandbox_compute", providerCost: modalSandboxCostCents({ cores: 2, memoryGib, seconds }), metadata: { costSource: "estimate" } });
      await event({ ...o1, runId, model: "Qwen/Qwen3-VL-30B-A3B-Instruct", metric: "ocr-escalation", providerCost: escalationCents, metadata: { costSource: "provider" } });
      await event({ ...o1, runId, model: "price-card", metric: "ingest-page-rich", credits: 0.25 });
    }
    const { items } = await attribution.providerCostLossItems(window());
    // 0.1839 + 0.0705 = 0.2544 cents against 0.25 credits: a loss. At the 2000 px default (0.1300 + 0.0705) it is profitable.
    expect(items.map((item) => item.key)).toEqual(["r-ocr-4000"]);
    expect(items[0]!.lossCents).toBeCloseTo(0.0044, 3);
    expect(items[0]!.topModel).toBe("ocr-vm");
  });

  it("judges a run at its terminal status change, even long after its last event", async () => {
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, updated_at)
      values ('r-late', 'o1', 'u1', 'w1', 'bulk-upload', 'failed', 'failed', '{}', ${new Date(Date.now() - 5 * 60_000)})`;
    await event({ org: "o1", workspace: "w1", user: "u1", runId: "r-late", providerCost: 3, at: new Date(Date.now() - 3 * 60 * 60_000) });
    const { items } = await attribution.providerCostLossItems(window());
    expect(items.map((item) => item.key)).toEqual(["r-late"]);
  });

  it("keeps organizations apart and honours the window", async () => {
    // The same turn id in two orgs never merges.
    await event({ org: "o1", workspace: "w1", user: "u1", providerCost: 2, metadata: { chatTurnId: "shared" } });
    await event({ org: "o2", workspace: "w2", user: "u2", credits: 10, metadata: { chatTurnId: "shared" } });
    // Older than the window, and too recent to have settled.
    await event({ org: "o1", workspace: "w1", user: "u1", providerCost: 5, metadata: { chatTurnId: "old" }, at: new Date(Date.now() - 2 * 60 * 60_000) });
    await event({ org: "o1", workspace: "w1", user: "u1", providerCost: 5, metadata: { chatTurnId: "fresh" }, at: new Date() });
    const { items } = await attribution.providerCostLossItems(window());
    expect(items.map((item) => [item.orgId, item.key, item.lossCents])).toEqual([["o1", "shared", 2]]);
  });
});
