#!/usr/bin/env node
// Builds, validates and freezes the `docslurp-search-model-eval@v1` dataset.
// Generation subcommands write candidate case JSONL; `freeze` assigns seeded
// splits, keeps an earlier test split frozen and emits the integrity manifest
// that scripts/evaluation-integrity-judge.mjs checks. Datasets live outside
// the repository; this file holds only generic tooling.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DATASET_SCHEMA, DEFAULT_GENERATOR_MODEL, KINDS, SPLITS, TIERS,
  BudgetGuard, appendJsonl, assertModelAllowed, hashOf, jaccard, loadPrices, normalize, openRouterJson,
  parseArgs, readJson, readJsonl, seededOrder, sha256, stableStringify, tokenize, unitHash, writeJsonExclusive,
} from "./lib.mjs";

export const PROMPT_VERSION = "search-model-eval-generate@v1";
export const UNANSWERABLE_PROMPT_VERSION = "search-model-eval-unanswerable@v1";
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_PAGE_CHARS = 12_000;

// ---------------------------------------------------------------- split + ids

/** Seeded, order-independent split. Cases sharing a split group always land together. */
export function splitFor(group, { seed, testFraction }) {
  if (!(testFraction >= 0 && testFraction <= 1)) throw new Error("testFraction must be in [0, 1]");
  return unitHash(seed, group) < testFraction ? "test" : "dev";
}
export const caseId = (prefix, value) => `${prefix}-${hashOf(value).slice(0, 16)}`;
const pageKey = (page) => `${page.documentId ?? `sha:${page.sourceSha256}`}#${page.page}`;
export const defaultSplitGroup = (entry) => entry.splitGroup ?? (entry.gold?.supportPages?.length ? [...new Set(entry.gold.supportPages.map(pageKey))].sort().join("|") : entry.id);

// ---------------------------------------------------------------- validation

/** Returns a list of human-readable problems; empty means the case is valid. */
export function validateCase(entry, { seed = null, testFraction = null } = {}) {
  const problems = [];
  const bad = (message) => problems.push(`${entry?.id ?? "<no id>"}: ${message}`);
  if (!entry || typeof entry !== "object") return ["case is not an object"];
  if (typeof entry.id !== "string" || entry.id.length < 12 || !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(entry.id)) bad("id must be >= 12 chars of [A-Za-z0-9._-]");
  if (!TIERS.includes(entry.workspaceTier)) bad(`workspaceTier must be one of ${TIERS.join(", ")}`);
  if (typeof entry.workspaceId !== "string" || !entry.workspaceId.trim()) bad("workspaceId required");
  if (typeof entry.question !== "string" || entry.question.trim().length < 8) bad("question required");
  if (!KINDS.includes(entry.kind)) bad(`kind must be one of ${KINDS.join(", ")}`);
  const gold = entry.gold;
  if (!gold || typeof gold !== "object") { bad("gold required"); return problems; }
  if (typeof gold.answerable !== "boolean") bad("gold.answerable must be boolean");
  if (!Array.isArray(gold.facts) || gold.facts.some((fact) => typeof fact !== "string" || !fact.trim())) bad("gold.facts must be an array of non-empty strings");
  if (!["any_of", "all_of"].includes(gold.supportMode)) bad("gold.supportMode must be any_of or all_of");
  if (!Array.isArray(gold.supportPages)) bad("gold.supportPages must be an array");
  for (const page of gold.supportPages ?? []) {
    if (!Number.isSafeInteger(page?.page) || page.page < 1) bad("support page number must be a positive integer");
    if (!(typeof page?.documentId === "string" && page.documentId) && !HEX64.test(page?.sourceSha256 ?? "")) bad("support page needs documentId or sourceSha256");
    if (!Number.isSafeInteger(page?.group) || page.group < 0) bad("support page group must be a non-negative integer");
  }
  const groups = new Set((gold.supportPages ?? []).map((page) => page.group));
  if (entry.kind === "unanswerable" || gold.answerable === false) {
    if (gold.answerable !== false) bad("unanswerable case must have gold.answerable=false");
    if (gold.supportPages?.length) bad("unanswerable case cannot list support pages");
  } else {
    if (!gold.facts?.length) bad("answerable case needs at least one gold fact");
    if (!gold.supportPages?.length) bad("answerable case needs support pages");
  }
  if (entry.kind === "multi_hop" && (gold.supportMode !== "all_of" || groups.size < 2)) bad("multi_hop needs supportMode all_of with >= 2 support groups");
  if (entry.kind === "unanswerable" && entry.provenance?.verification?.passed !== true) bad("unanswerable case needs passing absence verification evidence");
  const provenance = entry.provenance;
  if (!provenance || typeof provenance.method !== "string") bad("provenance.method required");
  if (provenance?.method === "llm-generated" && (typeof provenance.generatorModel !== "string" || !provenance.generatorModel)) bad("generated case needs provenance.generatorModel");
  for (const page of provenance?.sourcePages ?? []) if (page.pageSha256 !== null && !HEX64.test(page.pageSha256 ?? "")) bad("source page hash must be sha256 hex or null");
  if (!SPLITS.includes(entry.split)) bad(`split must be one of ${SPLITS.join(", ")}`);
  else if (seed !== null && testFraction !== null && splitFor(defaultSplitGroup(entry), { seed, testFraction }) !== entry.split) bad("split does not match the seeded hash");
  return problems;
}

export function validateDataset(dataset) {
  const problems = [];
  if (dataset?.schema !== DATASET_SCHEMA) problems.push(`schema must be ${DATASET_SCHEMA}`);
  if (!Array.isArray(dataset?.cases) || !dataset.cases.length) return [...problems, "dataset has no cases"];
  const { seed, testFraction } = dataset.splitPolicy ?? {};
  if (typeof seed !== "string" || !Number.isFinite(testFraction)) problems.push("splitPolicy {seed, testFraction} required");
  const ids = new Set(), questions = new Set();
  for (const entry of dataset.cases) {
    problems.push(...validateCase(entry, { seed, testFraction }));
    if (ids.has(entry.id)) problems.push(`${entry.id}: duplicate id`);
    ids.add(entry.id);
    const question = `${entry.workspaceId}\0${normalize(entry.question)}`;
    if (questions.has(question)) problems.push(`${entry.id}: duplicate question in workspace`);
    questions.add(question);
  }
  if (dataset.casesSha256 && dataset.casesSha256 !== hashOf(dataset.cases)) problems.push("casesSha256 does not match the cases");
  return problems;
}

// ---------------------------------------------------------------- freeze

/**
 * Freezes candidates into a dataset directory. With `previous`, every test
 * case of the earlier dataset is carried over byte-identically with its split,
 * and no candidate may change a frozen case.
 */
export function freezeDataset({ candidates, outputDir, seed, testFraction = 0.5, previous = null, documents = null, createdAt = new Date().toISOString(), description = "" }) {
  const byId = new Map();
  const frozen = new Map();
  if (previous) {
    const previousProblems = validateDataset(previous);
    if (previousProblems.length) throw new Error(`Previous dataset invalid: ${previousProblems[0]}`);
    if (previous.splitPolicy.seed !== seed || previous.splitPolicy.testFraction !== testFraction) throw new Error("Split policy must match the previous dataset so the test split stays frozen");
    for (const entry of previous.cases) {
      byId.set(entry.id, entry);
      if (entry.split === "test") frozen.set(entry.id, stableStringify(entry));
    }
  }
  for (const raw of candidates) {
    const entry = { ...raw };
    entry.splitGroup = defaultSplitGroup(entry);
    entry.split = splitFor(entry.splitGroup, { seed, testFraction });
    const existing = byId.get(entry.id);
    if (existing) {
      const { split: _a, ...left } = existing, { split: _b, ...right } = entry;
      if (stableStringify(left) !== stableStringify(right)) {
        if (frozen.has(entry.id)) throw new Error(`${entry.id}: frozen test case cannot change`);
        throw new Error(`${entry.id}: candidate differs from the previous dataset; give it a new id`);
      }
      continue;
    }
    byId.set(entry.id, entry);
  }
  const cases = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const [id, text] of frozen) if (stableStringify(byId.get(id)) !== text) throw new Error(`${id}: frozen test case changed`);
  const dataset = {
    schema: DATASET_SCHEMA, createdAt, description,
    splitPolicy: { seed, testFraction, unit: "splitGroup", rule: "sha256(seed\\0splitGroup) / 2^48 < testFraction => test" },
    previousCasesSha256: previous ? hashOf(previous.cases) : null,
    documents, casesSha256: hashOf(cases), cases,
  };
  const problems = validateDataset(dataset);
  if (problems.length) throw new Error(`Dataset invalid:\n${problems.slice(0, 20).join("\n")}`);
  mkdirSync(join(outputDir, "cases"), { recursive: true });
  writeJsonExclusive(join(outputDir, "dataset.json"), dataset);
  const manifest = buildIntegrityManifest(dataset, outputDir, createdAt);
  writeJsonExclusive(join(outputDir, "integrity-manifest.json"), manifest);
  const counts = {};
  for (const entry of cases) {
    const key = `${entry.workspaceTier}/${entry.kind}/${entry.split}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const report = { schema: DATASET_SCHEMA, cases: cases.length, frozenTestCases: frozen.size, counts, casesSha256: dataset.casesSha256 };
  writeJsonExclusive(join(outputDir, "freeze-report.json"), report);
  return { dataset, manifest, report };
}

/**
 * Integrity-judge manifest (`docslurp-authored-eval@v1`). Each case gets a
 * source artifact (question and support identity) and a labels artifact (gold
 * facts) so the judge can detect any of them copied into product code.
 */
export function buildIntegrityManifest(dataset, outputDir, createdAt) {
  const cases = dataset.cases.map((entry) => {
    const source = `${JSON.stringify({ id: entry.id, workspaceId: entry.workspaceId, question: entry.question, supportPages: entry.gold.supportPages, sourcePages: entry.provenance.sourcePages ?? [] }, null, 2)}\n`;
    const labelValues = entry.gold.answerable ? entry.gold.facts : ["abstain"];
    const labels = `${JSON.stringify({ labels: [
      ...labelValues.map((expected, index) => ({ name: `fact-${index + 1}`, expected })),
      ...(entry.gold.alternatives ?? []).map((expected, index) => ({ name: `alternative-${index + 1}`, expected })),
    ] }, null, 2)}\n`;
    const sourcePath = `cases/${entry.id}.source.json`, labelsPath = `cases/${entry.id}.labels.json`;
    writeFileSync(join(outputDir, sourcePath), source, { flag: "wx" });
    writeFileSync(join(outputDir, labelsPath), labels, { flag: "wx" });
    const provenance = entry.provenance;
    const author = provenance.method === "llm-generated" ? `LLM question writer ${provenance.generatorModel} via search-model-eval dataset.mjs`
      : provenance.method === "import-labeled" ? `Imported labels (${provenance.labelStatus ?? "unknown status"}) from ${provenance.source ?? "external catalog"}`
        : provenance.author ?? provenance.method;
    return {
      id: entry.id,
      ...(provenance.originalCaseId ? { originalCaseId: provenance.originalCaseId } : {}),
      source: { path: sourcePath, sha256: sha256(source) },
      labels: { path: labelsPath, sha256: sha256(labels) },
      provenance: { kind: "authored", author, description: `${entry.kind} question for ${entry.workspaceTier}; method ${provenance.method}; source page hashes in source artifact.`, createdAt: provenance.createdAt ?? createdAt },
    };
  });
  return { schema: "docslurp-authored-eval@v1", dataset: DATASET_SCHEMA, casesSha256: dataset.casesSha256, cases };
}

// ---------------------------------------------------------------- generation

export function selectPages(pages, { seed, count, minChars = 200 }) {
  const usable = pages.filter((page) => typeof page.markdown === "string" && page.markdown.trim().length >= minChars);
  return seededOrder(usable, seed, (page) => `${page.workspaceId}:${page.documentId}:${page.page}`).slice(0, count);
}

/** Deterministic pairs within a workspace, preferring pages that share vocabulary (a bridge). */
export function pairPages(pages, { seed, count, window = 50, minOverlap = 0.04, minChars = 200 }) {
  const ordered = selectPages(pages, { seed: `${seed}:pairs`, count: Number.MAX_SAFE_INTEGER, minChars });
  const used = new Set(), pairs = [];
  const key = (page) => `${page.workspaceId}:${page.documentId}:${page.page}`;
  for (const first of ordered) {
    if (pairs.length >= count) break;
    if (used.has(key(first))) continue;
    let best = null;
    for (const second of ordered.slice(0, window * 4)) {
      if (second === first || used.has(key(second)) || second.workspaceId !== first.workspaceId) continue;
      const overlap = jaccard(first.markdown, second.markdown);
      const score = overlap + (second.documentId !== first.documentId ? 0.01 : 0);
      if (overlap >= minOverlap && (!best || score > best.score)) best = { page: second, score, overlap };
    }
    if (!best) continue;
    used.add(key(first)); used.add(key(best.page));
    pairs.push({ pages: [first, best.page], overlap: best.overlap });
  }
  return pairs;
}

const clip = (text) => String(text).slice(0, MAX_PAGE_CHARS);
const WRITER_RULES = [
  "You write evaluation questions for a document search agent that searches a very large corpus (tens of thousands of pages) and must cite pages.",
  "Write questions answerable ONLY from the supplied page text; never rely on outside knowledge.",
  "Make each question specific enough to have a unique answer in a large corpus: name the specific entity, organisation, program, product, time period or section it concerns. Never say 'this document', 'this page' or 'the text'.",
  "Do not ask about page numbers, layout, formatting or headings themselves. Avoid yes/no questions.",
  "Gold facts are short strings (at most 12 words each), copied or tightly paraphrased from the text, that a correct answer must contain.",
  "Reply with JSON only.",
];

export function singleHopMessages(page) {
  return [
    { role: "system", content: WRITER_RULES.join("\n") },
    { role: "user", content: `Page text:\n<<<\n${clip(page.markdown)}\n>>>\n\nWrite one single-hop question. JSON: {"question": string, "facts": string[1..4], "rationale": string}` },
  ];
}

export function multiHopMessages(first, second) {
  return [
    { role: "system", content: [...WRITER_RULES, "A multi-hop question needs facts from BOTH pages: use a fact from one page to identify something described on the other, or combine or compare values from both. Never join two unrelated questions with 'and'. If the pages cannot support a genuine two-page question, return {\"question\": null}."].join("\n") },
    { role: "user", content: `Page A text:\n<<<\n${clip(first.markdown)}\n>>>\n\nPage B text:\n<<<\n${clip(second.markdown)}\n>>>\n\nJSON: {"question": string|null, "facts": [{"text": string, "page": "A"|"B"}], "bridge": string}` },
  ];
}

/** Share of a fact's tokens found on its page; catches facts the writer invented. */
export function groundingOverlap(fact, markdown) {
  const tokens = [...tokenize(fact)];
  if (!tokens.length) return 0;
  const page = tokenize(markdown);
  return tokens.filter((token) => page.has(token)).length / tokens.length;
}

const sourcePage = (page) => ({ workspaceId: page.workspaceId, documentId: page.documentId, sourceSha256: page.sourceSha256 ?? null, page: page.page, pageSha256: sha256(String(page.markdown)) });

/** Turns a writer reply into a case, or returns {rejected} with a reason. */
export function caseFromSingleHop(page, reply, { tier, generatorModel, createdAt, minGrounding = 0.6 }) {
  const question = typeof reply?.question === "string" ? reply.question.trim() : "";
  const facts = Array.isArray(reply?.facts) ? reply.facts.filter((fact) => typeof fact === "string" && fact.trim()).map((fact) => fact.trim()) : [];
  if (question.length < 12 || !facts.length) return { rejected: "malformed-reply" };
  const grounding = facts.map((fact) => groundingOverlap(fact, page.markdown));
  if (grounding.some((value) => value < minGrounding)) return { rejected: "fact-not-grounded-in-page", grounding };
  const supportPages = [{ documentId: page.documentId, ...(page.sourceSha256 ? { sourceSha256: page.sourceSha256 } : {}), page: page.page, group: 0 }];
  return {
    id: caseId("gen1", { kind: "single_hop", supportPages, question: normalize(question) }),
    workspaceTier: tier, workspaceId: page.workspaceId, question, kind: "single_hop",
    gold: { answerable: true, facts, supportMode: "any_of", supportPages },
    provenance: { method: "llm-generated", generatorModel, promptVersion: PROMPT_VERSION, createdAt, rationale: reply.rationale ?? null, grounding, sourcePages: [sourcePage(page)] },
  };
}

export function caseFromMultiHop(pair, reply, { tier, generatorModel, createdAt, minGrounding = 0.6 }) {
  const [first, second] = pair.pages;
  const question = typeof reply?.question === "string" ? reply.question.trim() : "";
  if (!question) return { rejected: "writer-declined" };
  const facts = (Array.isArray(reply?.facts) ? reply.facts : []).filter((fact) => typeof fact?.text === "string" && fact.text.trim() && ["A", "B"].includes(fact.page));
  if (question.length < 12 || !facts.some((fact) => fact.page === "A") || !facts.some((fact) => fact.page === "B")) return { rejected: "needs-facts-from-both-pages" };
  const grounding = facts.map((fact) => groundingOverlap(fact.text, fact.page === "A" ? first.markdown : second.markdown));
  if (grounding.some((value) => value < minGrounding)) return { rejected: "fact-not-grounded-in-page", grounding };
  const supportPages = [first, second].map((page, group) => ({ documentId: page.documentId, ...(page.sourceSha256 ? { sourceSha256: page.sourceSha256 } : {}), page: page.page, group }));
  return {
    id: caseId("gen2", { kind: "multi_hop", supportPages, question: normalize(question) }),
    workspaceTier: tier, workspaceId: first.workspaceId, question, kind: "multi_hop",
    gold: { answerable: true, facts: facts.map((fact) => fact.text.trim()), factPages: facts.map((fact) => (fact.page === "A" ? 0 : 1)), supportMode: "all_of", supportPages },
    provenance: { method: "llm-generated", generatorModel, promptVersion: PROMPT_VERSION, createdAt, bridge: reply.bridge ?? null, pairOverlap: pair.overlap, grounding, sourcePages: [sourcePage(first), sourcePage(second)] },
  };
}

function generatorSetup(options) {
  const generatorModel = options["generator-model"] ?? DEFAULT_GENERATOR_MODEL;
  const prices = loadPrices(options.prices);
  assertModelAllowed(generatorModel, prices);
  if (!options.out) throw new Error("--out cases.jsonl required");
  const out = resolve(options.out);
  const ledgerPath = options.ledger ?? `${out}.spend.jsonl`;
  const guard = new BudgetGuard({ capUsd: Number(options["cap-usd"] ?? 1), logPath: `${out}.guard.jsonl` });
  return { generatorModel, prices, out, ledgerPath, guard };
}

/** `generate`: single- and multi-hop questions from sampled pages. */
export async function generateCases({ pages, tier, seed, single = 0, multi = 0, generatorModel, prices, apiKey, ledgerPath, guard, fetchImpl, createdAt = new Date().toISOString(), log = console.log }) {
  const accepted = [], rejected = [];
  const call = (messages, scope) => openRouterJson({ model: generatorModel, messages, apiKey, metric: "search-model-eval-dataset-generate", ledgerPath, guard, prices, fetchImpl, scope, log });
  for (const page of selectPages(pages, { seed, count: single })) {
    const reply = await call(singleHopMessages(page), { workspaceId: page.workspaceId, documentId: page.documentId, page: page.page });
    const result = caseFromSingleHop(page, reply.json, { tier, generatorModel, createdAt });
    (result.rejected ? rejected : accepted).push(result.rejected ? { kind: "single_hop", page: sourcePage(page), ...result } : result);
  }
  for (const pair of pairPages(pages, { seed, count: multi })) {
    const reply = await call(multiHopMessages(...pair.pages), { workspaceId: pair.pages[0].workspaceId, pages: pair.pages.map((page) => `${page.documentId}#${page.page}`) });
    const result = caseFromMultiHop(pair, reply.json, { tier, generatorModel, createdAt });
    (result.rejected ? rejected : accepted).push(result.rejected ? { kind: "multi_hop", pages: pair.pages.map(sourcePage), ...result } : result);
  }
  return { accepted, rejected };
}

// ---------------------------------------------------------------- unanswerable

export function unanswerableMessages(page) {
  return [
    { role: "system", content: [
      "You write NEGATIVE evaluation questions for a document search agent: plausible, in-domain questions whose answer is NOT in the corpus.",
      "Start from the supplied page. Either perturb a specific entity, name, identifier, date or number so the asked-about thing does not exist, or ask about a closely adjacent topic the page does not cover.",
      "The question must sound like a real user question for this corpus and must be specific (name the perturbed entity or value). Never say 'this document' or 'this page'.",
      "keyTerms are the 1-3 distinctive strings (the perturbed name, identifier or value) whose absence makes the question unanswerable.",
      "Reply with JSON only.",
    ].join("\n") },
    { role: "user", content: `Seed page text:\n<<<\n${clip(page.markdown)}\n>>>\n\nJSON: {"question": string, "keyTerms": string[1..3], "strategy": "perturbed_entity"|"perturbed_number"|"adjacent_topic", "rationale": string}` },
  ];
}

/**
 * A verification hook backed by `GET /v1/search`. A probe is a strong match
 * when a returned passage contains the key term, or when its relevance is at
 * or above `strongRelevance` and the server did not report noMatch.
 */
export function createSearchVerifier({ baseUrl, apiKey, fetchImpl = fetch, limit = 10, strongRelevance = 0.9, ledgerPath = null, log = console.log }) {
  return async ({ workspaceId, probes }) => {
    const checks = [];
    for (const probe of probes) {
      const url = new URL("/v1/search", baseUrl);
      url.search = new URLSearchParams({ q: probe.q, workspaceId, limit: String(limit) }).toString();
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.results)) throw new Error(`Verification search failed: HTTP ${response.status}`);
      const usage = body.usage ?? {};
      log(`[ai-usage] search-model-eval-unanswerable-verify model=workspace-search input_tokens=${usage.inputTokens ?? 0} output_tokens=${usage.outputTokens ?? 0}`);
      if (ledgerPath) appendJsonl(ledgerPath, { at: new Date().toISOString(), metric: "search-model-eval-unanswerable-verify", model: "workspace-search", inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, costUsd: Number.isFinite(usage.costCents) ? usage.costCents / 100 : null, costSource: usage.costSource ?? "unknown", scope: { workspaceId } });
      const term = normalize(probe.term ?? "");
      const top = body.results.slice(0, limit).map((result) => ({ documentId: result.citation?.documentId ?? null, pageNumber: result.citation?.pageNumber ?? null, relevance: result.relevance ?? null, score: result.score ?? null, termHit: Boolean(term) && normalize(`${result.text ?? ""} ${result.parentText ?? ""}`).includes(term) }));
      const termHit = top.some((result) => result.termHit);
      const topRelevance = top.reduce((max, result) => (Number.isFinite(result.relevance) ? Math.max(max ?? 0, result.relevance) : max), null);
      const strong = probe.gating && (termHit || (!body.noMatch && Number.isFinite(topRelevance) && topRelevance >= strongRelevance));
      checks.push({ q: probe.q, term: probe.term ?? null, gating: probe.gating, resultCount: body.results.length, noMatch: body.noMatch ?? null, topRelevance, termHit, strong, top });
    }
    return { method: "GET /v1/search", limit, strongRelevance, checks, passed: checks.every((check) => !check.strong) };
  };
}

export async function generateUnanswerable({ pages, tier, seed, count, generatorModel, prices, apiKey, ledgerPath, guard, verify, fetchImpl, createdAt = new Date().toISOString(), log = console.log }) {
  if (typeof verify !== "function") throw new Error("A verification hook is required");
  const accepted = [], rejected = [];
  for (const page of selectPages(pages, { seed: `${seed}:negative`, count })) {
    const reply = await openRouterJson({ model: generatorModel, messages: unanswerableMessages(page), apiKey, metric: "search-model-eval-dataset-unanswerable", ledgerPath, guard, prices, fetchImpl, scope: { workspaceId: page.workspaceId, documentId: page.documentId, page: page.page }, log });
    const question = typeof reply.json?.question === "string" ? reply.json.question.trim() : "";
    const keyTerms = (Array.isArray(reply.json?.keyTerms) ? reply.json.keyTerms : []).filter((term) => typeof term === "string" && term.trim().length >= 2).map((term) => term.trim()).slice(0, 3);
    if (question.length < 12 || !keyTerms.length) { rejected.push({ page: sourcePage(page), rejected: "malformed-reply" }); continue; }
    const onSeedPage = keyTerms.filter((term) => normalize(page.markdown).includes(normalize(term)));
    if (onSeedPage.length) { rejected.push({ page: sourcePage(page), question, rejected: "key-term-on-seed-page" }); continue; }
    const verification = await verify({ workspaceId: page.workspaceId, probes: [...keyTerms.map((term) => ({ q: term, term, gating: true })), { q: question, gating: false }] });
    if (!verification.passed) { rejected.push({ page: sourcePage(page), question, rejected: "strong-match-in-corpus", verification }); continue; }
    accepted.push({
      id: caseId("neg1", { workspaceId: page.workspaceId, question: normalize(question) }),
      workspaceTier: tier, workspaceId: page.workspaceId, question, kind: "unanswerable",
      gold: { answerable: false, facts: [], supportMode: "any_of", supportPages: [] },
      provenance: { method: "llm-generated", generatorModel, promptVersion: UNANSWERABLE_PROMPT_VERSION, createdAt, strategy: reply.json.strategy ?? null, rationale: reply.json.rationale ?? null, keyTerms, seedPage: sourcePage(page), sourcePages: [], verification: { ...verification, checkedAt: new Date().toISOString() } },
      splitGroup: `negative:${page.workspaceId}:${page.documentId}#${page.page}`,
    });
  }
  return { accepted, rejected };
}

// ---------------------------------------------------------------- import labeled

const parseSupportId = (value) => {
  const at = value.lastIndexOf(":page:");
  if (at < 0) throw new Error(`Unrecognised support id ${value}`);
  return { document: value.slice(0, at), page: Number(value.slice(at + 6)) };
};

/**
 * Converts large-corpus-recall labels into cases. Source documents map to
 * production documentIds through sha256 (`documentMap`: [{documentId, sourceSha256}]).
 */
export function importLabeled({ queries, sourceDataset, documentMap, pageRows = [], workspaceId, tier = "large-58k", createdAt = new Date().toISOString(), allowUnmapped = false }) {
  const sourceById = new Map((sourceDataset.documents ?? []).map((doc) => [doc.id, doc]));
  const productionBySha = new Map();
  for (const row of Array.isArray(documentMap) ? documentMap : documentMap.documents ?? []) {
    if (!HEX64.test(row.sourceSha256 ?? "") || !row.documentId) throw new Error("document map rows need documentId and sourceSha256");
    if (productionBySha.has(row.sourceSha256) && productionBySha.get(row.sourceSha256) !== row.documentId) throw new Error(`sha256 ${row.sourceSha256.slice(0, 12)} maps to two documents`);
    productionBySha.set(row.sourceSha256, row.documentId);
  }
  const pageHash = new Map(pageRows.map((row) => [row.id, row.page_sha256]));
  const sourceIdBySha = new Map([...sourceById.values()].map((doc) => [doc.sha256, doc.id]));
  const sourceQueries = new Map((sourceDataset.queries ?? []).map((query) => [query.id, query]));
  const datasetSha = sourceDataset.versionSha256 ?? hashOf(sourceDataset.queries ?? []);
  const accepted = [], skipped = [];
  for (const row of queries) {
    const query = sourceQueries.get(row.provenance?.query_id ?? row.id);
    if (!query) { skipped.push({ id: row.id, reason: "query-missing-from-source-dataset" }); continue; }
    const resolvePage = (document, page, group) => {
      const source = sourceById.get(document);
      if (!source?.sha256) throw new Error(`${row.id}: source document ${document} missing sha256`);
      const documentId = productionBySha.get(source.sha256) ?? null;
      return { ...(documentId ? { documentId } : {}), sourceSha256: source.sha256, page, group };
    };
    const answerable = query.answerable !== false && row.answerability !== "unanswerable";
    let supportPages = [];
    if (answerable) {
      const evidence = Array.isArray(query.supportEvidence) && query.supportEvidence.length ? query.supportEvidence : null;
      supportPages = evidence
        ? evidence.flatMap((premise, group) => (premise.support_pages ?? []).map((page) => resolvePage(premise.document, page, group)))
        : (row.support_groups ?? []).flatMap((ids, group) => ids.map((id) => { const { document, page } = parseSupportId(id); return resolvePage(document, page, group); }));
    }
    if (supportPages.some((page) => !page.documentId)) {
      if (!allowUnmapped) throw new Error(`${row.id}: support document not in the production document map (sha256 mapping)`);
      skipped.push({ id: row.id, reason: "unmapped-support-document" });
      continue;
    }
    const relevantPages = (query.relevant ?? []).map((relevant) => resolvePage(relevant.document, relevant.page, 0));
    const rubric = query.rubric && typeof query.rubric === "object" ? query.rubric : null;
    const facts = !answerable ? [] : rubric?.requiredFacts?.length ? rubric.requiredFacts : typeof query.expectedAnswer === "string" ? [query.expectedAnswer] : [];
    const groups = new Set(supportPages.map((page) => page.group));
    accepted.push({
      id: `lcr-${row.id}-${hashOf([datasetSha, row.id]).slice(0, 8)}`,
      workspaceTier: tier, workspaceId, question: query.question, kind: "labeled",
      gold: {
        answerable, facts, supportMode: groups.size > 1 ? "all_of" : "any_of", supportPages,
        ...(relevantPages.length ? { relevantPages } : {}),
        ...(rubric?.acceptableAlternatives?.length ? { alternatives: rubric.acceptableAlternatives } : {}),
        ...(rubric?.disqualifiers?.length ? { disqualifiers: rubric.disqualifiers } : {}),
        ...(typeof query.expectedAnswer === "string" ? { expectedAnswer: query.expectedAnswer } : {}),
      },
      provenance: {
        method: "import-labeled", source: "large-corpus-recall", originalCaseId: row.id, labelStatus: query.labelStatus ?? row.kind ?? null,
        originalSplit: row.split ?? query.split ?? null, answerabilityStatus: row.answerability_status ?? null, challenges: query.challenges ?? [],
        sourceDatasetVersionSha256: datasetSha, createdAt,
        sourcePages: relevantPages.map((page) => ({ documentId: page.documentId ?? null, sourceSha256: page.sourceSha256, page: page.page, pageSha256: pageHash.get(`${sourceIdBySha.get(page.sourceSha256)}:page:${page.page}`) ?? null })),
      },
      splitGroup: row.query_group ? `lcr:${row.query_group}` : `lcr:${row.id}`,
    });
  }
  return { accepted, skipped };
}

// ---------------------------------------------------------------- CLI

const USAGE = `Usage:
  dataset.mjs generate --pages pages.jsonl --tier mid-5k|large-58k --out cases.jsonl [--single N] [--multi N] [--seed S] [--generator-model ID] [--cap-usd 1] [--api-key-env OPENROUTER_API_KEY]
  dataset.mjs unanswerable --pages pages.jsonl --tier T --out cases.jsonl --count N --search-base URL [--search-api-key-env DOCSLURP_EVAL_API_KEY] [--strong-relevance 0.9]
  dataset.mjs import-labeled --queries queries-pages.jsonl --source-dataset dataset.json --document-map map.json --workspace-id ID --out cases.jsonl [--pages pages.jsonl] [--tier large-58k] [--allow-unmapped]
  dataset.mjs freeze --cases a.jsonl[,b.jsonl] --out-dir DIR --seed S [--test-fraction 0.5] [--previous old/dataset.json] [--documents catalog.json]
  dataset.mjs validate DIR/dataset.json`;

function writeCandidates(out, { accepted, rejected = [], skipped = [] }) {
  writeFileSync(out, accepted.map((entry) => JSON.stringify(entry)).join("\n") + (accepted.length ? "\n" : ""), { flag: "wx" });
  if (rejected.length || skipped.length) writeFileSync(`${out}.rejected.jsonl`, [...rejected, ...skipped].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" });
  console.log(JSON.stringify({ accepted: accepted.length, rejected: rejected.length, skipped: skipped.length, out }));
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseArgs(rest, { booleans: ["allow-unmapped"] });
  const createdAt = new Date().toISOString();
  if (command === "generate" || command === "unanswerable") {
    if (!options.pages || !TIERS.includes(options.tier)) throw new Error(USAGE);
    const setup = generatorSetup(options);
    const apiKey = process.env[options["api-key-env"] ?? "OPENROUTER_API_KEY"];
    const pages = readJsonl(options.pages);
    const seed = options.seed ?? "search-model-eval-v1";
    if (command === "generate") {
      writeCandidates(setup.out, await generateCases({ pages, tier: options.tier, seed, single: Number(options.single ?? 0), multi: Number(options.multi ?? 0), apiKey, createdAt, ...setup }));
    } else {
      if (!options["search-base"]) throw new Error("--search-base required for absence verification");
      const verify = createSearchVerifier({ baseUrl: options["search-base"], apiKey: process.env[options["search-api-key-env"] ?? "DOCSLURP_EVAL_API_KEY"], strongRelevance: Number(options["strong-relevance"] ?? 0.9), ledgerPath: setup.ledgerPath });
      writeCandidates(setup.out, await generateUnanswerable({ pages, tier: options.tier, seed, count: Number(options.count ?? 0), apiKey, verify, createdAt, ...setup }));
    }
    console.log(JSON.stringify({ guard: setup.guard.state() }));
  } else if (command === "import-labeled") {
    for (const key of ["queries", "source-dataset", "document-map", "workspace-id", "out"]) if (!options[key]) throw new Error(USAGE);
    writeCandidates(resolve(options.out), importLabeled({ queries: readJsonl(options.queries), sourceDataset: readJson(options["source-dataset"]), documentMap: readJson(options["document-map"]), pageRows: options.pages ? readJsonl(options.pages) : [], workspaceId: options["workspace-id"], tier: options.tier ?? "large-58k", createdAt, allowUnmapped: Boolean(options["allow-unmapped"]) }));
  } else if (command === "freeze") {
    if (!options.cases || !options["out-dir"] || !options.seed) throw new Error(USAGE);
    const candidates = options.cases.split(",").flatMap((path) => readJsonl(path));
    const { report } = freezeDataset({ candidates, outputDir: resolve(options["out-dir"]), seed: options.seed, testFraction: Number(options["test-fraction"] ?? 0.5), previous: options.previous ? readJson(options.previous) : null, documents: options.documents ? readJson(options.documents) : null, createdAt, description: options.description ?? "" });
    console.log(JSON.stringify(report, null, 2));
  } else if (command === "validate") {
    const problems = validateDataset(JSON.parse(readFileSync(options._[0], "utf8")));
    if (problems.length) { console.error(problems.join("\n")); return 1; }
    console.log("valid");
  } else {
    console.error(USAGE);
    return 2;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
