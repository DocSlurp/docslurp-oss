import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BudgetGuard, loadPrices, readJsonl } from "./lib.mjs";
import { extractChatResponse, modelCheck } from "./response.mjs";
import { buildMatrix, dryRunReport, estimateCallUsd, keyResolverFor, normalizeConfig, retryable, runMatrix, runPool, selectCases } from "./run.mjs";

const prices = loadPrices();
const MODELS = ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash"];
const tempDir = (t) => { const dir = mkdtempSync(join(tmpdir(), "smeval-run-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const dataset = {
  schema: "docslurp-search-model-eval@v1", casesSha256: "synthetic",
  cases: Array.from({ length: 4 }, (_, index) => ({
    id: `synthetic-case-0${index}`, workspaceTier: index < 2 ? "mid-5k" : "large-58k", workspaceId: index < 2 ? "ws-a" : "ws-b", question: `Question ${index}?`, kind: "single_hop", split: "dev",
    gold: { answerable: true, facts: ["SECRET GOLD FACT"], supportMode: "any_of", supportPages: [{ documentId: "d", page: 1, group: 0 }] }, provenance: { method: "test" },
  })),
};
const baseConfig = (overrides = {}) => normalizeConfig({ runId: "test-run", baseUrl: "http://127.0.0.1:1", models: MODELS, arms: [{ name: "default", maxSteps: 4, maxToolCalls: 8, searchConcurrency: 3 }], repeats: 1, budget: { capUsd: 5 }, concurrency: { global: 3, perModel: 2, perWorkspace: 2 }, retry: { minDelayMs: 1, maxDelayMs: 2 }, ...overrides }, { prices });

function chatBody(request, overrides = {}) {
  return {
    id: "resp", sessionId: "s", answer: "The answer is here [1].", citations: [{ text: "snippet", citation: { documentId: "d", pageNumber: 1, pageNumbers: [] } }],
    usage: { inputTokens: 1200, outputTokens: 80, totalTokens: 1280, costCents: 0.05, costSource: "provider" },
    runtime: { startedAt: "", completedAt: "", totalMs: 10 },
    debug: { model: request.model, requestedModel: request.model, resolvedModel: `${request.model}-20261001`, steps: [{ usage: { inputTokens: 600, outputTokens: 40 } }, { usage: { inputTokens: 600, outputTokens: 40 } }], toolCallCount: 1, searchCallCount: 1, searchQueryCount: 2, zeroHitSearchCount: 0, stopReason: "answered", limits: request.agent, toolCalls: [{ id: "t1", name: "workspace.search", status: "success", args: { queries: [{ q: "a" }, { q: "b" }] } }] },
    ...overrides,
  };
}

/** Local mock of POST /v1/chat that tracks concurrency and every request. */
async function mockServer(t, handler) {
  const state = { requests: [], inflight: 0, peak: 0, byModel: new Map(), peakModel: 0, byWorkspace: new Map(), peakWorkspace: 0 };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    state.requests.push({ headers: req.headers, body, url: req.url });
    const bump = (map, key, delta) => { const next = (map.get(key) ?? 0) + delta; map.set(key, next); return next; };
    state.inflight++; state.peak = Math.max(state.peak, state.inflight);
    state.peakModel = Math.max(state.peakModel, bump(state.byModel, body.model, 1));
    state.peakWorkspace = Math.max(state.peakWorkspace, bump(state.byWorkspace, body.workspaceId, 1));
    const reply = await handler(body, req, state);
    state.inflight--; bump(state.byModel, body.model, -1); bump(state.byWorkspace, body.workspaceId, -1);
    if (reply === "hang") return;
    res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", "X-Request-ID": req.headers["x-request-id"] ?? "", ...(reply.headers ?? {}) });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const quiet = () => {};

test("dry run reports matrix size and worst-case cost without calls", () => {
  const config = baseConfig({ repeats: 2, arms: [{ name: "a", maxSteps: 4, maxToolCalls: 8, searchConcurrency: 3 }, { name: "b", maxSteps: 8, maxToolCalls: 16, searchConcurrency: 6 }] });
  const cells = buildMatrix(selectCases(dataset, config), config);
  assert.equal(cells.length, 4 * 2 * 2 * 2);
  const report = dryRunReport(cells, config, prices);
  assert.equal(report.cells, 32);
  const expected = cells.reduce((total, cell) => total + estimateCallUsd(cell.model, cell.armConfig, config.budget, prices), 0);
  assert.ok(Math.abs(report.worstCaseUsd - expected) < 1e-12);
  assert.equal(report.byModel["z-ai/glm-5.3-flash"].cells, 16);
  assert.equal(buildMatrix(selectCases(dataset, config), config, { smoke: 2 }).length, 2 * 1 * 1 * 2, "smoke: N cases x first arm x 1 repeat per model");
});

test("config enforces the price policy and a hard budget cap", () => {
  assert.throws(() => baseConfig({ models: ["openai/gpt-6-luna-pro"] }), /Pro\/Ultra/);
  assert.throws(() => baseConfig({ models: ["anthropic/claude-fable-5.1"] }), /output price/);
  assert.throws(() => normalizeConfig({ runId: "x-run", models: MODELS }, { prices }), /capUsd/);
});

test("runner sends question only with agent limits, trace headers and fresh sessions, honouring caps", async (t) => {
  const { state, baseUrl } = await mockServer(t, async (body) => { await delay(25); return { body: chatBody(body) }; });
  const outDir = tempDir(t);
  const summary = await runMatrix({ config: baseConfig({ baseUrl }), dataset, outDir, apiKey: "test-key", prices, log: quiet });
  assert.equal(summary.counts.completed, 8);
  assert.equal(state.requests.length, 8);
  assert.ok(state.peak <= 3 && state.peakModel <= 2 && state.peakWorkspace <= 2, JSON.stringify({ peak: state.peak, model: state.peakModel, ws: state.peakWorkspace }));
  for (const { headers, body, url } of state.requests) {
    assert.equal(url, "/v1/chat");
    assert.equal(headers.authorization, "Bearer test-key");
    assert.match(headers.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    assert.match(headers["x-request-id"], /^smeval-test-run-[a-f0-9]{12}-a1$/);
    assert.equal(headers.baggage, undefined, "baggage is not propagated server-side, so off by default");
    assert.deepEqual(Object.keys(body).sort(), ["agent", "model", "q", "workspaceId"]);
    assert.deepEqual(body.agent, { maxSteps: 4, maxToolCalls: 8, searchConcurrency: 3 });
    assert.ok(!JSON.stringify(body).includes("SECRET"));
  }
  assert.equal(new Set(state.requests.map((request) => request.headers.traceparent.split("-")[1])).size, 8, "new trace per call");
  const files = readdirSync(join(outDir, "calls"));
  assert.equal(files.length, 8);
  const record = JSON.parse(readFileSync(join(outDir, "calls", files[0]), "utf8"));
  const attempt = record.attempts[0];
  assert.equal(record.outcome, "ok");
  assert.equal(attempt.serverRequestId, attempt.requestId);
  assert.equal(attempt.traceId, attempt.request.headers.traceparent.split("-")[1]);
  assert.ok(attempt.latencyMs >= attempt.ttfbMs && attempt.ttfbMs > 0);
  assert.equal(attempt.costUsd, 0.0005);
  assert.equal(attempt.extracted.searchQueryCount, 2);
  assert.equal(record.modelCheck.mismatch, false);
  assert.equal(record.modelCheck.resolvedDiffers, false);
  assert.ok(Math.abs(summary.guard.actualUsd - 8 * 0.0005) < 1e-9);
  assert.equal(summary.guard.reservedUsd, 0);
});

test("resume skips completed cells, never overwrites, and refuses a changed matrix", async (t) => {
  let calls = 0;
  const { baseUrl } = await mockServer(t, async (body) => { calls++; return { body: chatBody(body) }; });
  const outDir = tempDir(t);
  await runMatrix({ config: baseConfig({ baseUrl }), dataset, outDir, apiKey: "k", prices, log: quiet, smoke: 1 });
  assert.equal(calls, 2);
  const smokeFiles = readdirSync(join(outDir, "calls"));
  const mtimes = smokeFiles.map((file) => statSync(join(outDir, "calls", file)).mtimeMs);
  const summary = await runMatrix({ config: baseConfig({ baseUrl }), dataset, outDir, apiKey: "k", prices, log: quiet });
  assert.equal(calls, 8, "only the 6 remaining cells ran");
  assert.equal(summary.counts.skippedCompleted, 2);
  assert.deepEqual(smokeFiles.map((file) => statSync(join(outDir, "calls", file)).mtimeMs), mtimes);
  await runMatrix({ config: baseConfig({ baseUrl }), dataset, outDir, apiKey: "k", prices, log: quiet });
  assert.equal(calls, 8, "nothing left to run");
  await assert.rejects(runMatrix({ config: baseConfig({ baseUrl, repeats: 2 }), dataset, outDir, apiKey: "k", prices, log: quiet }), /different matrix/);
  assert.ok(readJsonl(join(outDir, "run-log.jsonl")).some((event) => event.event === "resume"));
});

test("one retry on 5xx, up to five on 429, keeps every attempt; 4xx is not retried", async (t) => {
  const seen = new Map();
  const { baseUrl } = await mockServer(t, async (body) => {
    const count = (seen.get(body.q + body.model) ?? 0) + 1;
    seen.set(body.q + body.model, count);
    if (body.q === "Question 0?") return count === 1 ? { status: 503, body: { error: "unavailable" } } : { body: chatBody(body) };
    if (body.q === "Question 1?") return { status: 429, headers: { "Retry-After": "0" }, body: { error: "slow down" } };
    if (body.q === "Question 2?") return { status: 400, body: { error: "invalid" } };
    return { body: chatBody(body) };
  });
  const outDir = tempDir(t);
  const summary = await runMatrix({ config: baseConfig({ baseUrl, models: [MODELS[0]] }), dataset, outDir, apiKey: "k", prices, log: quiet, sleep: async () => {} });
  const read = (index) => JSON.parse(readFileSync(join(outDir, "calls", `z-ai_glm-5.3-flash.synthetic-case-0${index}.default.r0.json`), "utf8"));
  const recovered = read(0);
  assert.equal(recovered.outcome, "ok");
  assert.equal(recovered.attemptCount, 2);
  assert.equal(recovered.errors.length, 1, "the original 503 is not erased by the successful retry");
  assert.equal(recovered.errors[0].status, 503);
  assert.notEqual(recovered.attempts[0].traceId, recovered.attempts[1].traceId);
  assert.match(recovered.attempts[1].requestId, /-a2$/);
  const limited = read(1);
  assert.equal(limited.attemptCount, 5, "429 refusals retry up to max429Attempts (default 5)");
  assert.equal(limited.outcome, "http_429");
  assert.equal(read(2).attemptCount, 1);
  assert.equal(summary.counts.retried, 5);
  assert.equal(readJsonl(join(outDir, "attempts.jsonl")).length, 6);
});

test("network errors retry once; timeouts are recorded and not retried by default", async (t) => {
  const outDir = tempDir(t);
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (body.q === "Question 0?") throw new TypeError("fetch failed");
    if (body.q === "Question 1?") return await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    return new Response(JSON.stringify(chatBody(body)), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  await runMatrix({ config: baseConfig({ models: [MODELS[0]], timeoutMs: 50 }), dataset, outDir, apiKey: "k", prices, log: quiet, fetchImpl, sleep: async () => {} });
  const read = (index) => JSON.parse(readFileSync(join(outDir, "calls", `z-ai_glm-5.3-flash.synthetic-case-0${index}.default.r0.json`), "utf8"));
  assert.equal(read(0).attemptCount, 2);
  assert.equal(read(0).outcome, "network");
  assert.equal(read(1).attemptCount, 1);
  assert.equal(read(1).outcome, "timeout");
  assert.equal(calls, 5);
  assert.equal(retryable({ errorKind: "timeout" }, { onTimeout: true }), true);
});

test("budget guard reserves pessimistically, reconciles to actuals and refuses past the cap", (t) => {
  const dir = tempDir(t);
  const logPath = join(dir, "guard.jsonl");
  const guard = new BudgetGuard({ capUsd: 1, logPath });
  const a = guard.reserve({ key: "a", model: "m", estimateUsd: 0.6 });
  assert.ok(a);
  assert.equal(guard.reserve({ key: "b", model: "m", estimateUsd: 0.5 }), null, "0.6 reserved + 0.5 > 1");
  guard.reconcile(a, { actualUsd: 0.1, source: "test" });
  const b = guard.reserve({ key: "b", model: "m", estimateUsd: 0.5 });
  assert.ok(b);
  guard.reconcile(b, { actualUsd: null });
  assert.equal(guard.state().actualUsd, 0.6, "unknown cost stays charged at its estimate");
  const open = guard.reserve({ key: "c", model: "m", estimateUsd: 0.2 });
  assert.ok(open);
  const resumed = BudgetGuard.fromLog({ capUsd: 1, logPath });
  assert.ok(Math.abs(resumed.actualUsd - 0.8) < 1e-9, "never-reconciled reservation charged at estimate on resume");
  assert.equal(resumed.reserve({ key: "d", model: "m", estimateUsd: 0.25 }), null);
  const events = readJsonl(logPath).map((event) => event.event);
  for (const name of ["reserve", "refuse", "reconcile", "resume"]) assert.ok(events.includes(name), name);
  assert.throws(() => new BudgetGuard({ capUsd: 0 }), /positive/);
});

test("runner stops before any call when the cap cannot cover one estimate", async (t) => {
  let calls = 0;
  const outDir = tempDir(t);
  const summary = await runMatrix({ config: baseConfig({ budget: { capUsd: 0.0001 } }), dataset, outDir, apiKey: "k", prices, log: quiet, fetchImpl: async () => { calls++; throw new Error("no"); } });
  assert.equal(calls, 0);
  assert.equal(summary.budgetStopped, true);
  assert.ok(summary.counts.refused >= 1);
  assert.equal(readdirSync(join(outDir, "calls")).length, 0, "refused cells stay runnable on resume");
  assert.ok(readJsonl(join(outDir, "guard.jsonl")).some((event) => event.event === "refuse"));
});

test("pool honours global, per-model and per-workspace caps", async () => {
  const cells = Array.from({ length: 30 }, (_, index) => ({ model: `m${index % 3}`, case: { workspaceId: `w${index % 2}` } }));
  let active = 0, peak = 0;
  const peakReport = await runPool(cells, { global: 4, perModel: 1, perWorkspace: 2 }, async () => { active++; peak = Math.max(peak, active); await delay(2); active--; });
  assert.ok(peak <= 3, "per-model cap 1 x 3 models");
  assert.ok(peakReport.model <= 1 && peakReport.workspace <= 2 && peakReport.global <= 4);
});

test("response extraction tolerates missing agent fields and flags model mismatches", () => {
  const legacy = extractChatResponse({ answer: "x", citations: [{ text: "t", citation: { documentId: "d", pageNumber: 2 } }], usage: { inputTokens: 1 }, debug: { model: "a/b", toolCalls: [{ id: "1", name: "workspace.search", status: "success" }] } });
  for (const key of ["requestedModel", "resolvedModel", "steps", "toolCallCount", "searchCallCount", "searchQueryCount", "zeroHitSearchCount", "stopReason", "limits", "stepUsage"]) assert.equal(legacy[key], null, key);
  assert.deepEqual(legacy.citations[0].pages, [2]);
  assert.equal(extractChatResponse(null).answer, null);
  assert.equal(extractChatResponse({ debug: "garbage", citations: "x" }).citations.length, 0);
  assert.equal(modelCheck("a/b", legacy).mismatch, false);
  assert.equal(modelCheck("a/c", legacy).mismatch, true);
  assert.equal(modelCheck("a/b", { ...legacy, requestedModel: "a/b", resolvedModel: "other/model" }).resolvedDiffers, true);
});

test("each case uses its tier's API key from a credentials file, never recorded in artifacts", async (t) => {
  const { state, baseUrl } = await mockServer(t, async (body) => ({ body: chatBody(body) }));
  const outDir = tempDir(t);
  const credentials = join(outDir, "..", `${outDir.split("/").pop()}-creds.json`);
  writeFileSync(credentials, JSON.stringify({ midApiKey: "mid-secret-key", largeApiKey: "large-secret-key" }));
  t.after(() => rmSync(credentials, { force: true }));
  const config = baseConfig({ baseUrl, models: [MODELS[0]], credentials: { file: credentials, fieldByTier: { "mid-5k": "midApiKey", "large-58k": "largeApiKey" } } });
  await runMatrix({ config, dataset, outDir, prices, apiKeyForTier: keyResolverFor(config), log: quiet });
  for (const request of state.requests) assert.equal(request.headers.authorization, `Bearer ${request.body.workspaceId === "ws-a" ? "mid-secret-key" : "large-secret-key"}`);
  const artifacts = readdirSync(join(outDir, "calls")).map((file) => readFileSync(join(outDir, "calls", file), "utf8")).join("") + readFileSync(join(outDir, "run-config.json"), "utf8") + readFileSync(join(outDir, "attempts.jsonl"), "utf8");
  assert.ok(!artifacts.includes("secret-key"));
  await assert.rejects(runMatrix({ config: baseConfig({ baseUrl, apiKeyEnvByTier: { "mid-5k": "SMEVAL_TEST_MISSING" } }), dataset, outDir: tempDir(t), prices, log: quiet }), /No API key/);
});

test("429 refusals retry up to max429Attempts honouring the body's retryAfterSeconds", async () => {
  const { retryDelayMs } = await import("./run.mjs");
  const delay = retryDelayMs({ status: 429, responseHeaders: {}, response: { error: { details: { retryAfterSeconds: 12 } } } }, { minDelayMs: 0, maxDelayMs: 0 }, () => 0);
  assert.equal(delay, 12_000);
});
