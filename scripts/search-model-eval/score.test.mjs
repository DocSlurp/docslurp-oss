import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootstrapCi, loadPrices, readJsonl } from "./lib.mjs";
import { extractChatResponse, normalizeToolCall } from "./response.mjs";
import {
  aggregate, assertJudgeAllowed, corpusPageText, factGrounding, matchContext, compareToBaseline, createJudge, giveUpView, heuristicAbstained, histogram, judgeMessages, renderJudgeAudit, renderMarkdown, scoreCall, scoreRuns, supportRecall,
} from "./score.mjs";

const prices = loadPrices();
const tempDir = (t) => { const dir = mkdtempSync(join(tmpdir(), "smeval-score-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const singleGold = { answerable: true, facts: ["42 units"], supportMode: "any_of", supportPages: [{ documentId: "doc-a", page: 3, group: 0 }, { documentId: "doc-a", page: 4, group: 0 }] };
const multiGold = { answerable: true, facts: ["x", "y"], supportMode: "all_of", supportPages: [{ documentId: "doc-a", page: 3, group: 0 }, { documentId: "doc-b", page: 9, group: 1 }, { documentId: "doc-b", page: 10, group: 1 }] };
const cite = (documentId, ...pages) => ({ documentId, pages });

test("cited recall: any-of for single hop, all-of with partial credit for multi hop", () => {
  assert.deepEqual(supportRecall(singleGold, [cite("doc-a", 4)]), { recall: 1, all: true, groups: 1, hitGroups: 1 });
  assert.equal(supportRecall(singleGold, [cite("doc-a", 5)]).recall, 0);
  assert.equal(supportRecall(singleGold, [cite("doc-b", 3)]).recall, 0, "same page in another document is not support");
  assert.deepEqual(supportRecall(multiGold, [cite("doc-a", 3)]), { recall: 0.5, all: false, groups: 2, hitGroups: 1 });
  assert.deepEqual(supportRecall(multiGold, [cite("doc-a", 3), cite("doc-b", 10)]), { recall: 1, all: true, groups: 2, hitGroups: 2 });
  const shaGold = { answerable: true, facts: ["f"], supportMode: "any_of", supportPages: [{ sourceSha256: "a".repeat(64), page: 2, group: 0 }] };
  assert.equal(supportRecall(shaGold, [cite("prod-1", 2)], matchContext({ documents: { "prod-1": { sha256: "a".repeat(64) } } })).recall, 1, "sha256-only gold resolves through the document catalog");
  const sourceGold = { answerable: true, facts: ["f"], supportMode: "any_of", supportPages: [{ sourceDoc: "src-a", page: 14, group: 0 }] };
  const large = matchContext({ citationMatch: "documentAndPage", documentMap: { "src-a": "prod-a" } });
  assert.equal(supportRecall(sourceGold, [cite("prod-a", 14)], large).recall, 1, "sourceDoc resolves through documentMap");
  assert.equal(supportRecall(sourceGold, [cite("prod-b", 14)], large).recall, 0);
  const mid = matchContext({ citationMatch: "pageOnly", documents: { "slice-small": { pageCount: 10 }, "slice-big": { pageCount: 4000 } } });
  assert.equal(supportRecall(sourceGold, [cite("slice-big", 14)], mid).recall, 1, "pageOnly: any prefix slice at the same page");
  assert.equal(supportRecall(sourceGold, [cite("unknown-slice", 14)], mid).recall, 1, "unknown page count does not block a page match");
  assert.equal(supportRecall(sourceGold, [cite("slice-small", 14)], mid).recall, 0, "page beyond that slice's page count");
  assert.equal(supportRecall(sourceGold, [cite("slice-big", 15)], mid).recall, 0);
});

const entry = (id, gold, kind = "single_hop") => ({ id, workspaceTier: "mid-5k", workspaceId: "ws", question: `Question ${id}?`, kind, gold });
const record = ({ model = "z-ai/glm-5.3-flash", caseId, arm = "default", repeat = 0, response, ok = true, latencyMs = 1000, costUsd = 0.001, status = 200 }) => ({
  runId: "r1", key: `${model}.${caseId}.${arm}.r${repeat}`, model, caseId, arm, repeat, outcome: ok ? "ok" : "http_500", attemptCount: 1, errors: [], chargedUsd: costUsd,
  modelCheck: { mismatch: false }, attempts: [{ attempt: 1, ok, status, latencyMs, ttfbMs: latencyMs, costUsd, requestId: "req", traceId: "trace", extracted: response ? extractChatResponse(response) : null }],
});
const response = (answer, { citations = [cite("doc-a", 3)], toolCalls = undefined, stopReason = "answered", searchCallCount } = {}) => ({
  answer, citations: citations.map((c) => ({ text: "snippet", citation: { documentId: c.documentId, pageNumber: c.pages[0], pageNumbers: c.pages } })),
  usage: { inputTokens: 100, outputTokens: 10 }, debug: { stopReason, ...(searchCallCount !== undefined ? { searchCallCount } : {}), ...(toolCalls ? { toolCalls } : {}) },
});

test("per-call scoring: markers, citation validity against catalog and tool evidence, persistence", () => {
  const toolCalls = [
    { id: "1", name: "workspace.search", status: "success", args: { q: "harbor fund grant" }, evidence: [{ citation: { documentId: "doc-a", pageNumber: 3 } }] },
    { id: "2", name: "workspace.search", status: "error", error: { code: "invalid_arguments", message: "bad" }, args: { q: "harbor fund grant 2031 amount" } },
  ];
  const tier = { citationMatch: "documentAndPage", documents: { "doc-a": { pageCount: 5 }, "doc-c": { pageCount: 2 } } };
  const r = record({ caseId: "c1", response: response("It was 42 units [1]. Also [2] and [9].", { citations: [cite("doc-a", 3), cite("doc-c", 2)], toolCalls }) });
  const row = scoreCall(entry("c1", singleGold), r, { tier, judgment: { score: 1, abstained: false } });
  assert.equal(row.citedRecall, 1);
  assert.equal(row.evidenceSource, "tool_calls+citations_list");
  assert.equal(row.evidenceRecall, 1);
  assert.equal(row.citationMarkers, 3);
  assert.equal(row.citationsUnresolvable, 1, "[9] has no citation");
  assert.equal(row.citationsOutsideEvidence, 1, "doc-c was never retrieved");
  assert.ok(Math.abs(row.citationValidity - 1 / 3) < 1e-9);
  assert.equal(row.searchCallCount, 2, "derived from tool calls when debug omits it");
  assert.equal(row.toolErrors, 1);
  assert.equal(row.protocolFailures, 1);
  assert.equal(row.reformulated, true);
  assert.ok(row.meanSuccessiveJaccard > 0 && row.meanSuccessiveJaccard < 1);
  assert.equal(row.correct, true);
  const failed = scoreCall(entry("c1", singleGold), record({ caseId: "c1", ok: false, status: 500, response: null }));
  assert.equal(failed.score, 0);
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.citedRecall, null);
});

test("abstention matrix separates correct abstention, hallucination and false give-up", () => {
  const negativeGold = { answerable: false, facts: [], supportMode: "any_of", supportPages: [] };
  const rows = [
    scoreCall(entry("a1", singleGold), record({ caseId: "a1", response: response("It is 42 units [1].") }), { judgment: { score: 1, abstained: false } }),
    scoreCall(entry("a2", singleGold), record({ caseId: "a2", response: response("I could not find this in the documents.", { searchCallCount: 3 }) })),
    scoreCall(entry("n1", negativeGold, "unanswerable"), record({ caseId: "n1", response: response("The documents do not mention it.", { searchCallCount: 4, stopReason: "no_evidence" }) })),
    scoreCall(entry("n2", negativeGold, "unanswerable"), record({ caseId: "n2", response: response("It is 17 units [1].", { stopReason: "step_limit" }) })),
    scoreCall(entry("n3", negativeGold, "unanswerable"), record({ caseId: "n3", ok: false, response: null })),
  ];
  assert.equal(rows[1].abstained, true);
  assert.equal(rows[1].score, null, "answerable without a judgment stays unscored");
  assert.equal(rows[2].correct, true);
  assert.equal(rows[3].correct, false);
  const view = giveUpView(rows);
  assert.deepEqual(view.matrix, { answerable: { answered: 1, abstained: 1, failed: 0 }, unanswerable: { answered: 1, abstained: 1, failed: 1 } });
  assert.equal(view.giveUpPrecision, 0.5);
  assert.equal(view.giveUpRecall, 0.5);
  assert.deepEqual(view.searchesBeforeAbstain.bins.filter((bin) => bin.count).map((bin) => bin.label), ["3", "4"]);
  assert.ok(Math.abs(view.unanswerableLimitExhaustion - 1 / 3) < 1e-9);
  const summary = aggregate(rows, { seed: "s", iterations: 200 });
  assert.equal(summary.falseGiveUpRate.mean, 0.5);
  assert.equal(summary.correctAbstainRate.mean, 0.5);
  assert.equal(summary.hallucinationRate.mean, 0.5);
  assert.equal(summary.pagesPerDollar, "not_applicable");
  assert.ok(heuristicAbstained("Insufficient information to determine the value."));
  assert.ok(!heuristicAbstained("The value is 42 [1]."));
});

test("bootstrap CIs are deterministic for a seed", () => {
  const values = Array.from({ length: 50 }, (_, index) => (index % 3 === 0 ? 1 : 0));
  const one = bootstrapCi(values, { seed: "fixed", iterations: 500 });
  assert.deepEqual(bootstrapCi(values, { seed: "fixed", iterations: 500 }), one);
  assert.notDeepEqual(bootstrapCi(values, { seed: "other", iterations: 500 }), one);
  assert.ok(one.low <= one.mean && one.mean <= one.high);
  assert.deepEqual(bootstrapCi([null, null]), { n: 0, mean: null, low: null, high: null });
});

test("judge must be allowed and must not be a candidate model", () => {
  assert.throws(() => assertJudgeAllowed("z-ai/glm-5.3-flash", ["z-ai/glm-5.3-flash"], prices), /candidate/);
  assert.throws(() => assertJudgeAllowed("openai/gpt-6-luna-pro", [], prices), /Pro\/Ultra/);
  assert.throws(() => assertJudgeAllowed("anthropic/claude-fable-5.1", [], prices), /output price/);
  assert.doesNotThrow(() => assertJudgeAllowed("google/gemini-3.8-flash", ["z-ai/glm-5.3-flash"], prices));
});

test("judge sees question, gold and answer only, and caches by hash", async (t) => {
  const dir = tempDir(t);
  const calls = [];
  const fetchImpl = async (_, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "g", choices: [{ message: { content: '{"score": 0.5, "abstained": false, "contradicts": false, "rationale": "partial"}' } }], usage: { prompt_tokens: 300, completion_tokens: 20, cost: 0.0003 } }) };
  };
  const logs = [];
  const judge = createJudge({ judgeModel: "google/gemini-3.8-flash", prices, apiKey: "k", cachePath: join(dir, "cache.jsonl"), ledgerPath: join(dir, "spend.jsonl"), guard: null, fetchImpl, log: (line) => logs.push(line) });
  const item = entry("c1", singleGold);
  const first = await judge(item, "About 42 units.");
  const second = await judge(item, "About 42 units.");
  assert.equal(calls.length, 1);
  assert.equal(first.score, 0.5);
  assert.equal(second.cached, true);
  assert.equal(readJsonl(join(dir, "spend.jsonl"))[0].costUsd, 0.0003);
  assert.match(logs[0], /^\[ai-usage\] search-model-eval-judge model=google\/gemini-3\.8-flash input_tokens=300 output_tokens=20$/);
  const prompt = JSON.stringify(calls[0].messages);
  assert.ok(prompt.includes("42 units") && prompt.includes(item.question));
  assert.ok(!prompt.includes("glm") && !prompt.includes("default"), "no candidate model or arm in the prompt");
  const reloaded = createJudge({ judgeModel: "google/gemini-3.8-flash", prices, apiKey: "k", cachePath: join(dir, "cache.jsonl"), ledgerPath: null, guard: null, fetchImpl, log: () => {} });
  await reloaded(item, "About 42 units.");
  assert.equal(calls.length, 1, "cache persists across processes");
  assert.ok(judgeMessages(entry("n", { answerable: false, facts: [], supportMode: "any_of", supportPages: [] }), "x")[1].content.includes("does NOT contain"));
});

test("end-to-end report: groups, baseline pairing, histograms, markdown and audit", async () => {
  const dataset = { casesSha256: "sha", cases: [entry("c1", singleGold), entry("c2", multiGold, "multi_hop")] };
  const records = [];
  for (const model of ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash"]) for (const caseId of ["c1", "c2"]) records.push(record({ model, caseId, response: response(`${model === "z-ai/glm-5.3-flash" ? "x" : "x y"} [1]`), latencyMs: model.startsWith("z") ? 3000 : 6000 }));
  const judgments = [];
  const judge = async (item, answer) => ({ score: answer.includes("y") ? 1 : 0.5, abstained: false, cacheKey: `${item.id}:${answer}` });
  const { rows, report } = await scoreRuns({ dataset, records, judge, judgeModel: "google/gemini-3.8-flash", seed: "s", iterations: 200, onJudgment: (item) => judgments.push(item) });
  assert.equal(rows.length, 4);
  assert.equal(Object.keys(report.byModelTierKindArm).length, 4);
  const comparison = report.baseline.comparisons["deepseek/deepseek-v4.1-flash"];
  assert.equal(comparison.pairs, 2);
  assert.equal(comparison.wins, 2);
  assert.equal(comparison.meanScoreDiff.mean, 0.5);
  assert.deepEqual(compareToBaseline(rows, "z-ai/glm-5.3-flash", { seed: "s", iterations: 200 }), report.baseline.comparisons);
  assert.equal(report.histograms["z-ai/glm-5.3-flash"].latencyMs.bins.find((bin) => bin.label === "2000-5000").count, 2);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /## Give-up intelligence/);
  assert.match(markdown, /deepseek\/deepseek-v4\.1-flash \| 2 \| 2 \| 0 \| 0/);
  const audit = renderJudgeAudit(judgments, { count: 2, seed: "s" });
  assert.equal((audit.match(/^## /gm) ?? []).length, 2);
  assert.ok(!audit.includes("glm") && !audit.includes("deepseek"), "audit withholds model names");
  assert.deepEqual(histogram([0, 1, 1, 25]).bins.at(-1), { label: "20+", count: 1 });
});

test("multi-page chunks: pageNumbers fill a null pageNumber in citations, evidence and evidencePages", () => {
  const call = normalizeToolCall({ id: "c", name: "search", status: "success", evidencePages: [{ documentId: "d", pageNumber: null, pageNumbers: [1211, 1212] }, { documentId: "d", pageNumber: null }, { documentId: "d", pageNumber: 7 }] });
  assert.deepEqual(call.evidence.map((item) => item.pages), [[1211, 1212], [], [7]]);
  const extracted = extractChatResponse({ answer: "a [1]", citations: [{ text: "t", citation: { documentId: "d", pageNumber: null, pageNumbers: [1290, 1291] } }] });
  assert.deepEqual(extracted.citations[0].pages, [1290, 1291]);
});

test("page-less tool evidence never makes evidence recall lower than cited recall", () => {
  const gold = { answerable: true, facts: ["f"], supportMode: "any_of", supportPages: [{ documentId: "d", page: 1291, group: 0 }] };
  const raw = { answer: "Answer [1].", citations: [{ text: "t", citation: { documentId: "d", pageNumber: null, pageNumbers: [1290, 1291] } }], debug: { toolCalls: [{ id: "c", name: "search", status: "success", evidencePages: [{ documentId: "d", pageNumber: null }, { documentId: "e", pageNumber: 4 }] }] } };
  const r = record({ caseId: "m1", response: raw });
  r.attempts[0].response = raw;
  r.attempts[0].extracted = null;
  const row = scoreCall(entry("m1", gold), r);
  assert.equal(row.citedRecall, 1);
  assert.equal(row.evidenceRecall, 1);
  assert.equal(row.pagelessToolEvidence, 1);
  assert.equal(row.citationsOutsideEvidence, 0, "unknown, not outside, when that document has page-less evidence");
  assert.equal(row.citationValidity, 1);
  assert.deepEqual(row.citedPages, [{ documentId: "d", pages: [1290, 1291] }]);
  assert.deepEqual(row.goldPages, [{ sourceDoc: null, documentId: "d", page: 1291, group: 0 }]);
});

test("fact-grounded citation credits pages that contain the gold facts, kept separate from strict recall", () => {
  const text = { "src#1211": "The Harbor Fund awarded 4.2 million dollars in 2031.", "src#1212": "continued", "src#1291": "Harbor Fund award 4.2 million dollars", "src#50": "Riverton hosts the Coastal Office." };
  const pageText = (sourceDoc, page) => text[`${sourceDoc}#${page}`] ?? null;
  const large = matchContext({ citationMatch: "documentAndPage", documentMap: { src: "prod" } });
  const single = { answerable: true, facts: ["4.2 million dollars"], supportMode: "any_of", supportPages: [{ sourceDoc: "src", page: 1291, group: 0 }] };
  assert.equal(factGrounding(single, [cite("prod", 1211, 1212)], large, pageText).grounded, true);
  assert.equal(factGrounding(single, [cite("prod", 1212)], large, pageText).grounded, false);
  assert.equal(factGrounding(single, [cite("other", 1211)], large, pageText).grounded, null, "unmapped document has no text");
  assert.equal(factGrounding(single, [cite("prod", 1211)], large, null).grounded, null);
  const multi = { answerable: true, facts: ["4.2 million dollars", "Coastal Office"], supportMode: "all_of", supportPages: [{ sourceDoc: "src", page: 1291, group: 0 }, { sourceDoc: "src", page: 50, group: 1 }] };
  assert.equal(factGrounding(multi, [cite("prod", 1211), cite("prod", 50)], large, pageText).grounded, true, "each fact grounded by some cited page");
  assert.equal(factGrounding(multi, [cite("prod", 1211)], large, pageText).grounded, false);
  const mid = matchContext({ citationMatch: "pageOnly", scope: { sourceDocs: ["src"] } });
  assert.equal(factGrounding(single, [cite("any-slice", 1211)], mid, pageText).grounded, true, "pageOnly maps any slice to the single source");
  const r = record({ caseId: "g1", response: response("4.2 million dollars [1].", { citations: [cite("prod", 1211)] }) });
  const row = scoreCall(entry("g1", single), r, { tier: { citationMatch: "documentAndPage", documentMap: { src: "prod" } }, pageText });
  assert.equal(row.citedRecall, 0, "strict recall unchanged");
  assert.equal(row.groundedCitation, true);
  assert.equal(row.groundedEvidence, true);
  const summary = aggregate([row], { seed: "s", iterations: 50 });
  assert.equal(summary.groundedCitationRate.mean, 1);
  assert.equal(summary.groundedEvidenceRate.mean, 1);
});

test("corpus page text is loaded once for every cited or retrieved source page", async (t) => {
  const dir = tempDir(t);
  const corpus = join(dir, "pages-text.jsonl");
  writeFileSync(corpus, `${[{ sourceDoc: "src", page: 1211, text: "a" }, { sourceDoc: "src", page: 1212, text: "b" }, { sourceDoc: "src", page: 9, text: "c" }].map((row) => JSON.stringify(row)).join("\n")}\n`);
  const raw = { answer: "x [1]", citations: [{ text: "t", citation: { documentId: "prod", pageNumber: null, pageNumbers: [1211, 1212] } }], debug: { toolCalls: [{ id: "c", name: "search", status: "success", evidencePages: [{ documentId: "prod", pageNumber: 9 }, { documentId: "unmapped", pageNumber: 3 }] }] } };
  const r = record({ caseId: "c1", response: raw });
  r.attempts[0].response = raw;
  const dataset = { cases: [{ ...entry("c1", singleGold), workspaceTier: "large-58k" }], tiers: { "large-58k": { workspaceId: "ws", citationMatch: "documentAndPage", documentMap: { src: "prod" } } } };
  const lookup = await corpusPageText(corpus, { dataset, records: [r] });
  assert.equal(lookup.requested, 3);
  assert.equal(lookup.loaded, 3);
  assert.equal(lookup("src", 1212), "b");
  assert.equal(lookup("src", 1), null);
});
