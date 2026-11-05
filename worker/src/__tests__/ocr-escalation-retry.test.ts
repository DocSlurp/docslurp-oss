import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { Store } from "../db/store.js";
import { persistRunUsageEvents } from "../db/usage-event-store.js";
import type { VisionRequestGate } from "../lib/vision-attempt-guard.js";
import type { WorkspaceRun } from "../models.js";
import { createHostedOcrReader } from "../ocr/hosted-reader.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { pngHeader } from "../test/fake-ocr.js";
import { startMigratedPostgres } from "../test/migrated-postgres.js";
import type { CommandRunner } from "../tools/runner.js";
import type { executeVisionRuntime, VisionExecutionResult } from "../tools/vision-runtime.js";
import { attachVisionBilledUsage } from "../tools/vision-stream.js";

/**
 * OCR escalation across activity retries (migration 0129): a retried activity reuses a page's persisted read instead of
 * calling DeepInfra again; every real call, failed ones included, is ledgered once with its provider cost and counts against
 * the document's attempt budget; the persisted row carries providerCostCents (cost_cents 0) for the provider-cost loss alert.
 */
const MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct";
const CFG = { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;
let stop: () => Promise<void>;
let pglite: Awaited<ReturnType<typeof startMigratedPostgres>>["db"];
let url: string;
let scratch: string;
let shared: Store;
let admin: ReturnType<typeof sql>;

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  pglite = database.db;
  url = database.url;
  // PGlite serves one connection: every "activity" shares this store; each gets a fresh state, ledger and guard.
  shared = new Store(url, 60_000, { poolMax: 1, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  admin = sql(shared);
  await admin`insert into "user" (id, name, email) values ('esc-u', 'U', 'esc-u@example.com')`;
  await admin`insert into organizations (id, name, slug, created_by_user_id) values ('esc-org', 'O', 'esc-org', 'esc-u')`;
  await admin`insert into workspaces (id, org_id, user_id, name) values ('esc-ws', 'esc-org', 'esc-u', 'W')`;
  for (const id of ["esc-run-1", "esc-run-2", "esc-run-3", "esc-run-role", "esc-run-race"]) {
    await admin`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, artifacts)
      values (${id}, 'esc-org', 'esc-u', 'esc-ws', 'bulk-upload', 'processing', 'extract-markdown', '{}', '{}')`;
  }
  scratch = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "docslurp-esc-retry-"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}, 120_000);

afterAll(async () => {
  await shared?.close();
  await stop?.();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const success = (): VisionExecutionResult => ({
  runtime: "openai-compatible", provider: "deepinfra", model: MODEL, prompt: "p", text: "Hosted transcription", raw: "", latencyMs: 1,
  inputTokens: 1_500, outputTokens: 400, usageSource: "provider", costCents: 0.05, baseUrl: "https://api.deepinfra.com/v1/openai",
  fallbackUsed: false, route: { runtime: "openai-compatible", baseUrl: "https://api.deepinfra.com/v1/openai", provider: "deepinfra", model: MODEL, billing: "deepinfra" },
}) as unknown as VisionExecutionResult;

/** A fresh activity: a new pool, store, guard and ledger, as a retried Temporal activity has. */
function activity(runId: string, execute: typeof executeVisionRuntime, env: NodeJS.ProcessEnv = {}) {
  const created = shared;
  const state = WorkflowState.create({
    id: runId, orgId: "esc-org", workspaceId: "esc-ws", userId: "esc-u", artifacts: {}, stats: {}, stage: "extract-markdown", spentCents: 0,
    pipeline: { vision: { target: "remote", modelUri: "llm://openrouter/google/gemini-3.1-flash-lite", maxPagesPerDocument: 1_000 }, privacyMode: "standard", visionFallback: true },
  } as unknown as WorkspaceRun, []);
  state.store = created;
  state.visionAttempts = created.visionAttempts;
  state.usageLedger.runId = runId;
  const reader = createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: { DOCSLURP_OCR_ESCALATION: "on", ...env }, execute });
  return { state, reader, store: created };
}

async function frame(name: string): Promise<string> {
  const imagePath = path.join(scratch, `${name}.png`);
  await writeFile(imagePath, pngHeader(100, 50));
  return imagePath;
}

function sql(store: Store) { return (store as unknown as { sql: Parameters<typeof persistRunUsageEvents>[0]["client"] }).sql; }

describe("OCR escalation across activity retries", () => {
  it("reuses a persisted read on retry instead of calling the provider again, and ledgers its cost once", async () => {
    const execute = vi.fn(async (args: Parameters<typeof executeVisionRuntime>[0]) => {
      await (args.gate as VisionRequestGate | null | undefined)?.admit();
      return success();
    });
    // Attempt 1 reads the page, then the activity dies before its checkpoint: its buffered usage is lost.
    const first = activity("esc-run-1", execute);
    const page = { documentId: "doc-1", pageNumber: 3, imagePath: await frame("r1"), mimeType: "image/png" };
    expect((await first.reader.read(page, "ocr-escalation")).text).toBe("Hosted transcription");
    expect(execute).toHaveBeenCalledTimes(1);

    // The retried activity reuses the read: no second provider call, and the first call's cost is buffered again.
    const retry = activity("esc-run-1", execute);
    expect((await retry.reader.read({ ...page, imagePath: await frame("r1b") }, "ocr-escalation")).text).toBe("Hosted transcription");
    expect(execute).toHaveBeenCalledTimes(1);
    const batch = retry.state.usageLedger.checkpoint();
    await persistRunUsageEvents({ client: sql(retry.store), state: retry.state, usageEvents: batch.events });
    batch.commit();
    // And a third activity that persists again changes nothing: the call is one usage row.
    const again = activity("esc-run-1", execute);
    await again.reader.read({ ...page, imagePath: await frame("r1c") }, "ocr-escalation");
    const replay = again.state.usageLedger.checkpoint();
    await persistRunUsageEvents({ client: sql(again.store), state: again.state, usageEvents: replay.events });
    const rows = await admin<{ id: string; cost_cents: string; provider_cost: number }[]>`
      select id, cost_cents::text, (metadata ->> 'providerCostCents')::float8 as provider_cost
      from usage_events where run_id = 'esc-run-1' and metric = 'ocr-escalation'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toMatch(/^ocr-escalation:esc-run-1:doc-1:3:[0-9a-f-]{36}$/);
    // The loss alert reads providerCostCents: the escalation row bills 0 credits and keeps its provider cost.
    expect(Number(rows[0]!.cost_cents)).toBe(0);
    expect(rows[0]!.provider_cost).toBeGreaterThan(0);
  }, 60_000);

  it("records a failed call's cost and calls again on retry, each call counting against the attempt budget", async () => {
    let calls = 0;
    const execute = vi.fn(async (args: Parameters<typeof executeVisionRuntime>[0]) => {
      await (args.gate as VisionRequestGate | null | undefined)?.admit();
      calls += 1;
      if (calls === 1) {
        // The production path: the vision runtime attaches the billed usage to the error it throws.
        const error = new Error("upstream reset after the response was billed");
        attachVisionBilledUsage(error, { inputTokens: 1_500, outputTokens: 120, costCents: 0.03, usageSource: "provider" });
        throw error;
      }
      return success();
    });
    const first = activity("esc-run-2", execute);
    const page = { documentId: "doc-2", pageNumber: 1, imagePath: await frame("f1"), mimeType: "image/png" };
    await expect(first.reader.read(page, "ocr-escalation")).rejects.toThrow();
    // The first activity dies before its checkpoint: only the persisted read carries the failed call's usage.
    const retry = activity("esc-run-2", execute);
    expect((await retry.reader.read({ ...page, imagePath: await frame("f2") }, "ocr-escalation")).text).toBe("Hosted transcription");
    expect(execute).toHaveBeenCalledTimes(2);
    const reads = await admin<{ attempt: number; status: string }[]>`
      select attempt, status from ocr_escalation_reads where run_id = 'esc-run-2' order by attempt`;
    expect(reads).toEqual([{ attempt: 1, status: "failed" }, { attempt: 2, status: "completed" }]);
    // A third activity replays both persisted calls; persisting twice records each exactly once.
    for (const replayed of [retry, activity("esc-run-2", execute)]) {
      if (replayed !== retry) await replayed.reader.read({ ...page, imagePath: await frame("f3") }, "ocr-escalation");
      const batch = replayed.state.usageLedger.checkpoint();
      await persistRunUsageEvents({ client: sql(replayed.store), state: replayed.state, usageEvents: batch.events });
      batch.commit();
    }
    expect(execute).toHaveBeenCalledTimes(2);
    const receipts = await admin<{ metric: string; input_tokens: number; output_tokens: number; cost_cents: string; provider_cost: number }[]>`
      select metric, input_tokens, output_tokens, cost_cents::text, (metadata ->> 'providerCostCents')::float8 as provider_cost
      from usage_events where run_id = 'esc-run-2' and metric in ('page-analysis-attempt', 'ocr-escalation') order by metric`;
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ metric: "ocr-escalation", input_tokens: 1_500, output_tokens: 400 });
    expect(receipts[0]!.provider_cost).toBeGreaterThan(0);
    expect(receipts[1]).toMatchObject({ metric: "page-analysis-attempt", input_tokens: 1_500, output_tokens: 120 });
    expect(receipts[1]!.provider_cost).toBeCloseTo(0.03);
    // Both calls were admitted by the durable guard: they count against the document's attempt budget.
    const [attempts] = await admin<{ attempts: number }[]>`
      select coalesce(sum(attempts), 0)::int as attempts from vision_run_attempts where run_id = 'esc-run-2' and document_id = 'doc-2' and purpose = 'ocr'`;
    expect(attempts?.attempts).toBe(2);
  }, 60_000);

  it("two overlapping calls of the same page both persist and both ledger their cost, within the attempt budget", async () => {
    // A barrier: both calls are in flight (both have read the page's persisted rows) before either returns.
    let arrived = 0;
    let sent = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async (args: Parameters<typeof executeVisionRuntime>[0]) => {
      await (args.gate as VisionRequestGate | null | undefined)?.admit();
      sent += 1; // past the durable guard's admission
      arrived += 1;
      if (arrived === 2) release();
      await together;
      return success();
    });
    const env = { DOCSLURP_OCR_ESCALATION_MAX_ATTEMPTS: "2" };
    const page = { documentId: "doc-race", pageNumber: 1, mimeType: "image/png" };
    const a = activity("esc-run-race", execute, env);
    const b = activity("esc-run-race", execute, env);
    const [ra, rb] = await Promise.all([
      a.reader.read({ ...page, imagePath: await frame("race-a") }, "ocr-escalation"),
      b.reader.read({ ...page, imagePath: await frame("race-b") }, "ocr-escalation"),
    ]);
    expect([ra.text, rb.text]).toEqual(["Hosted transcription", "Hosted transcription"]);
    expect(sent).toBe(2);
    const reads = await admin<{ attempt: number; status: string }[]>`
      select attempt, status from ocr_escalation_reads where run_id = 'esc-run-race' order by attempt`;
    expect(reads).toEqual([{ attempt: 1, status: "completed" }, { attempt: 2, status: "completed" }]);
    for (const done of [a, b]) {
      const batch = done.state.usageLedger.checkpoint();
      await persistRunUsageEvents({ client: sql(done.store), state: done.state, usageEvents: batch.events });
      batch.commit();
    }
    const receipts = await admin<{ id: string; provider_cost: number }[]>`
      select id, (metadata ->> 'providerCostCents')::float8 as provider_cost from usage_events where run_id = 'esc-run-race' and metric = 'ocr-escalation'`;
    expect(new Set(receipts.map((row) => row.id)).size).toBe(2);
    for (const row of receipts) expect(row.provider_cost).toBeGreaterThan(0);
    // The budget held: two admitted calls, and a third is refused before the provider.
    const [attempts] = await admin<{ attempts: number }[]>`
      select coalesce(sum(attempts), 0)::int as attempts from vision_run_attempts where run_id = 'esc-run-race' and document_id = 'doc-race' and purpose = 'ocr'`;
    expect(attempts?.attempts).toBe(2);
    await expect(activity("esc-run-race", execute, env).reader.read({ ...page, pageNumber: 2, imagePath: await frame("race-c") }, "ocr-escalation"))
      .rejects.toMatchObject({ name: "HostedOcrSkipped", reason: "budget" });
    expect(sent).toBe(2); // the third request was refused at admission, before the provider
  }, 60_000);

  it("refuses a call past the document's total attempt budget, retries included", async () => {
    let sent = 0;
    const execute = vi.fn(async (args: Parameters<typeof executeVisionRuntime>[0]) => {
      await (args.gate as VisionRequestGate | null | undefined)?.admit();
      sent += 1;
      throw new Error("provider error");
    });
    const env = { DOCSLURP_OCR_ESCALATION_MAX_ATTEMPTS: "2" };
    const page = { documentId: "doc-3", pageNumber: 1, mimeType: "image/png" };
    await expect(activity("esc-run-3", execute, env).reader.read({ ...page, imagePath: await frame("b1") }, "ocr-escalation")).rejects.toThrow();
    await expect(activity("esc-run-3", execute, env).reader.read({ ...page, pageNumber: 2, imagePath: await frame("b2") }, "ocr-escalation")).rejects.toThrow();
    // A third request of the document, on any page, is refused before reaching the provider.
    await expect(activity("esc-run-3", execute, env).reader.read({ ...page, pageNumber: 3, imagePath: await frame("b3") }, "ocr-escalation"))
      .rejects.toMatchObject({ name: "HostedOcrSkipped", reason: "budget" });
    expect(sent).toBe(2); // the refused request never reached the provider
  }, 60_000);

  it("runs as the restricted worker role: writes a read, reads it back, reuses it on retry, and may not update or delete it", async () => {
    // The production grants (server/db/roles.mjs), reconciled onto this database, then this store's one connection becomes
    // docslurp_worker for the whole flow: guard admission, the escalation write, the retry's read and the usage persist.
    const rolesModule = pathToFileURL(path.resolve(import.meta.dirname, "../../../server/db/roles.mjs")).href;
    const { DEFAULT_DB_ROLES, reconcileRoleGrants } = await import(/* @vite-ignore */ rolesModule) as {
      DEFAULT_DB_ROLES: { worker: string }; reconcileRoleGrants: (client: unknown, options: { log: () => void }) => Promise<unknown>;
    };
    await pglite.exec(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${DEFAULT_DB_ROLES.worker}') then create role ${DEFAULT_DB_ROLES.worker} nologin; end if; end $$`);
    await reconcileRoleGrants(pglite, { log: () => undefined });
    const execute = vi.fn(async (args: Parameters<typeof executeVisionRuntime>[0]) => {
      await (args.gate as VisionRequestGate | null | undefined)?.admit();
      return success();
    });
    const page = { documentId: "doc-role", pageNumber: 1, mimeType: "image/png" };
    await admin.unsafe(`set role ${DEFAULT_DB_ROLES.worker}`);
    try {
      const [{ current_user: who }] = await admin<{ current_user: string }[]>`select current_user`;
      expect(who).toBe(DEFAULT_DB_ROLES.worker);
      expect((await activity("esc-run-role", execute).reader.read({ ...page, imagePath: await frame("role-1") }, "ocr-escalation")).text).toBe("Hosted transcription");
      const retry = activity("esc-run-role", execute);
      expect((await retry.reader.read({ ...page, imagePath: await frame("role-2") }, "ocr-escalation")).text).toBe("Hosted transcription");
      expect(execute).toHaveBeenCalledTimes(1);
      const batch = retry.state.usageLedger.checkpoint();
      await persistRunUsageEvents({ client: admin, state: retry.state, usageEvents: batch.events });
      for (const statement of ["update ocr_escalation_reads set text = 'x'", "delete from ocr_escalation_reads"]) {
        await expect(admin.unsafe(statement), statement).rejects.toThrow(/permission denied/);
      }
    } finally {
      await admin.unsafe("reset role");
    }
    const [row] = await admin<{ n: number }[]>`select count(*)::int as n from usage_events where run_id = 'esc-run-role' and metric = 'ocr-escalation'`;
    expect(row?.n).toBe(1);
  }, 60_000);
});
