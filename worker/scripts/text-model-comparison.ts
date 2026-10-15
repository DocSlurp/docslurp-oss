/** Generic external-fixture comparison; never import labels into production code. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouterUsageCapture, createOpenRouterReasoningFetch, resolveOpenRouterUsage, resolvePipelineTextGenerationOptions, type PipelineTextOperation, type TextGenerationProfile } from "../../packages/shared/src/index.js";
import { withObservation, aiResultDetails, flushObservability } from "../../packages/shared/src/observability.js";
import { generateOpenRouterText } from "../src/lib/ai.js";
import { buildTrustedDocumentTaskPrompt } from "../src/lib/trusted-llm-task.js";
import { PipelineUsageEventLedger } from "../src/pipeline/usage-ledger.js";
import "../src/env.js";
import { scoreTextCase, summarizeTextResults } from "../../scripts/lib/text-model-scoring.mjs";
import { judgeEvaluationIntegrity } from "../../scripts/evaluation-integrity-judge.mjs";
import { validateTextExperiment } from "../../scripts/lib/text-model-experiment.mjs";
import { textCallKey, textResumeResults } from "../../scripts/lib/text-model-resume.mjs";

type ReasoningEffort = "none" | "low" | "medium" | "high" | "max";
interface Arm { id: string; workerProfile?: TextGenerationProfile; reasoningEffort?: ReasoningEffort; modelReasoningEfforts?: Record<string, ReasoningEffort>; systemSuffix?: string; systemSuffixes?: Partial<Record<PipelineTextOperation, string>>; maxOutputTokens?: Partial<Record<PipelineTextOperation, number>> }
interface Experiment { version: 1; models: string[]; budgetUsd: number; concurrency: number; repeats: number; arms: Arm[] }
const experimentIndex = process.argv.indexOf("--experiment");
const experimentPath = experimentIndex >= 0 ? process.argv[experimentIndex + 1] : undefined;
const resumeIndex = process.argv.indexOf("--resume");
const resumeDirectory = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined;
assert(resumeIndex < 0 || resumeDirectory, "Missing --resume evidence directory");
const reserveUnknownCosts = process.argv.includes("--reserve-unknown-costs");
assert(experimentIndex < 0 || experimentPath, "Missing --experiment JSON path");
const experiment: Experiment = experimentPath ? validateTextExperiment(JSON.parse(await readFile(experimentPath, "utf8"))) : {
  version: 1, models: ["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "openai/gpt-6-luna", "openai/gpt-6.1-sol"],
  budgetUsd: 1, concurrency: 4, repeats: 1, arms: [{ id: "production-default" }, { id: "low-reasoning", reasoningEffort: "low" }],
};
const ids = experiment.models;
assert(process.argv[2], "Usage: tsx worker/scripts/text-model-comparison.ts EXTERNAL_DATASET_DIR [--validate] [--experiment JSON_PATH]");
const dataset = path.resolve(process.argv[2]);
const sessionId = randomUUID();
const directory = path.resolve(".tmp/text-model-comparison", sessionId);
await mkdir(directory, { recursive: true });
const integrity = await judgeEvaluationIntegrity({ repoRoot: process.cwd(), datasetDir: dataset });
await writeFile(path.join(directory, "integrity.json"), JSON.stringify(integrity, null, 2));
assert(integrity.passed, "Separate evaluation integrity gate must pass before inference");
const casesBytes = await readFile(path.join(dataset, "cases.json"));
interface Case { id: string; operation: PipelineTextOperation; instruction: string; outputContract: string; text: string; maxOutputTokens: number; context?: Array<{ label: string; value: string }> }
const cases = JSON.parse(casesBytes.toString()) as Case[];
const datasetSha256 = createHash("sha256").update(casesBytes).digest("hex");
const previousProvenance = resumeDirectory ? JSON.parse(await readFile(path.join(resumeDirectory, "provenance.json"), "utf8")) : undefined;
const previousSummary = resumeDirectory ? JSON.parse(await readFile(path.join(resumeDirectory, "summary.json"), "utf8")) : undefined;
const priorResults: Array<Record<string, any>> = previousSummary ? textResumeResults(previousProvenance, previousSummary, { datasetSha256, experiment }) : [];
const priorKeys = new Set(priorResults.map(textCallKey));
assert(cases.length > 0 && cases.every(c => Number.isInteger(c.maxOutputTokens) && c.maxOutputTokens > 0 && c.maxOutputTokens <= 4096));
if (process.argv.includes("--validate")) {
  console.log(JSON.stringify({ directory, cases: cases.length, integrityPassed: integrity.passed, inferenceCalls: 0 }));
  process.exit(0);
}
const key = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY;
assert(key, "OpenRouter credentials required");
const budgetUsd = experiment.budgetUsd;
const catalogResponse = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20_000) });
assert(catalogResponse.ok, "Cannot verify current model pricing");
const catalog = await catalogResponse.json() as { data: Array<{ id: string; pricing: Record<string, string>; reasoning?: { mandatory?: boolean; supported_efforts?: string[] | null } }> };
const prices = new Map<string, { input: number; output: number }>();
for (const id of ids) {
  assert(!/(?:^|[-_/])(?:pro|ultra)(?:$|[-_/])/i.test(id));
  const model = catalog.data.find(m => m.id === id);
  assert(model, `Requested model unavailable: ${id}`);
  for (const arm of experiment.arms) {
    const effort = arm.modelReasoningEfforts?.[id] ?? arm.reasoningEffort ?? (arm.workerProfile === "grounded-low" ? "low" : undefined);
    if (effort === "none") assert(model.reasoning && model.reasoning.mandatory === false, `Thinking cannot be disabled: ${id}`);
    else if (effort) assert(model.reasoning && (model.reasoning.supported_efforts === null || model.reasoning.supported_efforts?.includes(effort)), `Unsupported reasoning effort ${effort}: ${id}`);
  }
  const response = await fetch(`https://openrouter.ai/api/v1/models/${id}/endpoints`, { signal: AbortSignal.timeout(20_000) });
  assert(response.ok, `Cannot verify endpoint prices: ${id}`);
  const endpoints = await response.json() as { data: { endpoints: Array<{ pricing: Record<string, string>; [key: string]: unknown }> } };
  await writeFile(path.join(directory, `${id.replaceAll("/", "-")}-endpoints.json`), JSON.stringify(endpoints, null, 2));
  const rates = endpoints.data.endpoints.map(e => ({ input: Number(e.pricing.prompt), output: Number(e.pricing.completion) }));
  assert(rates.length && rates.every(r => Number.isFinite(r.input) && r.input >= 0 && Number.isFinite(r.output) && r.output >= 0 && r.output * 1e6 < 50), `Unknown/prohibited endpoint pricing: ${id}`);
  prices.set(id, { input: Math.max(...rates.map(r => r.input)), output: Math.max(...rates.map(r => r.output)) });
}
const resumeChain = resumeDirectory ? [...(previousProvenance.resumeChain ?? []), path.resolve(resumeDirectory)] : [];
await writeFile(path.join(directory, "provenance.json"), JSON.stringify({ sessionId, dataset, datasetSha256, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), budgetUsd, routing: "automatic OpenRouter routing; same SDK as worker", experiment, resumeChain, priorCalls: priorResults.length, reserveUnknownCosts, pricingVerifiedAt: new Date().toISOString(), catalog: catalog.data.filter(m => ids.includes(m.id)), integrity }, null, 2));
const db = new DatabaseSync(path.join(directory, "usage.sqlite"));
db.exec("CREATE TABLE usage_events (id TEXT PRIMARY KEY, session_id TEXT, org_id TEXT, workspace_id TEXT, run_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_cents REAL, event_json TEXT)");
const insert = db.prepare("INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const ledger = new PipelineUsageEventLedger();
function persist() {
  const batch = ledger.checkpoint();
  db.exec("BEGIN");
  try {
    for (const e of batch.events) insert.run(e.id!, sessionId, "synthetic-evaluation", sessionId, sessionId, e.model, e.inputTokens ?? null, e.outputTokens ?? null, e.costCents, JSON.stringify(e));
    db.exec("COMMIT");
    batch.commit();
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
let spent = priorResults.reduce((sum, row) => sum + (row.usage?.metadata?.costSource === "provider" ? row.usage.costCents / 100 : 0), 0);
let reserved = 0;
let unknownCost = priorResults.some(row => row.usage?.metadata?.costSource !== "provider");
let unknownReservedUsd = 0;
for (const row of priorResults) {
  if (row.usage?.metadata?.costSource === "provider") continue;
  const fixture = cases.find(c => c.id === row.caseId)!;
  const price = prices.get(row.model)!;
  // Older evidence omitted reservations for empty responses. Bound every input
  // byte plus task/schema framing and three SDK attempts, without calling it a charge.
  const bytes = Buffer.byteLength(JSON.stringify(fixture)) + 8192;
  const bound = 3 * (bytes * price.input + (row.maxOutputTokens ?? fixture.maxOutputTokens) * price.output);
  row.reservedWorstCaseUsd = Math.max(row.reservedWorstCaseUsd ?? 0, bound);
  unknownReservedUsd += row.reservedWorstCaseUsd;
}
const results: Array<Record<string, unknown>> = [...priorResults];
console.log(JSON.stringify({ directory, budgetUsd, calls: cases.length * ids.length * experiment.arms.length * experiment.repeats - priorResults.length, priorCalls: priorResults.length, unknownReservedUsd }));
const planned = Array.from({ length: experiment.repeats }, (_, repeat) => cases.flatMap((fixture, i) => experiment.arms.flatMap((_, j) => {
  const arm = experiment.arms[(i + j + repeat) % experiment.arms.length]!;
  return ids.map((_, k) => ({ settings: arm, repeat, arm: arm.id, fixture, model: ids[(i + k + repeat) % ids.length]! }));
}))).flat().filter(call => !priorKeys.has(textCallKey({ ...call, caseId: call.fixture.id })));
let index = 0;
async function worker() {
  while (index < planned.length) {
    const plannedCall = planned[index++]!;
    const { arm, repeat, fixture, model } = plannedCall;
    const settings = { ...plannedCall.settings, reasoningEffort: plannedCall.settings.modelReasoningEfforts?.[model] ?? plannedCall.settings.reasoningEffort };
    const task = fixture.operation === "community-summary" ? { system: fixture.instruction, prompt: fixture.text }
      : buildTrustedDocumentTaskPrompt({ instruction: fixture.instruction, outputContract: fixture.outputContract, untrustedContent: fixture.text,
          untrustedContentLabel: fixture.operation === "contextual-chunk-preamble" ? "document excerpt" : fixture.operation === "proposition-extraction" ? "paragraph" : "document text", trustedContext: fixture.context });
    if (settings.systemSuffix) task.system += `\n\n${settings.systemSuffix}`;
    if (settings.systemSuffixes?.[fixture.operation]) task.system += `\n\n${settings.systemSuffixes[fixture.operation]}`;
    const workerTextConfig = settings.workerProfile ? { model: null, models: {}, profile: settings.workerProfile, reasoningEffort: settings.reasoningEffort, maxOutputTokens: settings.maxOutputTokens } : undefined;
    const maxOutputTokens = workerTextConfig ? resolvePipelineTextGenerationOptions({ operation: fixture.operation, config: workerTextConfig, maxOutputTokens: fixture.maxOutputTokens }).maxOutputTokens : settings.maxOutputTokens?.[fixture.operation] ?? fixture.maxOutputTokens;
    // ASCII fixture bytes upper-bound input token count; 3 attempts is the SDK
    // default retry ceiling. Reserve the most expensive advertised route.
    const price = prices.get(model)!;
    const reservation = 3 * ((Buffer.byteLength(task.system + task.prompt) + 8192) * price.input + maxOutputTokens * price.output);
    if ((unknownCost && !reserveUnknownCosts) || spent + unknownReservedUsd + reserved + reservation > budgetUsd) {
      results.push({ model, arm, repeat, caseId: fixture.id, skipped: "budget-reservation" });
      continue;
    }
    reserved += reservation;
    const started = performance.now();
    let result: Record<string, unknown>;
    try {
      const args = { operation: fixture.operation, apiKey: key!, model, system: task.system, prompt: task.prompt, maxOutputTokens, privacyMode: "standard" as const, signal: AbortSignal.timeout(120_000) };
      let requestSettings: unknown;
      const answer = await withObservation({ name: "eval.text-model-comparison", metadata: { sessionId, evaluation: true, arm, repeat, caseId: fixture.id } }, async () => settings.workerProfile || (!experimentPath && arm === "production-default") ? await generateOpenRouterText({ ...args, textGeneration: workerTextConfig })
        : await withObservation({ name: `eval.text.${fixture.operation}`, type: "generation", model, metadata: { sessionId, arm }, result: aiResultDetails }, async () => {
            const capture = createOpenRouterUsageCapture();
            const provider = createOpenAI({ apiKey: key!, baseURL: "https://openrouter.ai/api/v1", fetch: createOpenRouterReasoningFetch(async (input, init) => {
              if (typeof init?.body === "string") {
                const body = JSON.parse(init.body);
                requestSettings = { reasoning: body.reasoning, reasoningEffort: body.reasoning_effort, maxOutputTokens: body.max_output_tokens ?? body.max_tokens };
                if (settings.reasoningEffort === "none") assert(body.reasoning?.enabled === false, "SDK omitted thinking disable control");
                else if (settings.reasoningEffort) assert((body.reasoning?.effort ?? body.reasoning_effort) === settings.reasoningEffort, "SDK omitted requested reasoning effort");
              }
              return capture.fetch(input, init);
            }, settings.reasoningEffort) });
            const response = await generateText({ model: provider(model), system: task.system, prompt: task.prompt, maxOutputTokens,
              maxRetries: 0, abortSignal: args.signal,
              providerOptions: settings.reasoningEffort ? { openai: { reasoningEffort: settings.reasoningEffort, forceReasoning: true } } : undefined });
            return { text: response.text, finishReason: response.finishReason, warnings: response.warnings, usage: await resolveOpenRouterUsage({ apiKey: key!, model, providerName: capture.providerName(), generationId: response.response.id,
              usage: { ...response.usage, raw: capture.usage() ?? response.usage.raw } }) };
          }));
      const latencyMs = performance.now() - started;
      const generationId = answer.usage.metadata?.generationId;
      let receipt: unknown;
      if (typeof generationId === "string") {
        try {
          const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
          if (response.ok) receipt = await response.json();
        } catch { receipt = { unavailable: true }; }
      }
      const cost = answer.usage.costCents;
      const costKnown = typeof cost === "number" && answer.usage.metadata?.costSource === "provider";
      if (!costKnown) { unknownCost = true; unknownReservedUsd += reservation; }
      else spent += cost / 100;
      const event = ledger.record({ provider: "openrouter", model, metric: `text-model-eval.${fixture.operation}`, inputTokens: answer.usage.inputTokens, outputTokens: answer.usage.outputTokens,
        costCents: cost ?? 0, metadata: { ...answer.usage.metadata, sessionId, orgId: "synthetic-evaluation", workspaceId: sessionId, runId: sessionId, caseId: fixture.id, arm,
          receipt, repeat, settings, requestSettings, costMissing: cost === undefined } });
      if (!event) ledger.enqueue({ id: randomUUID(), provider: "openrouter", model, metric: `text-model-eval.${fixture.operation}`, amount: 1, unit: "attempt", costCents: 0,
        metadata: { ...answer.usage.metadata, sessionId, orgId: "synthetic-evaluation", workspaceId: sessionId, runId: sessionId, caseId: fixture.id, arm, repeat,
          usageUnavailable: !costKnown, costUnavailable: !costKnown, reservedWorstCaseUsd: costKnown ? 0 : reservation } }, { logAiUsage: true });
      persist();
      result = { model, arm, repeat, settings, requestSettings, maxOutputTokens, finishReason: "finishReason" in answer ? answer.finishReason : undefined,
        warnings: "warnings" in answer ? answer.warnings : undefined, caseId: fixture.id, operation: fixture.operation, latencyMs, text: answer.text, usage: answer.usage, receipt,
        reservedWorstCaseUsd: reservation, scores: scoreTextCase(fixture, answer.text) };
    } catch (error) {
      // A failed request can still have charged upstream tokens. Default to a
      // stop; explicit bounded continuation retains the full reservation.
      unknownCost = true;
      unknownReservedUsd += reservation;
      result = { model, arm, repeat, caseId: fixture.id, operation: fixture.operation, latencyMs: performance.now() - started, error: error instanceof Error ? error.message : String(error), reservedWorstCaseUsd: reservation };
      ledger.enqueue({ id: randomUUID(), provider: "openrouter", model, metric: `text-model-eval.failed`, amount: 1, unit: "attempt", costCents: 0,
        metadata: { sessionId, orgId: "synthetic-evaluation", workspaceId: sessionId, runId: sessionId, arm, repeat, caseId: fixture.id, usageUnavailable: true, costUnavailable: true, reservedWorstCaseUsd: reservation } }, { logAiUsage: true });
      persist();
    } finally { reserved -= reservation; }
    results.push(result);
    await appendFile(path.join(directory, "results.jsonl"), JSON.stringify(result) + "\n");
    await writeFile(path.join(directory, "summary.json"), JSON.stringify({ sessionId, spentUsd: spent, unknownCost, unknownReservedUsd, resumeChain, pendingReservedUsd: reserved, completed: results.filter(r => !r.skipped).length,
      results, summary: summarizeTextResults(results) }, null, 2));
    console.log(JSON.stringify({ model, arm, caseId: fixture.id, quality: (result.scores as { quality?: number } | undefined)?.quality, error: result.error, latencyMs: result.latencyMs, spentUsd: spent }));
  }
}
try { await Promise.all(Array.from({ length: experiment.concurrency }, () => worker())); }
finally {
  persist(); db.close(); await flushObservability();
  await writeFile(path.join(directory, "summary.json"), JSON.stringify({ sessionId, spentUsd: spent, unknownCost, unknownReservedUsd, resumeChain, completed: results.filter(r => !r.skipped).length, results, summary: summarizeTextResults(results) }, null, 2));
  console.log(JSON.stringify({ final: true, directory, spentUsd: spent, unknownCost, unknownReservedUsd }));
}
