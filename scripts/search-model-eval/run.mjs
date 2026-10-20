#!/usr/bin/env node
// Matrix runner: models x cases x limit arms x repeats against POST /v1/chat.
// Gold never leaves this process's dataset read: requests carry the question
// only, each case starts a fresh session, and every attempt is retained.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  BudgetGuard, apiKeyResolver, appendJsonl, assertModelAllowed, hashOf, loadPrices, parseArgs, readJson, tokenCostUsd, writeJsonExclusive,
} from "./lib.mjs";
import { extractChatResponse, modelCheck } from "./response.mjs";

export const RUN_SCHEMA = "docslurp-search-model-eval-run@v1";
const RECORDED_HEADERS = ["x-request-id", "traceparent", "tracestate", "server-timing", "retry-after", "content-type", "fly-request-id", "x-trace-id", "x-ratelimit-remaining"];

// ---------------------------------------------------------------- config + matrix

export function normalizeConfig(raw, { prices } = {}) {
  const config = {
    runId: raw.runId,
    baseUrl: raw.baseUrl ?? "http://localhost:8787",
    apiKeyEnv: raw.apiKeyEnv ?? "DOCSLURP_EVAL_API_KEY",
    // Per-tier keys: env var names by tier, or a credentials file + field by tier.
    apiKeyEnvByTier: raw.apiKeyEnvByTier ?? null,
    credentials: raw.credentials ?? null,
    dataset: raw.dataset,
    split: raw.split ?? "dev",
    tiers: raw.tiers ?? null,
    kinds: raw.kinds ?? null,
    caseIds: raw.caseIds ?? null,
    models: raw.models ?? [],
    arms: raw.arms ?? [{ name: "default", maxSteps: 8, maxToolCalls: 16, searchConcurrency: 6 }],
    repeats: raw.repeats ?? 1,
    concurrency: { global: 10, perModel: 3, perWorkspace: 6, ...raw.concurrency },
    budget: { capUsd: null, inputTokensPerTurn: 24_000, outputTokensPerTurn: 2_048, overheadUsdPerCall: 0.002, ...raw.budget },
    timeoutMs: raw.timeoutMs ?? 150_000,
    retry: { onTimeout: false, minDelayMs: 1_000, maxDelayMs: 4_000, ...raw.retry },
    sendBaggage: raw.sendBaggage ?? false,
    pricesPath: raw.pricesPath ?? null,
    priceOverrides: raw.priceOverrides ?? {},
  };
  if (typeof config.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(config.runId)) throw new Error("runId must be 3-81 chars of [A-Za-z0-9._-]");
  if (!config.models.length || new Set(config.models).size !== config.models.length) throw new Error("models must be a non-empty list of unique ids");
  for (const model of config.models) assertModelAllowed(model, prices);
  if (!["dev", "test", "all"].includes(config.split)) throw new Error("split must be dev, test or all");
  const armNames = new Set();
  for (const arm of config.arms) {
    if (typeof arm.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(arm.name) || armNames.has(arm.name)) throw new Error("arm names must be unique [A-Za-z0-9_-]");
    armNames.add(arm.name);
    for (const key of ["maxSteps", "maxToolCalls", "searchConcurrency"]) if (!Number.isSafeInteger(arm[key]) || arm[key] < 1) throw new Error(`arm ${arm.name}: ${key} must be a positive integer`);
  }
  if (!Number.isSafeInteger(config.repeats) || config.repeats < 1) throw new Error("repeats must be a positive integer");
  for (const key of ["global", "perModel", "perWorkspace"]) if (!Number.isSafeInteger(config.concurrency[key]) || config.concurrency[key] < 1) throw new Error(`concurrency.${key} must be a positive integer`);
  if (!(Number.isFinite(config.budget.capUsd) && config.budget.capUsd > 0)) throw new Error("budget.capUsd (hard USD cap) is required");
  return config;
}

/** Fields that define the matrix; a resume must not change them. */
export const matrixIdentity = (config, datasetSha256) => ({ datasetSha256, baseUrl: config.baseUrl, split: config.split, tiers: config.tiers, kinds: config.kinds, caseIds: config.caseIds, models: config.models, arms: config.arms, repeats: config.repeats });

export function selectCases(dataset, config) {
  return dataset.cases.filter((entry) => (config.split === "all" || entry.split === config.split)
    && (!config.tiers || config.tiers.includes(entry.workspaceTier))
    && (!config.kinds || config.kinds.includes(entry.kind))
    && (!config.caseIds || config.caseIds.includes(entry.id)))
    // The runner sees only what it sends; gold stays with the scorer.
    .map(({ id, question, workspaceId, workspaceTier, kind }) => ({ id, question, workspaceId, workspaceTier, kind }));
}

const slug = (value) => value.replace(/[^A-Za-z0-9.-]+/g, "_");
export const cellKey = ({ model, caseId, arm, repeat }) => `${slug(model)}.${caseId}.${arm}.r${repeat}`;

/** Cells ordered repeat > case > arm > model so every model progresses together. */
export function buildMatrix(cases, config, { smoke = null } = {}) {
  const selected = smoke ? cases.slice(0, smoke) : cases;
  const arms = smoke ? config.arms.slice(0, 1) : config.arms;
  const repeats = smoke ? 1 : config.repeats;
  const cells = [];
  for (let repeat = 0; repeat < repeats; repeat++) for (const entry of selected) for (const arm of arms) for (const model of config.models) {
    const cell = { model, caseId: entry.id, arm: arm.name, repeat };
    cells.push({ ...cell, key: cellKey(cell), armConfig: arm, case: entry });
  }
  return cells;
}

/** Pessimistic USD for one call: every allowed step at the worst-case token budget, plus overhead. */
export function estimateCallUsd(model, arm, budget, prices) {
  const price = assertModelAllowed(model, prices);
  const turns = arm.maxSteps + 1;
  return tokenCostUsd(price, budget.inputTokensPerTurn * turns, budget.outputTokensPerTurn * turns) + budget.overheadUsdPerCall;
}

export function dryRunReport(cells, config, prices, { completed = new Set() } = {}) {
  const byModel = {};
  let worstCaseUsd = 0, remaining = 0;
  for (const cell of cells) {
    const usd = estimateCallUsd(cell.model, cell.armConfig, config.budget, prices);
    if (!byModel[cell.model]) byModel[cell.model] = { cells: 0, remaining: 0, worstCaseUsd: 0, worstCaseWithRetryUsd: 0 };
    const entry = byModel[cell.model];
    entry.cells++;
    if (completed.has(cell.key)) continue;
    entry.remaining++; remaining++;
    entry.worstCaseUsd += usd; entry.worstCaseWithRetryUsd += 2 * usd; worstCaseUsd += usd;
  }
  return { cells: cells.length, remaining, models: config.models.length, arms: config.arms.length, repeats: config.repeats, byModel, worstCaseUsd, worstCaseWithRetryUsd: 2 * worstCaseUsd, capUsd: config.budget.capUsd, fitsCap: worstCaseUsd <= config.budget.capUsd };
}

/** Tier -> API key. Keys are read at runtime and never written to artifacts. */
export function keyResolverFor(config, env = process.env) {
  if (config.credentials?.file || config.apiKeyEnvByTier) return apiKeyResolver({ credentialsPath: config.credentials?.file ?? null, fieldByTier: config.credentials?.fieldByTier, envByTier: config.apiKeyEnvByTier, env });
  return () => { const key = env[config.apiKeyEnv]; if (!key) throw new Error(`API key missing (env ${config.apiKeyEnv})`); return key; };
}

// ---------------------------------------------------------------- one call

export const newTraceparent = () => {
  const traceId = randomBytes(16).toString("hex"), spanId = randomBytes(8).toString("hex");
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
};
const baggageValue = (value) => encodeURIComponent(String(value));

export function buildRequest(cell, config, { apiKey, attempt, trace }) {
  const requestId = `smeval-${config.runId}-${hashOf(cell.key).slice(0, 12)}-a${attempt}`;
  const headers = {
    "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${apiKey}`,
    // The server accepts W3C traceparent (W3CTraceContextPropagator) and echoes X-Request-ID.
    traceparent: trace.traceparent, "X-Request-ID": requestId,
  };
  // No baggage propagator is registered server-side today; send only when asked.
  if (config.sendBaggage) headers.baggage = [["eval.run_id", config.runId], ["eval.case_id", cell.caseId], ["eval.model", cell.model], ["eval.arm", cell.arm], ["eval.repeat", cell.repeat]].map(([key, value]) => `${key}=${baggageValue(value)}`).join(",");
  // No sessionId: each case starts a fresh chat session.
  const body = { q: cell.case.question, workspaceId: cell.case.workspaceId, model: cell.model, agent: { maxSteps: cell.armConfig.maxSteps, maxToolCalls: cell.armConfig.maxToolCalls, searchConcurrency: cell.armConfig.searchConcurrency } };
  return { url: new URL("/v1/chat", config.baseUrl).href, headers, body, requestId };
}

/** Actual USD from the response: reported costCents, else tokens x list price, else unknown (null). */
export function actualCostUsd(status, extracted, price) {
  // Agent model calls (costCents) plus nested tool work such as embeddings and rewrites (toolCostCents).
  if (Number.isFinite(extracted?.usage?.costCents)) return { usd: (extracted.usage.costCents + (extracted.usage.toolCostCents ?? 0)) / 100, source: `response-usage:${extracted.usage.costSource ?? "unspecified"}${Number.isFinite(extracted.usage.toolCostCents) ? "+tools" : ""}` };
  if (Number.isFinite(extracted?.usage?.inputTokens) && (extracted.usage.inputTokens > 0 || extracted.usage.outputTokens > 0)) return { usd: tokenCostUsd(price, extracted.usage.inputTokens, extracted.usage.outputTokens ?? 0), source: "response-tokens-x-list-price" };
  // Auth, validation, spend (402) and rate-limit refusals happen before any model call.
  if (status >= 400 && status < 500) return { usd: 0, source: "http-4xx-before-model" };
  return { usd: null, source: "unknown" };
}

export async function callOnce(cell, config, { apiKey, attempt, fetchImpl, price, now = () => performance.now() }) {
  const trace = newTraceparent();
  const request = buildRequest(cell, config, { apiKey, attempt, trace });
  const startedAt = new Date().toISOString();
  const started = now();
  const record = { attempt, startedAt, requestId: request.requestId, traceId: trace.traceId, spanId: trace.spanId, request: { url: request.url, body: request.body, headers: { traceparent: request.headers.traceparent, "X-Request-ID": request.requestId, ...(request.headers.baggage ? { baggage: request.headers.baggage } : {}) } } };
  let response;
  try {
    response = await fetchImpl(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal: AbortSignal.timeout(config.timeoutMs) });
    record.ttfbMs = now() - started;
    record.status = response.status;
    record.responseHeaders = Object.fromEntries(RECORDED_HEADERS.map((name) => [name, response.headers?.get?.(name) ?? null]).filter(([, value]) => value !== null));
    const raw = await response.text();
    record.latencyMs = now() - started;
    try { record.response = JSON.parse(raw); } catch { record.response = null; record.rawText = raw.slice(0, 20_000); }
  } catch (error) {
    record.latencyMs = now() - started;
    record.ttfbMs ??= null;
    record.status ??= null;
    record.errorKind = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : record.status === null ? "network" : "body";
    record.error = String(error?.message ?? error);
  }
  record.completedAt = new Date().toISOString();
  record.serverRequestId = record.responseHeaders?.["x-request-id"] ?? null;
  record.extracted = record.response ? extractChatResponse(record.response) : null;
  record.modelCheck = record.extracted ? modelCheck(cell.model, record.extracted) : null;
  record.ok = record.status === 200 && Boolean(record.extracted?.answer !== null && record.response);
  const cost = actualCostUsd(record.status ?? 0, record.extracted, price);
  record.costUsd = cost.usd;
  record.costSource = cost.source;
  return record;
}

export function retryable(attempt, retry) {
  if (attempt.errorKind === "timeout") return Boolean(retry.onTimeout);
  if (attempt.errorKind === "network" || attempt.errorKind === "body") return true;
  return attempt.status === 429 || (attempt.status >= 500 && attempt.status <= 599);
}

export function retryDelayMs(attempt, retry, random = Math.random) {
  const jitter = retry.minDelayMs + random() * (retry.maxDelayMs - retry.minDelayMs);
  const after = Number(attempt.responseHeaders?.["retry-after"]);
  return Number.isFinite(after) && after > 0 && after <= 30 ? Math.max(jitter, after * 1000) : jitter;
}

// ---------------------------------------------------------------- scheduler

/** Global, per-model and per-workspace caps; picks the first eligible pending cell. */
export function runPool(cells, limits, worker, { shouldStop = () => false } = {}) {
  const pending = [...cells];
  const activeBy = { model: new Map(), workspace: new Map() };
  let active = 0;
  const peak = { global: 0, model: 0, workspace: 0 };
  const bump = (map, key, delta) => { const next = (map.get(key) ?? 0) + delta; map.set(key, next); return next; };
  return new Promise((resolveAll) => {
    const pump = () => {
      if (shouldStop()) pending.length = 0;
      while (active < limits.global && pending.length) {
        const index = pending.findIndex((cell) => (activeBy.model.get(cell.model) ?? 0) < limits.perModel && (activeBy.workspace.get(cell.case.workspaceId) ?? 0) < limits.perWorkspace);
        if (index < 0) break;
        const [cell] = pending.splice(index, 1);
        active++;
        peak.global = Math.max(peak.global, active);
        peak.model = Math.max(peak.model, bump(activeBy.model, cell.model, 1));
        peak.workspace = Math.max(peak.workspace, bump(activeBy.workspace, cell.case.workspaceId, 1));
        Promise.resolve().then(() => worker(cell)).catch(() => {}).finally(() => {
          active--;
          bump(activeBy.model, cell.model, -1);
          bump(activeBy.workspace, cell.case.workspaceId, -1);
          pump();
        });
      }
      if (!pending.length && active === 0) resolveAll(peak);
    };
    pump();
  });
}

// ---------------------------------------------------------------- run

export async function runMatrix({ config, dataset, outDir, apiKey = null, apiKeyForTier = null, prices, fetchImpl = fetch, smoke = null, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), random = Math.random, log = console.log }) {
  const keyFor = apiKeyForTier ?? (apiKey ? () => apiKey : keyResolverFor(config));
  const callsDir = join(outDir, "calls");
  mkdirSync(callsDir, { recursive: true });
  const identity = matrixIdentity(config, dataset.casesSha256 ?? hashOf(dataset.cases));
  const configPath = join(outDir, "run-config.json");
  if (existsSync(configPath)) {
    const previous = readJson(configPath);
    if (hashOf(previous.identity) !== hashOf(identity)) throw new Error("run-config.json in this output dir has a different matrix; use a new run directory");
    appendJsonl(join(outDir, "run-log.jsonl"), { at: new Date().toISOString(), event: "resume", smoke, capUsd: config.budget.capUsd });
  } else {
    writeJsonExclusive(configPath, { schema: RUN_SCHEMA, createdAt: new Date().toISOString(), identity, config: { ...config, dataset: config.dataset ?? null }, pricesAsOf: prices.asOf ?? null });
    appendJsonl(join(outDir, "run-log.jsonl"), { at: new Date().toISOString(), event: "start", smoke, capUsd: config.budget.capUsd });
  }
  const guard = BudgetGuard.fromLog({ capUsd: config.budget.capUsd, logPath: join(outDir, "guard.jsonl") });
  const cells = buildMatrix(selectCases(dataset, config), config, { smoke });
  // Fail before any call when a tier in the matrix has no key.
  for (const tier of new Set(cells.map((cell) => cell.case.workspaceTier))) keyFor(tier);
  const completed = new Set(cells.filter((cell) => existsSync(join(callsDir, `${cell.key}.json`))).map((cell) => cell.key));
  const todo = cells.filter((cell) => !completed.has(cell.key));
  const counts = { cells: cells.length, skippedCompleted: completed.size, completed: 0, failed: 0, refused: 0, retried: 0, modelMismatches: 0, workerErrors: 0 };
  let stopped = false;
  const worker = async (cell) => {
    try {
      const price = assertModelAllowed(cell.model, prices);
      const estimateUsd = estimateCallUsd(cell.model, cell.armConfig, config.budget, prices);
      const attempts = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        const reservationId = guard.reserve({ key: `${cell.key}#a${attempt}`, model: cell.model, estimateUsd });
        if (!reservationId) {
          stopped = true;
          if (!attempts.length) { counts.refused++; return; }
          attempts.push({ attempt, refusedByBudget: true, at: new Date().toISOString() });
          break;
        }
        const record = await callOnce(cell, config, { apiKey: keyFor(cell.case.workspaceTier), attempt, fetchImpl, price });
        record.guard = guard.reconcile(reservationId, { actualUsd: record.costUsd, source: record.costSource });
        attempts.push(record);
        appendJsonl(join(outDir, "attempts.jsonl"), { key: cell.key, model: cell.model, caseId: cell.caseId, arm: cell.arm, repeat: cell.repeat, attempt, status: record.status, errorKind: record.errorKind ?? null, latencyMs: record.latencyMs, ttfbMs: record.ttfbMs, requestId: record.requestId, serverRequestId: record.serverRequestId, traceId: record.traceId, chargedUsd: record.guard.chargedUsd, at: record.completedAt });
        if (record.ok || attempt === 2 || !retryable(record, config.retry)) break;
        counts.retried++;
        await sleep(retryDelayMs(record, config.retry, random));
      }
      const final = attempts.filter((attempt) => !attempt.refusedByBudget).at(-1);
      const outcome = final.ok ? "ok" : final.errorKind ?? `http_${final.status}`;
      if (final.modelCheck?.mismatch) counts.modelMismatches++;
      if (final.ok) counts.completed++; else counts.failed++;
      writeJsonExclusive(join(callsDir, `${cell.key}.json`), {
        schema: RUN_SCHEMA, runId: config.runId, key: cell.key, model: cell.model, caseId: cell.caseId, arm: cell.arm, armConfig: cell.armConfig, repeat: cell.repeat,
        workspaceId: cell.case.workspaceId, workspaceTier: cell.case.workspaceTier, kind: cell.case.kind,
        outcome, attemptCount: attempts.filter((attempt) => !attempt.refusedByBudget).length,
        // Errors stay on record even when the retry succeeded.
        errors: attempts.filter((attempt) => !attempt.ok && !attempt.refusedByBudget).map((attempt) => ({ attempt: attempt.attempt, status: attempt.status, errorKind: attempt.errorKind ?? null, error: attempt.error ?? null, requestId: attempt.requestId, traceId: attempt.traceId })),
        estimateUsd, chargedUsd: attempts.reduce((total, attempt) => total + (attempt.guard?.chargedUsd ?? 0), 0),
        modelCheck: final.modelCheck, attempts,
      });
      log(`${outcome} ${cell.key} ${Math.round(final.latencyMs ?? 0)}ms`);
    } catch (error) {
      counts.workerErrors++;
      appendJsonl(join(outDir, "run-log.jsonl"), { at: new Date().toISOString(), event: "worker-error", key: cell.key, error: String(error?.message ?? error) });
    }
  };
  const peak = await runPool(todo, config.concurrency, worker, { shouldStop: () => stopped });
  const summary = { schema: RUN_SCHEMA, runId: config.runId, finishedAt: new Date().toISOString(), smoke, counts, budgetStopped: stopped, guard: guard.state(), peakConcurrency: peak };
  writeJsonExclusive(join(outDir, `summary.${summary.finishedAt.replace(/[:.]/g, "-")}.${randomBytes(3).toString("hex")}.json`), summary);
  return summary;
}

// ---------------------------------------------------------------- CLI

const USAGE = "Usage: run.mjs --config config.json --out DIR [--dataset dataset.json] [--dry-run] [--smoke N]";

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, { booleans: ["dry-run"] });
  if (!options.config) throw new Error(USAGE);
  const raw = readJson(options.config);
  const prices = loadPrices(raw.pricesPath ?? undefined, raw.priceOverrides ?? {});
  const config = normalizeConfig({ ...raw, dataset: options.dataset ?? raw.dataset }, { prices });
  if (!config.dataset) throw new Error("dataset path required (config.dataset or --dataset)");
  const dataset = readJson(options.dataset ? resolve(options.dataset) : resolve(dirname(resolve(options.config)), config.dataset));
  const smoke = options.smoke ? Number(options.smoke) : null;
  if (smoke !== null && !(Number.isSafeInteger(smoke) && smoke > 0)) throw new Error("--smoke must be a positive integer");
  const cells = buildMatrix(selectCases(dataset, config), config, { smoke });
  if (options["dry-run"]) {
    const completed = options.out ? new Set(cells.filter((cell) => existsSync(join(options.out, "calls", `${cell.key}.json`))).map((cell) => cell.key)) : new Set();
    console.log(JSON.stringify(dryRunReport(cells, config, prices, { completed }), null, 2));
    return 0;
  }
  if (!options.out) throw new Error(USAGE);
  const summary = await runMatrix({ config, dataset, outDir: resolve(options.out), apiKeyForTier: keyResolverFor(config), prices, smoke });
  console.log(JSON.stringify(summary, null, 2));
  return summary.counts.workerErrors ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
