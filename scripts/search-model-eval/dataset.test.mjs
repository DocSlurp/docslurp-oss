import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { judgeIntegrity } from "../evaluation-integrity-judge.mjs";
import {
  caseFromMultiHop, createSearchVerifier, freezeDataset, generateCases, generateUnanswerable, importLabeled, pairPages, splitFor, validateCase, validateDataset,
} from "./dataset.mjs";
import { BudgetGuard, assertModelAllowed, loadPrices, readJsonl, sha256 } from "./lib.mjs";

const prices = loadPrices();
const tempDir = (t) => { const dir = mkdtempSync(join(tmpdir(), "smeval-dataset-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const answerable = (id, overrides = {}) => ({
  id, workspaceTier: "mid-5k", workspaceId: "ws-a", question: `Synthetic question number ${id}?`, kind: "single_hop",
  gold: { answerable: true, facts: ["synthetic fact value"], supportMode: "any_of", supportPages: [{ documentId: "doc-1", page: Number(id.slice(-1)) + 1, group: 0 }] },
  provenance: { method: "llm-generated", generatorModel: "google/gemini-3.8-flash", createdAt: "2026-10-20T00:00:00Z", sourcePages: [] },
  ...overrides,
});
const negative = (id) => ({
  id, workspaceTier: "large-58k", workspaceId: "ws-b", question: `Synthetic absent question ${id}?`, kind: "unanswerable",
  gold: { answerable: false, facts: [], supportMode: "any_of", supportPages: [] },
  provenance: { method: "llm-generated", generatorModel: "google/gemini-3.8-flash", createdAt: "2026-10-20T00:00:00Z", sourcePages: [], verification: { passed: true, checks: [] } },
});

test("split is seeded, order independent, and keeps split groups together", () => {
  const groups = Array.from({ length: 200 }, (_, index) => `group-${index}`);
  const first = groups.map((group) => splitFor(group, { seed: "s1", testFraction: 0.3 }));
  assert.deepEqual([...groups].reverse().map((group) => splitFor(group, { seed: "s1", testFraction: 0.3 })).reverse(), first);
  const tests = first.filter((split) => split === "test").length;
  assert.ok(tests > 30 && tests < 90, `about 30% test, got ${tests}`);
  assert.notDeepEqual(groups.map((group) => splitFor(group, { seed: "s2", testFraction: 0.3 })), first);
  assert.ok(groups.every((group) => splitFor(group, { seed: "s1", testFraction: 0 }) === "dev"));
});

test("validation rejects malformed cases", () => {
  const valid = { ...answerable("synthetic-case-01"), split: "dev" };
  assert.deepEqual(validateCase(valid), []);
  const broken = [
    { ...valid, id: "short" },
    { ...valid, workspaceTier: "huge" },
    { ...valid, kind: "multi_hop" },
    { ...valid, gold: { ...valid.gold, facts: [] } },
    { ...valid, gold: { ...valid.gold, supportPages: [{ page: 2, group: 0 }] } },
    { ...negative("synthetic-neg-01"), split: "dev", gold: { ...negative("x").gold, supportPages: [{ documentId: "d", page: 1, group: 0 }] } },
    { ...negative("synthetic-neg-02"), split: "dev", provenance: { method: "llm-generated", generatorModel: "m" } },
    { ...valid, split: "holdout" },
  ];
  for (const entry of broken) assert.ok(validateCase(entry).length > 0, JSON.stringify(entry).slice(0, 80));
  assert.ok(validateCase({ ...valid, splitGroup: "g", split: splitFor("g", { seed: "s", testFraction: 0.5 }) === "dev" ? "test" : "dev" }, { seed: "s", testFraction: 0.5 }).length > 0, "split mismatch detected");
});

test("freeze is deterministic and keeps an earlier test split frozen", (t) => {
  const dir = tempDir(t);
  const candidates = Array.from({ length: 12 }, (_, index) => answerable(`synthetic-case-${String(index).padStart(2, "0")}`)).concat([negative("synthetic-neg-000")]);
  const one = freezeDataset({ candidates, outputDir: join(dir, "v1"), seed: "seed", testFraction: 0.5, createdAt: "2026-10-20T00:00:00Z" });
  const two = freezeDataset({ candidates: [...candidates].reverse(), outputDir: join(dir, "v1b"), seed: "seed", testFraction: 0.5, createdAt: "2026-10-20T00:00:00Z" });
  assert.equal(one.dataset.casesSha256, two.dataset.casesSha256);
  assert.deepEqual(validateDataset(one.dataset), []);
  assert.throws(() => freezeDataset({ candidates, outputDir: join(dir, "v1"), seed: "seed" }), /EEXIST/, "never overwrites");
  const testCase = one.dataset.cases.find((entry) => entry.split === "test");
  assert.ok(testCase, "fixture has a test case");
  const grown = freezeDataset({ candidates: [answerable("synthetic-case-99")], previous: one.dataset, outputDir: join(dir, "v2"), seed: "seed", testFraction: 0.5 });
  assert.equal(grown.dataset.cases.length, 14);
  assert.deepEqual(grown.dataset.cases.find((entry) => entry.id === testCase.id), testCase);
  const changed = { ...testCase, question: "A rewritten synthetic question?" };
  assert.throws(() => freezeDataset({ candidates: [changed], previous: one.dataset, outputDir: join(dir, "v3"), seed: "seed", testFraction: 0.5 }), /frozen test case/);
  assert.throws(() => freezeDataset({ candidates: [], previous: one.dataset, outputDir: join(dir, "v4"), seed: "other", testFraction: 0.5 }), /Split policy/);
});

test("integrity manifest is accepted by the evaluation integrity judge and catches leaks", (t) => {
  const dir = tempDir(t);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  writeFileSync(join(repo, "worker.ts"), "export const search = (query) => query;\n");
  git("add", "."); git("commit", "-qm", "baseline");
  const entry = answerable("synthetic-case-01", { gold: { answerable: true, facts: ["Northwind Research Group"], supportMode: "any_of", supportPages: [{ documentId: "doc-1", page: 2, group: 0 }] } });
  freezeDataset({ candidates: [entry, negative("synthetic-neg-000")], outputDir: join(dir, "dataset"), seed: "seed" });
  const manifest = JSON.parse(readFileSync(join(dir, "dataset", "integrity-manifest.json"), "utf8"));
  assert.equal(manifest.schema, "docslurp-authored-eval@v1");
  assert.equal(judgeIntegrity({ repo, dataset: join(dir, "dataset") }).passed, true);
  writeFileSync(join(repo, "worker.ts"), 'export const answer = "Northwind Research Group";\n');
  const report = judgeIntegrity({ repo, dataset: join(dir, "dataset") });
  assert.equal(report.passed, false);
  assert.ok(report.findings.some((finding) => finding.rule === "labeled-answer"));
});

const page = (documentId, number, text) => ({ workspaceId: "ws-a", documentId, page: number, markdown: `${text} ${"Additional filler context about the regional office operations and staffing. ".repeat(4)}` });
const replyFetch = (replies, calls = []) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  const content = replies.shift();
  return { ok: true, status: 200, text: async () => JSON.stringify({ id: `gen-${calls.length}`, model: "google/gemini-3.8-flash-001", choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.00112 } }) };
};

test("generate writes grounded single- and multi-hop cases and ledgers actual usage", async (t) => {
  const dir = tempDir(t);
  const ledgerPath = join(dir, "spend.jsonl");
  const pages = [page("doc-1", 3, "The Harbor Fund grant in 2031 was 4.2 million dollars."), page("doc-2", 7, "The Harbor Fund is administered by the Coastal Office in Riverton.")];
  const logs = [], calls = [];
  const replies = [
    { question: "How large was the Harbor Fund grant in 2031?", facts: ["4.2 million dollars"], rationale: "r" },
    { question: "Which city hosts the office administering the fund that gave 4.2 million dollars in 2031?", facts: [{ text: "4.2 million dollars", page: "A" }, { text: "Coastal Office in Riverton", page: "B" }], bridge: "Harbor Fund" },
  ];
  const result = await generateCases({ pages, tier: "mid-5k", seed: "seed", single: 1, multi: 1, generatorModel: "google/gemini-3.8-flash", prices, apiKey: "test", ledgerPath, guard: new BudgetGuard({ capUsd: 1 }), fetchImpl: replyFetch(replies, calls), log: (line) => logs.push(line) });
  assert.equal(result.accepted.length, 2, JSON.stringify(result.rejected));
  const [single, multi] = result.accepted;
  assert.equal(single.kind, "single_hop");
  assert.equal(multi.kind, "multi_hop");
  assert.equal(multi.gold.supportMode, "all_of");
  assert.deepEqual(new Set(multi.gold.supportPages.map((p) => p.group)), new Set([0, 1]));
  assert.match(single.provenance.sourcePages[0].pageSha256, /^[a-f0-9]{64}$/);
  assert.ok(calls[0].body.messages[0].content.includes("ONLY from the supplied page"));
  assert.deepEqual(calls[0].body.usage, { include: true });
  assert.equal(logs.filter((line) => /^\[ai-usage\] search-model-eval-dataset-generate model=google\/gemini-3\.8-flash input_tokens=1000 output_tokens=100$/.test(line)).length, 2);
  const ledger = readJsonl(ledgerPath);
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0].costUsd, 0.00112);
  assert.equal(ledger[0].costSource, "openrouter-usage");
});

test("ungrounded or one-sided generated facts are rejected", () => {
  const pair = { pages: [page("doc-1", 1, "Alpha value is 12."), page("doc-2", 2, "Beta value is 30.")], overlap: 0.5 };
  const options = { tier: "mid-5k", generatorModel: "google/gemini-3.8-flash", createdAt: "2026-10-20" };
  assert.equal(caseFromMultiHop(pair, { question: "What are alpha and beta values?", facts: [{ text: "Alpha value is 12", page: "A" }] }, options).rejected, "needs-facts-from-both-pages");
  assert.equal(caseFromMultiHop(pair, { question: "What are alpha and beta values?", facts: [{ text: "Alpha value is 12", page: "A" }, { text: "Gamma omega zeta", page: "B" }] }, options).rejected, "fact-not-grounded-in-page");
  assert.equal(caseFromMultiHop(pair, { question: null }, options).rejected, "writer-declined");
  assert.ok(pairPages([pair.pages[0]], { seed: "s", count: 3 }).length === 0, "needs two pages");
});

test("unanswerable keeps only questions whose key terms have no strong match, with evidence", async (t) => {
  const dir = tempDir(t);
  const pages = [page("doc-1", 1, "The Riverton office opened in 2019."), page("doc-2", 2, "The Hillside office opened in 2015.")];
  const replies = [
    { question: "When did the Lakemoor office open?", keyTerms: ["Lakemoor"], strategy: "perturbed_entity", rationale: "r" },
    { question: "When did the Stonebridge office open?", keyTerms: ["Stonebridge"], strategy: "perturbed_entity", rationale: "r" },
  ];
  const probes = [];
  const verify = async ({ probes: list }) => { probes.push(list); const strong = list.some((probe) => probe.term === "Stonebridge"); return { passed: !strong, checks: list.map((probe) => ({ ...probe, strong: probe.term === "Stonebridge" })) }; };
  const result = await generateUnanswerable({ pages, tier: "large-58k", seed: "seed", count: 2, generatorModel: "google/gemini-3.8-flash", prices, apiKey: "test", ledgerPath: join(dir, "spend.jsonl"), guard: null, verify, fetchImpl: replyFetch(replies), log: () => {} });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected[0].rejected, "strong-match-in-corpus");
  assert.equal(result.accepted[0].provenance.verification.passed, true);
  assert.ok(probes[0].some((probe) => probe.gating === false), "full question probed as evidence");
  await assert.rejects(generateUnanswerable({ pages, tier: "large-58k", seed: "s", count: 1, generatorModel: "google/gemini-3.8-flash", prices }), /verification hook/);
});

test("search verifier flags key-term hits and high relevance as strong matches", async () => {
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams.get("q");
    const results = q === "Present" ? [{ text: "this mentions present term", relevance: 0.4, citation: { documentId: "d", pageNumber: 1 } }] : q === "Close" ? [{ text: "unrelated", relevance: 0.95, citation: { documentId: "d", pageNumber: 2 } }] : [{ text: "unrelated", relevance: 0.3, citation: { documentId: "d", pageNumber: 3 } }];
    return { ok: true, status: 200, json: async () => ({ results, noMatch: false, usage: { inputTokens: 5, outputTokens: 0, costCents: 0.001 } }) };
  };
  const verify = createSearchVerifier({ baseUrl: "http://localhost:1", apiKey: "k", fetchImpl, log: () => {} });
  const result = await verify({ workspaceId: "ws", probes: [{ q: "Present", term: "Present", gating: true }, { q: "Close", term: "Close", gating: true }, { q: "Absent", term: "Absent", gating: true }] });
  assert.deepEqual(result.checks.map((check) => check.strong), [true, true, false]);
  assert.equal(result.passed, false);
});

test("import-labeled maps source documents to production ids through sha256", () => {
  const shaA = sha256("source-a"), shaB = sha256("source-b");
  const sourceDataset = {
    versionSha256: sha256("v"), documents: [{ id: "src-a", sha256: shaA }, { id: "src-b", sha256: shaB }],
    queries: [
      { id: "q-01", question: "Synthetic labeled question one?", answerable: true, labelStatus: "source-derived", expectedAnswer: "Answer one", relevant: [{ document: "src-a", page: 4 }], supportEvidence: [{ document: "src-a", support_pages: [4], support_match_all: ["x"] }] },
      { id: "q-02", question: "Synthetic labeled question two?", answerable: true, labelStatus: "provisional", expectedAnswer: "Answer two", rubric: { requiredFacts: ["fact a", "fact b"], acceptableAlternatives: ["alt"] }, relevant: [{ document: "src-a", page: 5 }, { document: "src-b", page: 9 }], supportEvidence: [{ document: "src-a", support_pages: [5] }, { document: "src-b", support_pages: [9, 10] }] },
      { id: "negative-01", question: "Synthetic negative control?", answerable: false, labelStatus: "synthetic-control", relevant: [] },
    ],
  };
  const queries = [
    { id: "q-01", split: "development", answerability: "answerable", query_group: "g1", support_groups: [["src-a:page:4"]], provenance: { query_id: "q-01" } },
    { id: "q-02", split: "validation-provisional", answerability: "answerable", query_group: "g2", support_groups: [["src-a:page:5", "src-b:page:9"]], provenance: { query_id: "q-02" } },
    { id: "negative-01", split: "development", answerability: "unanswerable", query_group: "g3", support_groups: [], provenance: { query_id: "negative-01" } },
  ];
  const documentMap = [{ documentId: "prod-a", sourceSha256: shaA }, { documentId: "prod-b", sourceSha256: shaB }];
  const { accepted } = importLabeled({ queries, sourceDataset, documentMap, workspaceId: "ws-large" });
  assert.equal(accepted.length, 3);
  const [one, two, neg] = accepted;
  assert.deepEqual(one.gold.supportPages, [{ documentId: "prod-a", sourceSha256: shaA, page: 4, group: 0 }]);
  assert.equal(two.gold.supportMode, "all_of");
  assert.deepEqual(two.gold.facts, ["fact a", "fact b"]);
  assert.equal(two.gold.supportPages.filter((p) => p.group === 1).length, 2);
  assert.equal(neg.gold.answerable, false);
  assert.equal(neg.kind, "labeled");
  for (const entry of accepted) assert.deepEqual(validateCase({ ...entry, split: "dev" }), []);
  assert.throws(() => importLabeled({ queries, sourceDataset, documentMap: [documentMap[0]], workspaceId: "ws" }), /sha256 mapping/);
  assert.equal(importLabeled({ queries, sourceDataset, documentMap: [documentMap[0]], workspaceId: "ws", allowUnmapped: true }).skipped.length, 1);
});

test("price policy blocks Pro/Ultra and output >= $50/M models", () => {
  assert.ok(assertModelAllowed("google/gemini-3.8-flash", prices));
  assert.throws(() => assertModelAllowed("openai/gpt-6-luna-pro", prices), /Pro\/Ultra/);
  assert.throws(() => assertModelAllowed("example/model-ultra", prices), /Pro\/Ultra/);
  assert.throws(() => assertModelAllowed("anthropic/claude-fable-5.1", prices), /output price/);
  assert.throws(() => assertModelAllowed("unknown/model", prices), /Unknown/);
});
