import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { setSpendCheckConfig } from "../db/spend-check.js";
import { Store } from "../db/store.js";
import { authorizeImageFrames } from "../ocr/image-frames.js";
import { VisionRunGuard, type VisionGuardConfig, type VisionRequestGate } from "../lib/vision-attempt-guard.js";
import type { ProjectRun } from "../models.js";
import { createHostedOcrReader } from "../ocr/hosted-reader.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { pngHeader } from "../test/fake-ocr.js";
import type { CommandRunner } from "../tools/runner.js";
import type { executeVisionRuntime, VisionExecutionResult } from "../tools/vision-runtime.js";

/**
 * The OCR escalation page budget and migration 0128 against a real, migrated Postgres (PGlite serves one connection at a
 * time, so it cannot show a race):
 *
 *   OCR_BUDGET_TEST_DATABASE_URL=postgres://… pnpm --filter worker test -- ocr-escalation-budget
 *
 * The budget is counted in vision_run_attempts under the run's advisory lock, so concurrent activities on one run and
 * document (separate pools, as separate workers would have) admit at most the budget between them, and a retried activity
 * starts from the rows its predecessors left.
 */
const url = process.env.OCR_BUDGET_TEST_DATABASE_URL;
const runId = "ocrbudget-run";
const budget = 25;
const config: VisionGuardConfig = {
  pageAttempts: 2, regionAttempts: 4, breakerMinFailures: 1_000, breakerFailureRate: 1, orgLimitCents: 100_000, throttleAllowance: 5,
  routeOverrunLimit: 3, routeWeightCorrectionMax: 4,
};
const MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct";
const CFG = { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;

let admin: postgres.Sql;
const stores: Store[] = [];
let scratch: string;

function store(): Store {
  const created = new Store(url!, 60_000, { poolMax: 4, runEvents: { flushMs: 120_000, maxBuffered: 20_000 } });
  stores.push(created);
  return created;
}

describe.skipIf(!url)("OCR escalation budget on real Postgres", () => {
  beforeAll(async () => {
    admin = postgres(url!, { max: 2, onnotice: () => undefined });
    await admin`insert into "user" (id, name, email) values ('ocrb-u1', 'U', 'ocrb-u1@example.com') on conflict do nothing`;
    await admin`insert into organizations (id, name, slug, created_by_user_id) values ('ocrb-org', 'O', 'ocrb-org', 'ocrb-u1') on conflict do nothing`;
    await admin`insert into projects (id, org_id, user_id, name) values ('ocrb-ws', 'ocrb-org', 'ocrb-u1', 'W') on conflict do nothing`;
    for (const id of [runId, "ocrbudget-run-2"]) {
      await admin`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, artifacts)
        values (${id}, 'ocrb-org', 'ocrb-u1', 'ocrb-ws', 'bulk-upload', 'processing', 'extract-markdown', '{}', '{}') on conflict do nothing`;
    }
    scratch = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "docslurp-ocr-budget-"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  }, 60_000);

  afterAll(async () => {
    for (const created of stores) await created.close();
    await admin?.end();
    if (scratch) await rm(scratch, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("0128: the purpose check accepts ocr and still rejects anything else", async () => {
    await admin`insert into vision_run_attempts (run_id, document_id, page_number, purpose, attempts) values (${runId}, 'check-doc', 1, 'ocr', 1)`;
    await expect(admin`insert into vision_run_attempts (run_id, document_id, page_number, purpose, attempts) values (${runId}, 'check-doc', 2, 'escalate', 1)`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "vision_run_attempts_purpose_check" });
    const [row] = await admin<{ def: string; validated: boolean }[]>`
      select pg_get_constraintdef(oid) as def, convalidated as validated from pg_constraint where conname = 'vision_run_attempts_purpose_check'`;
    expect(row?.def).toContain("'ocr'::text");
    await admin`delete from vision_run_attempts where document_id = 'check-doc'`;
  });

  // Council #338: table-leak reads have their own durable per-document page budget (tableLeakPageCap).
  it("0133: the purpose check accepts table-rescue, whose page budget holds across a retried activity", async () => {
    await admin`insert into vision_run_attempts (run_id, document_id, page_number, purpose, attempts) values (${runId}, 'check-doc', 3, 'table-rescue', 1)`;
    await admin`delete from vision_run_attempts where document_id = 'check-doc'`;
    const cap = 3;
    const admit = async (guard: VisionRunGuard, pageNumber: number) => {
      const gate = guard.call({ documentId: "leak-doc", pageNumber, purpose: "table-rescue", documentPageLimit: cap });
      try { await gate.admit({ weightCents: 0.01 }); return true; } catch { return false; } finally { await gate.finish(); }
    };
    const first = new VisionRunGuard({ id: runId, orgId: "ocrb-org" }, config, store().visionAttempts);
    const results = [];
    for (let page = 1; page <= 10; page++) results.push(await admit(first, page));
    expect(results.filter(Boolean)).toHaveLength(cap);
    // A restarted worker (fresh pool and guard) cannot read a new leak page; ordinary page reads are not counted against it.
    const retry = new VisionRunGuard({ id: runId, orgId: "ocrb-org" }, config, store().visionAttempts);
    expect(await admit(retry, 11)).toBe(false);
    const page = retry.call({ documentId: "leak-doc", pageNumber: 12, purpose: "page" });
    await expect(page.admit({ weightCents: 0.01 })).resolves.toBeUndefined();
    await page.finish();
  }, 60_000);

  // Council #338 re-check: the table-rescue cap holds between concurrent activities, per run and document, and does not
  // touch the page purpose's count or another document's budget.
  it("table-rescue: concurrent activities admit at most the cap between them; other documents and purposes are separate", async () => {
    const cap = 4;
    const activities = [store(), store(), store()].map((created) => new VisionRunGuard({ id: runId, orgId: "ocrb-org" }, config, created.visionAttempts));
    const admit = async (guard: VisionRunGuard, documentId: string, pageNumber: number, purpose: "table-rescue" | "page" = "table-rescue") => {
      const gate = guard.call({ documentId, pageNumber, purpose, ...(purpose === "table-rescue" ? { documentPageLimit: cap } : {}) });
      try { await gate.admit({ weightCents: 0.01 }); return true; } catch { return false; } finally { await gate.finish(); }
    };
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => admit(activities[index % 3]!, "leak-race-doc", index + 1)));
    expect(results.filter(Boolean)).toHaveLength(cap);
    const [rows] = await admin<{ pages: number }[]>`
      select count(*)::int as pages from vision_run_attempts where run_id = ${runId} and document_id = 'leak-race-doc' and purpose = 'table-rescue' and attempts > 0`;
    expect(rows?.pages).toBe(cap);
    // A retry of an admitted page is the same page (its own per-page attempt bound applies), not a new one.
    const admittedPage = results.findIndex(Boolean) + 1;
    expect(await admit(activities[0]!, "leak-race-doc", admittedPage)).toBe(true);
    expect(await admit(activities[1]!, "leak-race-doc", 31)).toBe(false);
    // Ordinary page reads of the same document and another document's leak budget are unaffected.
    expect(await admit(activities[2]!, "leak-race-doc", 32, "page")).toBe(true);
    expect(await admit(activities[2]!, "leak-race-doc-2", 1)).toBe(true);
  }, 60_000);

  it("admits at most the budget between concurrent activities on one run and document, and a retry keeps it", async () => {
    // Two activities with their own pools race for 40 distinct pages of one document, 20 each, interleaved.
    const activities = [store(), store()].map((created) => new VisionRunGuard({ id: runId, orgId: "ocrb-org" }, config, created.visionAttempts));
    const admit = async (guard: VisionRunGuard, documentId: string, pageNumber: number) => {
      const gate = guard.call({ documentId, pageNumber, purpose: "ocr", documentPageLimit: budget });
      try { await gate.admit({ weightCents: 0.01 }); return true; } catch { return false; } finally { await gate.finish(); }
    };
    const results = await Promise.all(Array.from({ length: 40 }, (_, index) => admit(activities[index % 2]!, "race-doc", index + 1)));
    expect(results.filter(Boolean)).toHaveLength(budget);
    const [rows] = await admin<{ pages: number }[]>`
      select count(*)::int as pages from vision_run_attempts where run_id = ${runId} and document_id = 'race-doc' and purpose = 'ocr' and attempts > 0`;
    expect(rows?.pages).toBe(budget);
    // A retried activity (a fresh pool and guard) is refused a new page and may still re-read an admitted one.
    const retry = new VisionRunGuard({ id: runId, orgId: "ocrb-org" }, config, store().visionAttempts);
    const admitted = results.map((ok, index) => (ok ? index + 1 : 0)).filter(Boolean);
    const refused = results.map((ok, index) => (ok ? 0 : index + 1)).filter(Boolean);
    expect(await admit(retry, "race-doc", refused[0]!)).toBe(false);
    expect(await admit(retry, "race-doc", admitted[0]!)).toBe(true);
    // Another document of the run has its own budget.
    expect(await admit(retry, "other-doc", 1)).toBe(true);
  }, 60_000);

  it("fails closed for two TIFFs authorizing at the same time while the spend check's database errors", async () => {
    await admin`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, artifacts)
      values ('ocrb-tiff-run', 'ocrb-org', 'ocrb-u1', 'ocrb-ws', 'bulk-upload', 'processing', 'extract-markdown', '{}', '{}') on conflict do nothing`;
    for (const id of ["ocrb-tiff-a", "ocrb-tiff-b"]) {
      await admin`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source)
        values (${id}, 'ocrb-org', 'ocrb-u1', 'ocrb-ws', 'ocrb-tiff-run', ${`${id}.tiff`}, 'image/tiff', ${`raw/${id}`}, 'processing', 1, 'assumed')`;
    }
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A real database error in the balance read: the function it calls is gone for the duration.
    await admin`alter function org_spend_status(text, text, numeric) rename to org_spend_status_unavailable`;
    try {
      const activities = await Promise.all(["ocrb-tiff-a", "ocrb-tiff-b"].map(async (id) => {
        const created = store();
        const state = WorkflowState.create(await created.loadRun("ocrb-tiff-run"), [(await created.loadDocument(id))!]);
        state.store = created;
        state.usageLedger.runId = "ocrb-tiff-run";
        return { id, state };
      }));
      const outcomes = await Promise.allSettled(activities.map(({ id, state }) => authorizeImageFrames(state, id, "extract-markdown", 30)));
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
      for (const outcome of outcomes) expect((outcome as PromiseRejectedResult).reason).toMatchObject({ name: "SpendCheckUnavailableError" });
      // Nothing charged, the run neither paused nor let through.
      for (const { state } of activities) expect(state.usageLedger.snapshot()).toEqual([]);
      const [run] = await admin<{ control_state: string | null }[]>`select control_state from project_runs where id = 'ocrb-tiff-run'`;
      expect(run?.control_state).toBeNull();
      const [charges] = await admin<{ n: number }[]>`select count(*)::int as n from usage_events where run_id = 'ocrb-tiff-run'`;
      expect(charges?.n).toBe(0);
    } finally {
      await admin`alter function org_spend_status_unavailable(text, text, numeric) rename to org_spend_status`;
      setSpendCheckConfig(null);
    }
  }, 60_000);

  it("sends and records at most the budget's hosted escalation reads across concurrent activities", async () => {
    const run = "ocrbudget-run-2";
    let sent = 0;
    const execute = vi.fn(async (args: Parameters<typeof executeVisionRuntime>[0]): Promise<VisionExecutionResult> => {
      await (args.gate as VisionRequestGate | null | undefined)?.admit();
      sent += 1;
      return {
        runtime: "openai-compatible", provider: "deepinfra", model: MODEL, prompt: "p", text: "Hosted transcription", raw: "", latencyMs: 1,
        inputTokens: 1_500, outputTokens: 400, usageSource: "provider", costCents: 0.05, baseUrl: "https://api.deepinfra.com/v1/openai",
        fallbackUsed: false, route: { runtime: "openai-compatible", baseUrl: "https://api.deepinfra.com/v1/openai", provider: "deepinfra", model: MODEL, billing: "deepinfra" },
      } as unknown as VisionExecutionResult;
    });
    const activity = () => {
      const state = WorkflowState.create({
        id: run, orgId: "ocrb-org", projectId: "ocrb-ws", userId: "ocrb-u1", artifacts: {}, stats: {}, stage: "extract-markdown", spentCents: 0,
        pipeline: { vision: { target: "remote", modelUri: "llm://openrouter/google/gemini-3.1-flash-lite", maxPagesPerDocument: 1_000 }, privacyMode: "standard", visionFallback: true },
      } as unknown as ProjectRun, []);
      state.visionAttempts = store().visionAttempts;
      state.usageLedger.runId = run;
      return { state, reader: createHostedOcrReader({ state, cfg: CFG, runner: {} as CommandRunner, env: { DOCSLURP_OCR_ESCALATION: "on" }, execute }) };
    };
    const [a, b] = [activity(), activity()];
    const read = async (reader: typeof a.reader, pageNumber: number) => {
      const imagePath = path.join(scratch, `frame-${pageNumber}.png`);
      await writeFile(imagePath, pngHeader(100, 50));
      try { await reader.read({ documentId: "doc-esc", pageNumber, imagePath, mimeType: "image/png" }, "ocr-escalation"); return "read"; }
      catch (error) { return (error as { reason?: string }).reason ?? "error"; }
    };
    const outcomes = await Promise.all(Array.from({ length: 36 }, (_, index) => read((index % 2 ? a : b).reader, index + 1)));
    expect(outcomes.filter((outcome) => outcome === "read")).toHaveLength(budget);
    expect(outcomes.filter((outcome) => outcome === "budget")).toHaveLength(36 - budget);
    // Only admitted reads reached the provider, and each is one Rich page at most (25 charges, 6.25 credits).
    expect(sent).toBe(budget);
    const charges = [a, b].flatMap(({ state }) => state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich"));
    expect(charges).toHaveLength(budget);
    expect(new Set(charges.map((event) => event.id)).size).toBe(budget);
  }, 60_000);
});
