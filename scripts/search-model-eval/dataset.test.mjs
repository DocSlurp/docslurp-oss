import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { judgeIntegrity } from "../evaluation-integrity-judge.mjs";
import {
  addSilverFacts, caseFromMultiHop, createLocalVerifier, createSearchVerifier, distinctiveTerm, estimateGenerationUsd, freezeDataset, generateCases, generateUnanswerable,
  importLabeled, loadCorpusPages, normalizePage, pairPages, splitFor, tiersFromState, validateCase, validateDataset,
} from "./dataset.mjs";
import { BudgetGuard, apiKeyResolver, assertModelAllowed, loadPrices, readJsonl, sha256 } from "./lib.mjs";

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

const page = (sourceDoc, number, text) => normalizePage({ tier: "mid-5k", sourceDoc, page: number, markdown: `${text} ${"Additional filler context about the regional office operations and staffing. ".repeat(4)}` }, { workspaceId: "ws-a" });
const replyFetch = (replies, calls = []) => async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  const next = replies.shift();
  const content = typeof next === "function" ? next(body) : next;
  return { ok: true, status: 200, text: async () => JSON.stringify({ id: `gen-${calls.length}`, model: "google/gemini-3.8-flash-001", choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.00112 } }) };
};

test("generate writes grounded single- and multi-hop cases and ledgers actual usage", async (t) => {
  const dir = tempDir(t);
  const ledgerPath = join(dir, "spend.jsonl");
  const pages = [page("doc-1", 3, "The Harbor Fund grant in 2031 was 4.2 million dollars."), page("doc-2", 7, "The Harbor Fund is administered by the Coastal Office in Riverton.")];
  const logs = [], calls = [];
  const replies = [
    { question: "How large was the Harbor Fund grant in 2031?", facts: ["4.2 million dollars"], rationale: "r" },
    (body) => {
      const grantOnA = body.messages[1].content.split("Page B text")[0].includes("4.2 million");
      return { question: "Which city hosts the office administering the fund that gave 4.2 million dollars in 2031?", facts: [{ text: "4.2 million dollars", page: grantOnA ? "A" : "B" }, { text: "Coastal Office in Riverton", page: grantOnA ? "B" : "A" }], bridge: "Harbor Fund" };
    },
  ];
  const common = { pages, tier: "mid-5k", seed: "seed", generatorModel: "google/gemini-3.8-flash", prices, apiKey: "test", ledgerPath, guard: new BudgetGuard({ capUsd: 1 }), fetchImpl: replyFetch(replies, calls), log: (line) => logs.push(line) };
  const first = await generateCases({ ...common, single: 1 });
  const second = await generateCases({ ...common, multi: 1 });
  assert.equal(first.accepted.length + second.accepted.length, 2, JSON.stringify([first.rejected, second.rejected]));
  assert.deepEqual(first.shortfall, { single_hop: 0, multi_hop: 0 });
  const [single, multi] = [...first.accepted, ...second.accepted];
  assert.equal(single.gold.supportPages[0].sourceDoc, single.provenance.sourcePages[0].sourceDoc);
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

test("unanswerable keeps only candidates whose key terms are absent from the corpus, with evidence", async (t) => {
  const dir = tempDir(t);
  const pages = [page("doc-1", 1, "The Riverton office opened in 2019."), page("doc-2", 2, "The Hillside office opened in 2015.")];
  const replies = [
    { question: "When did the Lakemoor office open?", keyTerms: ["Lakemoor office", "2019"], strategy: "perturbed_entity", rationale: "r" },
    { question: "When did the Stonebridge office open?", keyTerms: ["Stonebridge"], strategy: "perturbed_entity", rationale: "r" },
  ];
  const seen = [];
  const verifyLocal = async (items) => { seen.push(...items); return new Map(items.map((item) => [item.id, { passed: !item.terms.includes("Stonebridge"), checks: item.terms.map((term) => ({ term, hits: term === "Stonebridge" ? 3 : 0 })) }])); };
  const result = await generateUnanswerable({ pages, tier: "mid-5k", seed: "seed", count: 2, generatorModel: "google/gemini-3.8-flash", prices, apiKey: "test", ledgerPath: join(dir, "spend.jsonl"), guard: null, verifyLocal, fetchImpl: replyFetch(replies), log: () => {} });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].workspaceId, "ws-a");
  assert.deepEqual(result.accepted[0].provenance.keyTerms, ["Lakemoor office"], "bare numbers are not key terms");
  assert.equal(result.accepted[0].provenance.verification.local.passed, true);
  assert.ok(result.rejected.some((entry) => entry.rejected === "key-term-in-corpus"));
  assert.equal(seen.length, 2, "one batched local pass");
  await assert.rejects(generateUnanswerable({ pages, tier: "mid-5k", seed: "s", count: 1, generatorModel: "google/gemini-3.8-flash", prices }), /local verification hook/);
  assert.equal(distinctiveTerm("2019"), false);
  assert.equal(distinctiveTerm("1,958"), false);
  assert.equal(distinctiveTerm("Lakemoor"), true);
});

test("local verifier scans only the tier scope with normalized whole-token matching", async (t) => {
  const dir = tempDir(t);
  const corpusPath = join(dir, "pages-text.jsonl");
  const rows = [
    { sourceDoc: "src-a", page: 1, pageSha256: sha256("1"), verified: true, text: "The Lakemoor-Office opened in 2019." },
    { sourceDoc: "src-a", page: 5000, pageSha256: sha256("2"), verified: true, text: "Stonebridge campus" },
    { sourceDoc: "src-b", page: 2, pageSha256: sha256("3"), verified: false, text: "Quillfeather program" },
  ];
  writeFileSync(corpusPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const scopes = { "mid-5k": { scope: { sourceDocs: ["src-a"], maxPage: 4000 } }, "large-58k": { scope: { sourceDocs: null, maxPage: null } } };
  const verify = createLocalVerifier({ corpusPath, scopes });
  const results = await verify([
    { id: "m1", tier: "mid-5k", terms: ["lakemoor office"] },
    { id: "m2", tier: "mid-5k", terms: ["Stonebridge"] },
    { id: "m3", tier: "mid-5k", terms: ["Quillfeather"] },
    { id: "m4", tier: "mid-5k", terms: ["moor off"] },
    { id: "l1", tier: "large-58k", terms: ["Quillfeather", "Stonebridge campus"] },
  ]);
  assert.equal(results.get("m1").passed, false, "punctuation-insensitive match");
  assert.deepEqual(results.get("m1").checks[0].hitPages, [{ sourceDoc: "src-a", page: 1, pageSha256: sha256("1") }]);
  assert.equal(results.get("m2").passed, true, "page 5000 is outside the mid scope");
  assert.equal(results.get("m3").passed, true, "other documents are outside the mid scope");
  assert.equal(results.get("m4").passed, true, "partial tokens do not match");
  assert.equal(results.get("m1").pagesScanned, 1);
  assert.equal(results.get("l1").pagesScanned, 3);
  assert.equal(results.get("l1").unverifiedPagesScanned, 1);
  assert.deepEqual(results.get("l1").checks.map((check) => check.hits), [1, 1]);
});

test("search verifier flags key-term hits and high relevance as strong matches", async () => {
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams.get("q");
    const results = q === "Present" ? [{ text: "this mentions present term", relevance: 0.4, citation: { documentId: "d", pageNumber: 1 } }] : q === "Close" ? [{ text: "unrelated", relevance: 0.95, citation: { documentId: "d", pageNumber: 2 } }] : [{ text: "unrelated", relevance: 0.3, citation: { documentId: "d", pageNumber: 3 } }];
    return { ok: true, status: 200, json: async () => ({ results, noMatch: false, usage: { inputTokens: 5, outputTokens: 0, costCents: 0.001 } }) };
  };
  const verify = createSearchVerifier({ baseUrl: "http://localhost:1", apiKeyForTier: () => "k", fetchImpl, log: () => {} });
  const result = await verify({ workspaceId: "ws", tier: "mid-5k", probes: [{ q: "Present", term: "Present", gating: true }, { q: "Close", term: "Close", gating: true }, { q: "Absent", term: "Absent", gating: true }] });
  assert.deepEqual(result.checks.map((check) => check.strong), [true, true, false]);
  assert.equal(result.passed, false);
});

test("import-labeled keeps OR-within/AND-across support groups and resolves documents by sourceDoc", () => {
  const sourceDataset = {
    versionSha256: sha256("v"),
    queries: [
      { id: "q-01", question: "Synthetic labeled question one?", answerable: true, labelStatus: "source-derived", expectedAnswer: "Answer one" },
      { id: "q-02", question: "Synthetic labeled question two?", answerable: true, labelStatus: "provisional", rubric: { requiredFacts: ["fact a", "fact b"], acceptableAlternatives: ["alt"] } },
      { id: "negative-01", question: "Synthetic negative control?", answerable: false, labelStatus: "synthetic-control" },
    ],
  };
  const queries = [
    { id: "q-01", kind: "source-derived", split: "development", answerability: "answerable", query_group: "g1", support_groups: [["src-a:page:4"]], provenance: { query_id: "q-01" } },
    { id: "q-02", kind: "provisional", split: "validation-provisional", answerability: "answerable", query_group: "g2", support_groups: [["src-a:page:5", "src-b:page:9"], ["src-b:page:12"]], provenance: { query_id: "q-02" } },
    { id: "negative-01", kind: "synthetic-control", split: "development", answerability: "unanswerable", query_group: "g3", support_groups: [], provenance: { query_id: "negative-01" } },
    { id: "q-missing", answerability: "answerable", support_groups: [["src-a:page:1"]], provenance: { query_id: "q-missing" } },
  ];
  const { accepted, skipped } = importLabeled({ queries, sourceDataset, workspaceId: "ws-large", documentMap: { "src-a": "prod-a" } });
  assert.equal(accepted.length, 3);
  assert.equal(skipped[0].reason, "question-text-missing-from-source-dataset");
  const [one, two, neg] = accepted;
  assert.deepEqual(one.gold.supportPages, [{ sourceDoc: "src-a", documentId: "prod-a", page: 4, group: 0 }]);
  assert.equal(one.gold.supportMode, "any_of");
  assert.equal(two.gold.supportMode, "all_of");
  assert.deepEqual(two.gold.supportPages.map((p) => [p.sourceDoc, p.page, p.group, p.documentId ?? null]), [["src-a", 5, 0, "prod-a"], ["src-b", 9, 0, null], ["src-b", 12, 1, null]]);
  assert.deepEqual(two.gold.sourceFacts, ["fact a", "fact b"]);
  assert.match(two.provenance.labelStatus, /provisional/);
  assert.equal(neg.gold.answerable, false);
  assert.equal(neg.kind, "labeled");
  assert.deepEqual(validateCase({ ...neg, split: "dev" }), []);
  assert.ok(validateCase({ ...one, split: "dev" }).some((problem) => /gold fact/.test(problem)), "facts pending until silver extraction");
});

test("silver facts are extracted from support page text, grounded, and ledgered", async (t) => {
  const dir = tempDir(t);
  const corpusPath = join(dir, "pages-text.jsonl");
  writeFileSync(corpusPath, [
    { sourceDoc: "src-a", page: 4, pageSha256: sha256("p4"), verified: true, text: "The Harbor Fund awarded 4.2 million dollars in 2031." },
    { sourceDoc: "src-a", page: 5, pageSha256: sha256("p5"), verified: true, text: "Unrelated content." },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const { accepted: imported } = importLabeled({
    queries: [{ id: "q-01", answerability: "answerable", support_groups: [["src-a:page:4"]], provenance: { query_id: "q-01" } }, { id: "q-02", answerability: "answerable", support_groups: [["src-a:page:5"]], provenance: { query_id: "q-02" } }, { id: "q-03", answerability: "answerable", support_groups: [["src-a:page:5"]], provenance: { query_id: "q-03" } }],
    sourceDataset: { queries: [{ id: "q-01", question: "How much did the Harbor Fund award?" }, { id: "q-02", question: "Unanswerable from text question?", expectedAnswer: "Source answer" }, { id: "q-03", question: "Another question here?" }] },
    workspaceId: "ws",
  });
  const corpus = await loadCorpusPages(corpusPath, imported.flatMap((entry) => entry.gold.supportPages));
  assert.equal(corpus.size, 2);
  const calls = [];
  const replies = [{ found: true, facts: ["4.2 million dollars"] }, { found: false }, { found: true, facts: ["invented zeta omega"] }];
  const { accepted, skipped } = await addSilverFacts({ cases: imported, corpus, generatorModel: "google/gemini-3.8-flash", prices, apiKey: "k", ledgerPath: join(dir, "spend.jsonl"), guard: new BudgetGuard({ capUsd: 1 }), fetchImpl: replyFetch(replies, calls), log: () => {} });
  assert.deepEqual(accepted[0].gold.facts, ["4.2 million dollars"]);
  assert.equal(accepted[0].gold.factsStatus, "silver-generator-extracted");
  assert.equal(accepted[0].provenance.sourcePages[0].pageSha256, sha256("p4"));
  assert.deepEqual(accepted[1].gold.facts, ["Source answer"]);
  assert.equal(accepted[1].gold.factsStatus, "source-labels-fallback");
  assert.equal(skipped[0].reason, "silver-facts-not-found", "ungrounded silver facts are not accepted");
  assert.ok(calls[0].body.messages[1].content.includes("Harbor Fund awarded"));
  assert.equal(readJsonl(join(dir, "spend.jsonl")).length, 3);
});

test("tier config maps sourceDoc to production documents and per-tier keys come from a credentials file", (t) => {
  const tiers = tiersFromState({ state: { workspaceId: "ws-large", docs: { "src-a": { documentId: "prod-a", sha256: sha256("a"), pagesTotal: 10 }, "src-b": { documentId: null } } }, mid: { workspaceId: "ws-mid", sourceDocs: ["src-a"], maxPage: 4000, documents: [{ documentId: "slice-1", pageCount: 500 }] }, large: { workspaceId: "ws-large" } });
  assert.equal(tiers["mid-5k"].citationMatch, "pageOnly");
  assert.deepEqual(tiers["mid-5k"].scope, { sourceDocs: ["src-a"], maxPage: 4000 });
  assert.deepEqual(tiers["mid-5k"].documents, { "slice-1": { pageCount: 500 } });
  assert.equal(tiers["large-58k"].citationMatch, "documentAndPage");
  assert.deepEqual(tiers["large-58k"].documentMap, { "src-a": "prod-a" });
  assert.equal(tiers["large-58k"].documents["prod-a"].pageCount, 10);
  const dir = tempDir(t);
  writeFileSync(join(dir, "creds.json"), JSON.stringify({ midApiKey: "mid-key", largeApiKey: "large-key" }));
  const keyFor = apiKeyResolver({ credentialsPath: join(dir, "creds.json") });
  assert.equal(keyFor("mid-5k"), "mid-key");
  assert.equal(keyFor("large-58k"), "large-key");
  assert.equal(apiKeyResolver({ envByTier: { "mid-5k": "X_KEY" }, env: { X_KEY: "env-key" } })("mid-5k"), "env-key");
  assert.throws(() => apiKeyResolver({ envByTier: { "mid-5k": "MISSING" }, env: {} })("mid-5k"), /No API key/);
  const page = normalizePage({ tier: "mid-5k", sourceDoc: "src-a", page: 3, pageSha256: sha256("x"), markdown: "text" }, { workspaceId: "ws-mid" });
  assert.deepEqual([page.workspaceId, page.sourceDoc, page.documentId, page.pageSha256], ["ws-mid", "src-a", null, sha256("x")]);
  const estimate = estimateGenerationUsd({ model: "google/gemini-3.8-flash", prices, calls: 10, avgPromptChars: 3000 });
  assert.ok(Math.abs(estimate.worstCaseUsd - 10 * ((1500 * 0.75 + 1024 * 3.75) / 1e6)) < 1e-12);
});

test("price policy blocks Pro/Ultra and output >= $50/M models", () => {
  assert.ok(assertModelAllowed("google/gemini-3.8-flash", prices));
  assert.throws(() => assertModelAllowed("openai/gpt-6-luna-pro", prices), /Pro\/Ultra/);
  assert.throws(() => assertModelAllowed("example/model-ultra", prices), /Pro\/Ultra/);
  assert.throws(() => assertModelAllowed("anthropic/claude-fable-5.1", prices), /output price/);
  assert.throws(() => assertModelAllowed("unknown/model", prices), /Unknown/);
});
