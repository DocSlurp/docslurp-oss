#!/usr/bin/env node
// Builds, validates and freezes the `docslurp-search-model-eval@v1` dataset.
// Generation subcommands write candidate case JSONL; `freeze` assigns seeded
// splits, keeps an earlier test split frozen and emits the integrity manifest
// that scripts/evaluation-integrity-judge.mjs checks. Datasets live outside
// the repository; this file holds only generic tooling.
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  DATASET_SCHEMA, DEFAULT_GENERATOR_MODEL, KINDS, SPLITS, TIERS,
  BudgetGuard, apiKeyResolver, appendJsonl, assertModelAllowed, hashOf, jaccard, loadPrices, normalize, openRouterJson,
  parseArgs, readJson, readJsonl, seededOrder, sha256, stableStringify, tokenCostUsd, tokenize, unitHash, writeJsonExclusive,
} from "./lib.mjs";

export const PROMPT_VERSION = "search-model-eval-generate@v1";
export const UNANSWERABLE_PROMPT_VERSION = "search-model-eval-unanswerable@v2";
export const SILVER_PROMPT_VERSION = "search-model-eval-silver-facts@v1";
export const CITATION_MATCHES = ["documentAndPage", "pageOnly"];
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_PAGE_CHARS = 12_000;
const GENERATE_MAX_TOKENS = 1_024;

// ---------------------------------------------------------------- split + ids

/** Seeded, order-independent split. Cases sharing a split group always land together. */
export function splitFor(group, { seed, testFraction }) {
  if (!(testFraction >= 0 && testFraction <= 1)) throw new Error("testFraction must be in [0, 1]");
  return unitHash(seed, group) < testFraction ? "test" : "dev";
}
export const caseId = (prefix, value) => `${prefix}-${hashOf(value).slice(0, 16)}`;
/** Source identity of a page: sourceDoc, else production documentId, else source sha256. */
export const pageIdentity = (page) => page.sourceDoc ?? page.documentId ?? `sha:${page.sourceSha256}`;
const pageKey = (page) => `${pageIdentity(page)}#${page.page}`;
export const defaultSplitGroup = (entry) => entry.splitGroup ?? (entry.gold?.supportPages?.length ? [...new Set(entry.gold.supportPages.map(pageKey))].sort().join("|") : entry.id);

// ---------------------------------------------------------------- tier config

/**
 * Per-tier settings stored in the dataset (`dataset.tiers`) and overridable at
 * scoring time: workspace, how citations match gold (`documentAndPage` or
 * `pageOnly` for workspaces of prefix slices of one source), the source pages
 * in scope for absence checks, and sourceDoc -> production documentId.
 */
export function validateTiers(tiers) {
  const problems = [];
  for (const [tier, config] of Object.entries(tiers ?? {})) {
    if (!TIERS.includes(tier)) problems.push(`tiers.${tier}: unknown tier`);
    if (typeof config?.workspaceId !== "string" || !config.workspaceId) problems.push(`tiers.${tier}: workspaceId required`);
    if (!CITATION_MATCHES.includes(config?.citationMatch)) problems.push(`tiers.${tier}: citationMatch must be ${CITATION_MATCHES.join(" or ")}`);
  }
  return problems;
}

/** Tier config from an ingest state.json ({docs: {sourceDoc: {documentId, sha256, pagesTotal}}}). */
export function tiersFromState({ state = null, mid, large }) {
  const documentMap = {}, documents = {};
  for (const [sourceDoc, doc] of Object.entries(state?.docs ?? {})) {
    if (!doc?.documentId) continue;
    documentMap[sourceDoc] = doc.documentId;
    documents[doc.documentId] = { sourceDoc, sha256: doc.sha256 ?? null, pageCount: Number.isSafeInteger(doc.pagesTotal) ? doc.pagesTotal : null, status: doc.status ?? null };
  }
  const tiers = {};
  // Mid documents ({documentId: pageCount} or [{documentId, pageCount}]) bound pageOnly matches by each slice's length.
  const midDocuments = Object.fromEntries((Array.isArray(mid?.documents) ? mid.documents.map((doc) => [doc.documentId, doc.pageCount]) : Object.entries(mid?.documents ?? {})).map(([documentId, pageCount]) => [documentId, { pageCount: Number.isSafeInteger(pageCount) ? pageCount : null }]));
  if (mid) tiers["mid-5k"] = { workspaceId: mid.workspaceId, citationMatch: "pageOnly", scope: { sourceDocs: mid.sourceDocs ?? null, maxPage: mid.maxPage ?? null }, documentMap: {}, documents: midDocuments };
  if (large) tiers["large-58k"] = { workspaceId: large.workspaceId ?? state?.workspaceId, citationMatch: "documentAndPage", scope: { sourceDocs: large.sourceDocs ?? null, maxPage: large.maxPage ?? null }, documentMap, documents };
  const problems = validateTiers(tiers);
  if (problems.length) throw new Error(problems.join("\n"));
  return tiers;
}

const inScope = (scope, sourceDoc, page) => (!scope?.sourceDocs || scope.sourceDocs.includes(sourceDoc)) && (!Number.isSafeInteger(scope?.maxPage) || page <= scope.maxPage);

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
    if (!(typeof page?.sourceDoc === "string" && page.sourceDoc) && !(typeof page?.documentId === "string" && page.documentId) && !HEX64.test(page?.sourceSha256 ?? "")) bad("support page needs sourceDoc, documentId or sourceSha256");
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
  problems.push(...validateTiers(dataset.tiers));
  const ids = new Set(), questions = new Set();
  for (const entry of dataset.cases) {
    problems.push(...validateCase(entry, { seed, testFraction }));
    if (ids.has(entry.id)) problems.push(`${entry.id}: duplicate id`);
    ids.add(entry.id);
    const question = `${entry.workspaceId}\0${normalize(entry.question)}`;
    if (questions.has(question)) problems.push(`${entry.id}: duplicate question in workspace`);
    questions.add(question);
    const tier = dataset.tiers?.[entry.workspaceTier];
    if (tier && tier.workspaceId !== entry.workspaceId) problems.push(`${entry.id}: workspaceId differs from tiers.${entry.workspaceTier}.workspaceId`);
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
export function freezeDataset({ candidates, outputDir, seed, testFraction = 0.7, previous = null, tiers = null, createdAt = new Date().toISOString(), description = "" }) {
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
    tiers: tiers ?? previous?.tiers ?? null, casesSha256: hashOf(cases), cases,
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
      ...(entry.gold.sourceFacts ?? []).map((expected, index) => ({ name: `source-fact-${index + 1}`, expected })),
    ] }, null, 2)}\n`;
    const sourcePath = `cases/${entry.id}.source.json`, labelsPath = `cases/${entry.id}.labels.json`;
    writeFileSync(join(outputDir, sourcePath), source, { flag: "wx" });
    writeFileSync(join(outputDir, labelsPath), labels, { flag: "wx" });
    const provenance = entry.provenance;
    const author = provenance.method === "llm-generated" ? `LLM question writer ${provenance.generatorModel} via search-model-eval dataset.mjs`
      : provenance.method === "import-labeled" ? `Imported labels (${provenance.labelStatus ?? "unknown status"}) from ${provenance.source ?? "external catalog"}; facts ${entry.gold.factsStatus ?? "unspecified"}`
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

// ---------------------------------------------------------------- pages

/**
 * Accepts {tier, sourceDoc, page, pageSha256, markdown} sample rows (and the
 * older {workspaceId, documentId, page, markdown}); the workspace comes from
 * the row or the tier config.
 */
export function normalizePage(raw, { tier = null, workspaceId = null } = {}) {
  const markdown = String(raw.markdown ?? raw.text ?? "");
  return {
    tier: raw.tier ?? tier, workspaceId: raw.workspaceId ?? workspaceId,
    sourceDoc: raw.sourceDoc ?? null, documentId: raw.documentId ?? null, sourceSha256: raw.sourceSha256 ?? null,
    page: raw.page, pageSha256: HEX64.test(raw.pageSha256 ?? "") ? raw.pageSha256 : sha256(markdown), markdown,
  };
}
const pageRef = (page) => `${pageIdentity(page)}#${page.page}`;

export function selectPages(pages, { seed, count = Number.MAX_SAFE_INTEGER, minChars = 200, exclude = new Set() }) {
  const usable = pages.filter((page) => page.markdown.trim().length >= minChars && !exclude.has(pageRef(page)));
  return seededOrder(usable, seed, (page) => `${page.workspaceId}:${pageRef(page)}`).slice(0, count);
}

/** Deterministic pairs within a workspace, preferring pages that share vocabulary (a bridge). */
export function pairPages(pages, { seed, count = Number.MAX_SAFE_INTEGER, window = 50, minOverlap = 0.04, minChars = 200, exclude = new Set() }) {
  const ordered = selectPages(pages, { seed: `${seed}:pairs`, minChars, exclude });
  const used = new Set(), pairs = [];
  for (const first of ordered) {
    if (pairs.length >= count) break;
    if (used.has(pageRef(first))) continue;
    let best = null;
    for (const second of ordered.slice(0, window * 4)) {
      if (second === first || used.has(pageRef(second)) || second.workspaceId !== first.workspaceId) continue;
      const overlap = jaccard(first.markdown, second.markdown);
      const score = overlap + (pageIdentity(second) !== pageIdentity(first) ? 0.01 : 0);
      if (overlap >= minOverlap && (!best || score > best.score)) best = { page: second, score, overlap };
    }
    if (!best) continue;
    used.add(pageRef(first)); used.add(pageRef(best.page));
    pairs.push({ pages: [first, best.page], overlap: best.overlap });
  }
  return pairs;
}

const clip = (text, max = MAX_PAGE_CHARS) => String(text).slice(0, max);
const sourcePage = (page) => ({ workspaceId: page.workspaceId, sourceDoc: page.sourceDoc, documentId: page.documentId, sourceSha256: page.sourceSha256, page: page.page, pageSha256: page.pageSha256 });
const supportPage = (page, group) => ({ ...(page.sourceDoc ? { sourceDoc: page.sourceDoc } : {}), ...(page.documentId ? { documentId: page.documentId } : {}), ...(page.sourceSha256 ? { sourceSha256: page.sourceSha256 } : {}), page: page.page, group });

// ---------------------------------------------------------------- generation

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

/** Turns a writer reply into a case, or returns {rejected} with a reason. */
export function caseFromSingleHop(page, reply, { tier, generatorModel, createdAt, minGrounding = 0.6 }) {
  const question = typeof reply?.question === "string" ? reply.question.trim() : "";
  const facts = Array.isArray(reply?.facts) ? reply.facts.filter((fact) => typeof fact === "string" && fact.trim()).map((fact) => fact.trim()) : [];
  if (question.length < 12 || !facts.length) return { rejected: "malformed-reply" };
  const grounding = facts.map((fact) => groundingOverlap(fact, page.markdown));
  if (grounding.some((value) => value < minGrounding)) return { rejected: "fact-not-grounded-in-page", grounding };
  const supportPages = [supportPage(page, 0)];
  return {
    id: caseId("gen1", { kind: "single_hop", supportPages, question: normalize(question) }),
    workspaceTier: tier, workspaceId: page.workspaceId, question, kind: "single_hop",
    gold: { answerable: true, facts, factsStatus: "generator-authored", supportMode: "any_of", supportPages },
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
  const supportPages = [first, second].map((page, group) => supportPage(page, group));
  return {
    id: caseId("gen2", { kind: "multi_hop", supportPages, question: normalize(question) }),
    workspaceTier: tier, workspaceId: first.workspaceId, question, kind: "multi_hop",
    gold: { answerable: true, facts: facts.map((fact) => fact.text.trim()), factPages: facts.map((fact) => (fact.page === "A" ? 0 : 1)), factsStatus: "generator-authored", supportMode: "all_of", supportPages },
    provenance: { method: "llm-generated", generatorModel, promptVersion: PROMPT_VERSION, createdAt, bridge: reply.bridge ?? null, pairOverlap: pair.overlap, grounding, sourcePages: [sourcePage(first), sourcePage(second)] },
  };
}

const defaultMaxCalls = (target) => Math.ceil(target * 2);

/**
 * Pairs each sampled page with its best-overlapping neighbour (same source
 * document, within `span` pages) drawn from the full corpus, so a multi-hop
 * question can bridge consecutive pages of one section.
 */
export function pairNeighbourPages(pages, neighbours, { seed, span = 3, minOverlap = 0.03, minChars = 200, exclude = new Set() }) {
  const used = new Set(), pairs = [];
  for (const first of selectPages(pages, { seed: `${seed}:neighbours`, minChars, exclude })) {
    if (used.has(pageRef(first))) continue;
    let best = null;
    for (let offset = -span; offset <= span; offset++) {
      if (!offset) continue;
      const second = neighbours.get(`${first.sourceDoc}#${first.page + offset}`);
      if (!second || second.markdown.trim().length < minChars || used.has(pageRef(second)) || exclude.has(pageRef(second))) continue;
      const overlap = jaccard(first.markdown, second.markdown);
      if (overlap >= minOverlap && (!best || overlap > best.overlap)) best = { page: second, overlap };
    }
    if (!best) continue;
    used.add(pageRef(first)); used.add(pageRef(best.page));
    pairs.push({ pages: first.page < best.page.page ? [first, best.page] : [best.page, first], overlap: best.overlap });
  }
  return pairs;
}

/**
 * `generate`: walks the seeded page order until `single` single-hop and
 * `multi` multi-hop cases are accepted or each kind's call cap is reached.
 * Pages behind accepted single-hop cases are not reused for pairs.
 */
export async function generateCases({ pages, neighbours = null, tier, seed, single = 0, multi = 0, maxSingleCalls = defaultMaxCalls(single), maxMultiCalls = defaultMaxCalls(multi), generatorModel, prices, apiKey, ledgerPath, guard, fetchImpl, createdAt = new Date().toISOString(), log = console.log }) {
  const accepted = [], rejected = [];
  const call = (messages, scope) => openRouterJson({ model: generatorModel, messages, apiKey, metric: "search-model-eval-dataset-generate", ledgerPath, guard, prices, fetchImpl, scope, maxTokens: GENERATE_MAX_TOKENS, log });
  const used = new Set();
  let calls = 0, singles = 0;
  for (const page of selectPages(pages, { seed })) {
    if (singles >= single || calls >= maxSingleCalls) break;
    calls++;
    const reply = await call(singleHopMessages(page), { tier, page: pageRef(page) });
    const result = caseFromSingleHop(page, reply.json, { tier, generatorModel, createdAt });
    if (result.rejected) rejected.push({ kind: "single_hop", page: sourcePage(page), ...result });
    else { accepted.push(result); used.add(pageRef(page)); singles++; }
  }
  calls = 0;
  let multis = 0;
  for (const pair of neighbours ? pairNeighbourPages(pages, neighbours, { seed, exclude: used }) : pairPages(pages, { seed, exclude: used })) {
    if (multis >= multi || calls >= maxMultiCalls) break;
    calls++;
    const reply = await call(multiHopMessages(...pair.pages), { tier, pages: pair.pages.map(pageRef) });
    const result = caseFromMultiHop(pair, reply.json, { tier, generatorModel, createdAt });
    if (result.rejected) rejected.push({ kind: "multi_hop", pages: pair.pages.map(sourcePage), ...result });
    else { accepted.push(result); multis++; }
  }
  return { accepted, rejected, shortfall: { single_hop: single - singles, multi_hop: multi - multis } };
}

// ---------------------------------------------------------------- unanswerable

export function unanswerableMessages(page) {
  return [
    { role: "system", content: [
      "You write NEGATIVE evaluation questions for a document search agent: plausible, in-domain questions whose answer is NOT in the corpus.",
      "Start from the supplied page. Either perturb a specific entity, name, identifier, date or number so the asked-about thing does not exist, or ask about a closely adjacent topic the page does not cover.",
      "The question must sound like a real user question for this corpus and must be specific (name the perturbed entity or value). Never say 'this document' or 'this page'.",
      "keyTerms are 1-3 strings whose absence from the corpus makes the question unanswerable: a distinctive invented name or identifier, or a short phrase (2-6 words) that includes the perturbed value with its context. Never give a bare number or a common word as a key term.",
      "Reply with JSON only.",
    ].join("\n") },
    { role: "user", content: `Seed page text:\n<<<\n${clip(page.markdown)}\n>>>\n\nJSON: {"question": string, "keyTerms": string[1..3], "strategy": "perturbed_entity"|"perturbed_number"|"adjacent_topic", "rationale": string}` },
  ];
}

/** Lexical normalization for absence checks: NFKC, lowercase, punctuation to spaces. */
export const lexical = (text) => String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** A key term must be distinctive: >= 4 chars and not a bare number. */
export function distinctiveTerm(term) {
  const value = lexical(term);
  return value.length >= 4 && !/^[\d ]+$/.test(value);
}

/** Streams a JSONL file line by line. */
export async function forEachJsonl(path, visit) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY });
  let index = 0;
  for await (const line of lines) { index++; if (line.trim()) await visit(JSON.parse(line), index); }
}

/**
 * Exhaustive local absence check over the verified corpus text
 * ({sourceDoc, page, pageSha256, verified, text} per line). One streaming pass
 * checks every candidate's key terms against the pages in its tier's scope.
 * A candidate passes only when no key term occurs on any in-scope page.
 */
export function createLocalVerifier({ corpusPath, scopes }) {
  return async (items) => {
    const byTier = new Map();
    for (const item of items) {
      if (!byTier.has(item.tier)) byTier.set(item.tier, []);
      byTier.get(item.tier).push({ item, terms: item.terms.map((term) => ({ term, needle: ` ${lexical(term)} `, hits: 0, hitPages: [] })) });
    }
    const scanned = new Map([...byTier.keys()].map((tier) => [tier, { pages: 0, unverified: 0 }]));
    await forEachJsonl(corpusPath, (row) => {
      let text = null;
      for (const [tier, entries] of byTier) {
        if (!inScope(scopes?.[tier]?.scope ?? scopes?.[tier], row.sourceDoc, row.page)) continue;
        text ??= ` ${lexical(row.text)} `;
        const count = scanned.get(tier);
        count.pages++;
        if (row.verified === false) count.unverified++;
        for (const entry of entries) for (const term of entry.terms) {
          if (!text.includes(term.needle)) continue;
          term.hits++;
          if (term.hitPages.length < 5) term.hitPages.push({ sourceDoc: row.sourceDoc, page: row.page, pageSha256: row.pageSha256 ?? null });
        }
      }
    });
    const stat = statSync(corpusPath);
    return new Map([...byTier].flatMap(([tier, entries]) => entries.map(({ item, terms }) => [item.id, {
      method: "local-lexical", corpus: { path: corpusPath, bytes: stat.size, mtime: stat.mtime.toISOString() },
      normalization: "NFKC, lowercase, non-letter/digit runs to single spaces, whole-token phrase match",
      scope: scopes?.[tier]?.scope ?? scopes?.[tier] ?? null, pagesScanned: scanned.get(tier).pages, unverifiedPagesScanned: scanned.get(tier).unverified,
      checks: terms.map(({ term, hits, hitPages }) => ({ term, hits, hitPages, strong: hits > 0 })),
      passed: scanned.get(tier).pages > 0 && terms.every((term) => term.hits === 0),
    }])));
  };
}

/**
 * Optional hook backed by `GET /v1/search`. A probe is a strong match when a
 * returned passage contains the key term, or when its relevance is at or
 * above `strongRelevance` and the server did not report noMatch.
 */
export function createSearchVerifier({ baseUrl, apiKeyForTier, fetchImpl = fetch, limit = 10, strongRelevance = 0.9, ledgerPath = null, log = console.log }) {
  return async ({ workspaceId, tier, probes }) => {
    const checks = [];
    for (const probe of probes) {
      const url = new URL("/v1/search", baseUrl);
      url.search = new URLSearchParams({ q: probe.q, workspaceId, limit: String(limit) }).toString();
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKeyForTier(tier)}`, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.results)) throw new Error(`Verification search failed: HTTP ${response.status}`);
      const usage = body.usage ?? {};
      log(`[ai-usage] search-model-eval-unanswerable-verify model=workspace-search input_tokens=${usage.inputTokens ?? 0} output_tokens=${usage.outputTokens ?? 0}`);
      if (ledgerPath) appendJsonl(ledgerPath, { at: new Date().toISOString(), metric: "search-model-eval-unanswerable-verify", model: "workspace-search", inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, costUsd: Number.isFinite(usage.costCents) ? usage.costCents / 100 : null, costSource: usage.costSource ?? "unknown", scope: { workspaceId } });
      const term = lexical(probe.term ?? "");
      const top = body.results.slice(0, limit).map((result) => ({ documentId: result.citation?.documentId ?? null, pageNumber: result.citation?.pageNumber ?? null, relevance: result.relevance ?? null, score: result.score ?? null, termHit: Boolean(term) && ` ${lexical(`${result.text ?? ""} ${result.parentText ?? ""}`)} `.includes(` ${term} `) }));
      const termHit = top.some((result) => result.termHit);
      const topRelevance = top.reduce((max, result) => (Number.isFinite(result.relevance) ? Math.max(max ?? 0, result.relevance) : max), null);
      const strong = probe.gating && (termHit || (!body.noMatch && Number.isFinite(topRelevance) && topRelevance >= strongRelevance));
      checks.push({ q: probe.q, term: probe.term ?? null, gating: probe.gating, resultCount: body.results.length, noMatch: body.noMatch ?? null, topRelevance, termHit, strong, top });
    }
    return { method: "GET /v1/search", limit, strongRelevance, checks, passed: checks.every((check) => !check.strong) };
  };
}

/**
 * `unanswerable`: writes candidates from seeded seed pages, then verifies them
 * all. The local corpus check is primary (exhaustive); the optional search
 * hook must also pass when supplied. Keeps the first `count` passing.
 */
export async function generateUnanswerable({ pages, tier, seed, count, candidates = Math.ceil(count * 1.6), maxCalls = Math.ceil(count * 2.5), generatorModel, prices, apiKey, ledgerPath, guard, verifyLocal, verifySearch = null, fetchImpl, createdAt = new Date().toISOString(), log = console.log }) {
  if (typeof verifyLocal !== "function") throw new Error("A local verification hook is required");
  const pending = [], rejected = [];
  let calls = 0;
  for (const page of selectPages(pages, { seed: `${seed}:negative` })) {
    if (pending.length >= candidates || calls >= maxCalls) break;
    calls++;
    const reply = await openRouterJson({ model: generatorModel, messages: unanswerableMessages(page), apiKey, metric: "search-model-eval-dataset-unanswerable", ledgerPath, guard, prices, fetchImpl, scope: { tier, page: pageRef(page) }, maxTokens: GENERATE_MAX_TOKENS, log });
    const question = typeof reply.json?.question === "string" ? reply.json.question.trim() : "";
    const offered = (Array.isArray(reply.json?.keyTerms) ? reply.json.keyTerms : []).filter((term) => typeof term === "string").map((term) => term.trim()).slice(0, 3);
    const keyTerms = offered.filter(distinctiveTerm);
    if (question.length < 12) { rejected.push({ page: sourcePage(page), rejected: "malformed-reply" }); continue; }
    if (!keyTerms.length) { rejected.push({ page: sourcePage(page), question, offered, rejected: "no-distinctive-key-terms" }); continue; }
    if (keyTerms.some((term) => ` ${lexical(page.markdown)} `.includes(` ${lexical(term)} `))) { rejected.push({ page: sourcePage(page), question, rejected: "key-term-on-seed-page" }); continue; }
    pending.push({ id: caseId("neg1", { workspaceId: page.workspaceId, question: normalize(question) }), tier, page, question, keyTerms, droppedTerms: offered.filter((term) => !keyTerms.includes(term)), reply: reply.json });
  }
  const local = await verifyLocal(pending.map((item) => ({ id: item.id, tier: item.tier, terms: item.keyTerms })));
  const accepted = [];
  for (const item of pending) {
    if (accepted.length >= count) { rejected.push({ question: item.question, rejected: "surplus-candidate" }); continue; }
    const localResult = local.get(item.id);
    const searchResult = localResult?.passed && verifySearch ? await verifySearch({ workspaceId: item.page.workspaceId, tier: item.tier, probes: [...item.keyTerms.map((term) => ({ q: term, term, gating: true })), { q: item.question, gating: false }] }) : null;
    const passed = Boolean(localResult?.passed) && (searchResult === null || searchResult.passed);
    const verification = { passed, local: localResult ?? null, search: searchResult, checkedAt: new Date().toISOString() };
    if (!passed) { rejected.push({ page: sourcePage(item.page), question: item.question, rejected: localResult?.passed ? "strong-match-in-search" : "key-term-in-corpus", verification }); continue; }
    accepted.push({
      id: item.id, workspaceTier: tier, workspaceId: item.page.workspaceId, question: item.question, kind: "unanswerable",
      gold: { answerable: false, facts: [], supportMode: "any_of", supportPages: [] },
      provenance: { method: "llm-generated", generatorModel, promptVersion: UNANSWERABLE_PROMPT_VERSION, createdAt, strategy: item.reply.strategy ?? null, rationale: item.reply.rationale ?? null, keyTerms: item.keyTerms, droppedTerms: item.droppedTerms, seedPage: sourcePage(item.page), sourcePages: [], verification },
      splitGroup: `negative:${item.page.workspaceId}:${pageRef(item.page)}`,
    });
  }
  return { accepted, rejected, shortfall: { unanswerable: count - accepted.length } };
}

// ---------------------------------------------------------------- import labeled

export const parseSupportId = (value) => {
  const at = value.lastIndexOf(":page:");
  if (at < 0) throw new Error("Unrecognised support id (expected <sourceDoc>:page:<n>)");
  return { sourceDoc: value.slice(0, at), page: Number(value.slice(at + 6)) };
};

/**
 * Converts large-corpus-recall rows (queries-pages.jsonl: support_groups are
 * OR within a group, AND across groups) into `labeled` cases. Question text
 * comes from the source dataset; gold pages keep sourceDoc + physical page and
 * resolve to production documents through the tier documentMap.
 */
export function importLabeled({ queries, sourceDataset, workspaceId, tier = "large-58k", documentMap = {}, createdAt = new Date().toISOString() }) {
  const sourceQueries = new Map((sourceDataset?.queries ?? []).map((query) => [query.id, query]));
  const datasetSha = sourceDataset?.versionSha256 ?? null;
  const accepted = [], skipped = [];
  for (const row of queries) {
    const query = sourceQueries.get(row.provenance?.query_id ?? row.id);
    if (!query?.question) { skipped.push({ id: row.id, reason: "question-text-missing-from-source-dataset" }); continue; }
    const answerable = row.answerability !== "unanswerable" && query.answerable !== false;
    const supportPages = !answerable ? [] : (row.support_groups ?? []).flatMap((ids, group) => ids.map((id) => {
      const { sourceDoc, page } = parseSupportId(id);
      return { sourceDoc, ...(documentMap[sourceDoc] ? { documentId: documentMap[sourceDoc] } : {}), page, group };
    }));
    if (answerable && !supportPages.length) { skipped.push({ id: row.id, reason: "answerable-without-support" }); continue; }
    const rubric = query.rubric && typeof query.rubric === "object" ? query.rubric : null;
    const sourceFacts = !answerable ? [] : rubric?.requiredFacts?.length ? rubric.requiredFacts : typeof query.expectedAnswer === "string" ? [query.expectedAnswer] : [];
    const groups = new Set(supportPages.map((page) => page.group));
    accepted.push({
      id: `lcr-${row.id}-${hashOf([datasetSha, row.id]).slice(0, 8)}`,
      workspaceTier: tier, workspaceId, question: query.question, kind: "labeled",
      gold: {
        answerable, facts: [], factsStatus: answerable ? "pending-silver" : "not-applicable",
        sourceFacts, supportMode: groups.size > 1 ? "all_of" : "any_of", supportPages,
        ...(rubric?.acceptableAlternatives?.length ? { alternatives: rubric.acceptableAlternatives } : {}),
        ...(rubric?.disqualifiers?.length ? { disqualifiers: rubric.disqualifiers } : {}),
      },
      provenance: {
        method: "import-labeled", source: "large-corpus-recall", originalCaseId: row.id,
        labelStatus: `${row.kind ?? query.labelStatus ?? "unknown"}; provisional`, answerabilityStatus: row.answerability_status ?? null,
        supportSemantics: row.support_semantics ?? null, originalSplit: row.split ?? null, challenges: query.challenges ?? [],
        sourceDatasetSha256: row.provenance?.dataset_sha256 ?? null, sourceDatasetVersionSha256: datasetSha, createdAt,
        sourcePages: supportPages.map((page) => ({ sourceDoc: page.sourceDoc, page: page.page, pageSha256: null })),
      },
      splitGroup: row.query_group ? `lcr:${row.query_group}` : `lcr:${row.id}`,
    });
  }
  return { accepted, skipped };
}

export function silverMessages(question, pages) {
  return [
    { role: "system", content: [
      "You extract gold answer facts for an evaluation dataset. Use ONLY the supplied page text.",
      "Return the short facts (each at most 12 words, copied or tightly paraphrased from the text) that a correct answer to the question must contain.",
      "If the pages do not answer the question, return {\"found\": false}. Reply with JSON only.",
    ].join("\n") },
    { role: "user", content: `Question:\n${question}\n\n${pages.map((page, index) => `Page P${index + 1}:\n<<<\n${clip(page.text, 6_000)}\n>>>`).join("\n\n")}\n\nJSON: {"found": boolean, "facts": string[1..4], "rationale": string}` },
  ];
}

/** Collects the text of the given (sourceDoc, page) pairs from the corpus in one pass. */
export async function loadCorpusPages(corpusPath, wanted) {
  const keys = new Set(wanted.map((page) => `${page.sourceDoc}#${page.page}`));
  const found = new Map();
  await forEachJsonl(corpusPath, (row) => { const key = `${row.sourceDoc}#${row.page}`; if (keys.has(key)) found.set(key, row); });
  return found;
}

/**
 * Silver facts for imported labels: the generator extracts the short answer
 * from the support page text. Facts must be grounded in that text; when they
 * are not found the case falls back to source facts (recorded) or is skipped.
 */
export async function addSilverFacts({ cases, corpus, generatorModel, prices, apiKey, ledgerPath, guard, fetchImpl, maxPages = 6, minGrounding = 0.6, log = console.log }) {
  const accepted = [], skipped = [];
  for (const entry of cases) {
    if (!entry.gold.answerable) { accepted.push(entry); continue; }
    const pages = entry.gold.supportPages.slice(0, maxPages).map((page) => ({ ...page, row: corpus.get(`${page.sourceDoc}#${page.page}`) }));
    const sourcePages = pages.map((page) => ({ sourceDoc: page.sourceDoc, page: page.page, pageSha256: page.row?.pageSha256 ?? null }));
    const texts = pages.filter((page) => page.row?.text).map((page) => ({ text: page.row.text }));
    let facts = [], status = null, silver = null;
    if (texts.length) {
      const reply = await openRouterJson({ model: generatorModel, messages: silverMessages(entry.question, texts), apiKey, metric: "search-model-eval-dataset-silver-facts", ledgerPath, guard, prices, fetchImpl, scope: { caseId: entry.id }, maxTokens: 512, log });
      const offered = reply.json?.found === false ? [] : (Array.isArray(reply.json?.facts) ? reply.json.facts : []).filter((fact) => typeof fact === "string" && fact.trim()).map((fact) => fact.trim());
      const joined = texts.map((page) => page.text).join("\n");
      const grounding = offered.map((fact) => groundingOverlap(fact, joined));
      if (offered.length && grounding.every((value) => value >= minGrounding)) { facts = offered; status = "silver-generator-extracted"; }
      silver = { generatorModel, promptVersion: SILVER_PROMPT_VERSION, found: reply.json?.found ?? null, offered, grounding, rationale: reply.json?.rationale ?? null };
    }
    if (!facts.length && entry.gold.sourceFacts?.length) { facts = entry.gold.sourceFacts; status = "source-labels-fallback"; }
    if (!facts.length) { skipped.push({ id: entry.id, reason: texts.length ? "silver-facts-not-found" : "support-text-missing", silver }); continue; }
    accepted.push({ ...entry, gold: { ...entry.gold, facts, factsStatus: status, silver }, provenance: { ...entry.provenance, sourcePages } });
  }
  return { accepted, skipped };
}

// ---------------------------------------------------------------- dry-run estimate

/** Worst-case generator spend: each allowed call at its prompt size plus max output tokens. */
export function estimateGenerationUsd({ model, prices, calls, avgPromptChars, maxOutputTokens = GENERATE_MAX_TOKENS }) {
  const price = assertModelAllowed(model, prices);
  const perCall = tokenCostUsd(price, Math.ceil(avgPromptChars / 3) + 500, maxOutputTokens);
  return { model, calls, perCallUsd: perCall, worstCaseUsd: perCall * calls, assumptions: "prompt tokens = chars/3 + 500 (system rules), output = max_tokens" };
}

// ---------------------------------------------------------------- CLI

const USAGE = `Usage:
  dataset.mjs tiers --out tiers.json --mid-workspace ID --large-workspace ID [--state ingest/state.json] [--mid-source-doc DOC] [--mid-max-page 4000] [--mid-documents pagecounts.json]
  dataset.mjs generate --pages pages.jsonl --tier mid-5k|large-58k --tiers tiers.json --out cases.jsonl [--single N] [--multi N] [--max-single-calls N] [--max-multi-calls N] [--seed S] [--generator-model ID] [--cap-usd 1] [--api-key-env OPENROUTER_API_KEY] [--dry-run]
  dataset.mjs unanswerable --pages pages.jsonl --tier T --tiers tiers.json --corpus pages-text.jsonl --out cases.jsonl --count N [--candidates N] [--max-calls N] [--search-base URL --credentials FILE] [--dry-run]
  dataset.mjs import-labeled --queries queries-pages.jsonl (--source-dataset dataset.json | --questions questions.jsonl) --corpus pages-text.jsonl --tiers tiers.json --out cases.jsonl [--tier large-58k] [--no-silver] [--dry-run]
  dataset.mjs freeze --cases a.jsonl[,b.jsonl] --out-dir DIR --seed S --tiers tiers.json [--test-fraction 0.7] [--previous old/dataset.json]
  dataset.mjs validate DIR/dataset.json`;

function writeCandidates(out, { accepted, rejected = [], skipped = [], shortfall = null }) {
  writeFileSync(out, accepted.map((entry) => JSON.stringify(entry)).join("\n") + (accepted.length ? "\n" : ""), { flag: "wx" });
  if (rejected.length || skipped.length) writeFileSync(`${out}.rejected.jsonl`, `${[...rejected, ...skipped].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
  console.log(JSON.stringify({ accepted: accepted.length, rejected: rejected.length, skipped: skipped.length, shortfall, out }));
}

function generatorSetup(options) {
  const generatorModel = options["generator-model"] ?? DEFAULT_GENERATOR_MODEL;
  const prices = loadPrices(options.prices);
  assertModelAllowed(generatorModel, prices);
  if (!options.out) throw new Error("--out cases.jsonl required");
  const out = resolve(options.out);
  const ledgerPath = options.ledger ?? `${out}.spend.jsonl`;
  const guard = options["dry-run"] ? null : new BudgetGuard({ capUsd: Number(options["cap-usd"] ?? 1), logPath: `${out}.guard.jsonl` });
  return { generatorModel, prices, out, ledgerPath, guard };
}

function loadTierPages(options) {
  const tiers = options.tiers ? readJson(options.tiers) : {};
  const tier = options.tier;
  if (!TIERS.includes(tier)) throw new Error(USAGE);
  const workspaceId = options["workspace-id"] ?? tiers[tier]?.workspaceId ?? null;
  if (!workspaceId) throw new Error(`No workspace for ${tier}: pass --tiers or --workspace-id`);
  const pages = readJsonl(options.pages).map((row) => normalizePage(row, { tier, workspaceId })).filter((page) => page.tier === tier);
  return { tiers, tier, workspaceId, pages };
}

const avgChars = (items, pick) => (items.length ? items.reduce((total, item) => total + Math.min(pick(item), MAX_PAGE_CHARS), 0) / items.length : 0);

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseArgs(rest, { booleans: ["no-silver", "dry-run"] });
  const createdAt = new Date().toISOString();
  const seed = options.seed ?? "search-model-eval-v1";
  if (command === "tiers") {
    if (!options.out || !options["mid-workspace"] || !options["large-workspace"]) throw new Error(USAGE);
    const tiers = tiersFromState({ state: options.state ? readJson(options.state) : null, mid: { workspaceId: options["mid-workspace"], sourceDocs: options["mid-source-doc"] ? options["mid-source-doc"].split(",") : null, maxPage: options["mid-max-page"] ? Number(options["mid-max-page"]) : null, documents: options["mid-documents"] ? readJson(options["mid-documents"]) : null }, large: { workspaceId: options["large-workspace"] } });
    writeJsonExclusive(resolve(options.out), tiers);
    console.log(JSON.stringify({ tiers: Object.keys(tiers), largeMappedDocuments: Object.keys(tiers["large-58k"].documentMap).length }));
  } else if (command === "generate") {
    if (!options.pages) throw new Error(USAGE);
    const setup = generatorSetup(options);
    const { tier, pages } = loadTierPages(options);
    const single = Number(options.single ?? 0), multi = Number(options.multi ?? 0);
    const maxSingleCalls = Number(options["max-single-calls"] ?? defaultMaxCalls(single)), maxMultiCalls = Number(options["max-multi-calls"] ?? defaultMaxCalls(multi));
    if (options["dry-run"]) {
      const chars = avgChars(pages, (page) => page.markdown.length);
      console.log(JSON.stringify({ tier, pages: pages.length, single, multi, singleHop: estimateGenerationUsd({ model: setup.generatorModel, prices: setup.prices, calls: maxSingleCalls, avgPromptChars: chars + 900 }), multiHop: estimateGenerationUsd({ model: setup.generatorModel, prices: setup.prices, calls: maxMultiCalls, avgPromptChars: 2 * chars + 1100 }) }, null, 2));
      return 0;
    }
    let neighbours = null;
    if (options.corpus) {
      const wanted = pages.flatMap((page) => [-3, -2, -1, 1, 2, 3].map((offset) => ({ sourceDoc: page.sourceDoc, page: page.page + offset })));
      const scope = (options.tiers ? readJson(options.tiers) : {})[tier]?.scope ?? {};
      neighbours = new Map();
      for (const [key, row] of await loadCorpusPages(options.corpus, wanted)) {
        if (scope.maxPage && row.page > scope.maxPage) continue;
        neighbours.set(key, normalizePage({ ...row, markdown: row.text }, { tier, workspaceId: pages[0]?.workspaceId }));
      }
    }
    writeCandidates(setup.out, await generateCases({ pages, neighbours, tier, seed, single, multi, maxSingleCalls, maxMultiCalls, apiKey: process.env[options["api-key-env"] ?? "OPENROUTER_API_KEY"], createdAt, ...setup }));
    console.log(JSON.stringify({ guard: setup.guard.state() }));
  } else if (command === "unanswerable") {
    if (!options.pages || !options.corpus) throw new Error(USAGE);
    const setup = generatorSetup(options);
    const { tiers, tier, pages } = loadTierPages(options);
    const count = Number(options.count ?? 0);
    const candidates = Number(options.candidates ?? Math.ceil(count * 1.6)), maxCalls = Number(options["max-calls"] ?? Math.ceil(count * 2.5));
    if (options["dry-run"]) {
      console.log(JSON.stringify({ tier, pages: pages.length, count, candidates, scope: tiers[tier]?.scope ?? null, estimate: estimateGenerationUsd({ model: setup.generatorModel, prices: setup.prices, calls: maxCalls, avgPromptChars: avgChars(pages, (page) => page.markdown.length) + 900 }), searchVerification: options["search-base"] ? "enabled (retrieval cost reported by the server)" : "disabled" }, null, 2));
      return 0;
    }
    if (!tiers[tier]?.scope) throw new Error(`tiers.${tier}.scope required for local absence verification`);
    const verifyLocal = createLocalVerifier({ corpusPath: options.corpus, scopes: tiers });
    const verifySearch = options["search-base"] ? createSearchVerifier({ baseUrl: options["search-base"], apiKeyForTier: apiKeyResolver({ credentialsPath: options.credentials }), strongRelevance: Number(options["strong-relevance"] ?? 0.9), ledgerPath: setup.ledgerPath }) : null;
    writeCandidates(setup.out, await generateUnanswerable({ pages, tier, seed, count, candidates, maxCalls, apiKey: process.env[options["api-key-env"] ?? "OPENROUTER_API_KEY"], verifyLocal, verifySearch, createdAt, ...setup }));
    console.log(JSON.stringify({ guard: setup.guard.state() }));
  } else if (command === "import-labeled") {
    for (const key of ["queries", "out"]) if (!options[key]) throw new Error(USAGE);
    if (!options["source-dataset"] === !options.questions) throw new Error("import-labeled needs exactly one of --source-dataset or --questions");
    const tier = options.tier ?? "large-58k";
    const tiers = options.tiers ? readJson(options.tiers) : {};
    const workspaceId = options["workspace-id"] ?? tiers[tier]?.workspaceId;
    if (!workspaceId) throw new Error("workspace required: --tiers or --workspace-id");
    const queries = readJsonl(options.queries);
    let sourceDataset;
    if (options.questions) {
      // Recovered question text ({id, question} JSONL) when the original dataset.json is gone; its hash is recorded instead.
      const questionBytes = readFileSync(options.questions);
      sourceDataset = { versionSha256: `questions:${sha256(questionBytes)}`, queries: readJsonl(options.questions).map((row) => ({ id: row.id, question: row.question })) };
    } else {
      const sourceBytes = readFileSync(options["source-dataset"]);
      const expected = new Set(queries.map((row) => row.provenance?.dataset_sha256).filter(Boolean));
      if (expected.size && !expected.has(sha256(sourceBytes))) throw new Error("Source dataset sha256 differs from the hash recorded in the queries' provenance");
      sourceDataset = JSON.parse(sourceBytes);
    }
    const imported = importLabeled({ queries, sourceDataset, workspaceId, tier, documentMap: tiers[tier]?.documentMap ?? {}, createdAt });
    const setup = generatorSetup(options);
    if (options["dry-run"]) {
      console.log(JSON.stringify({ tier, imported: imported.accepted.length, skipped: imported.skipped, silver: options["no-silver"] ? "disabled" : estimateGenerationUsd({ model: setup.generatorModel, prices: setup.prices, calls: imported.accepted.filter((entry) => entry.gold.answerable).length, avgPromptChars: 6 * 6_000 + 600, maxOutputTokens: 512 }) }, null, 2));
      return 0;
    }
    if (options["no-silver"]) {
      const accepted = imported.accepted.map((entry) => (entry.gold.answerable ? { ...entry, gold: { ...entry.gold, facts: entry.gold.sourceFacts, factsStatus: "source-labels" } } : entry)).filter((entry) => !entry.gold.answerable || entry.gold.facts.length);
      writeCandidates(setup.out, { accepted, skipped: imported.skipped });
    } else {
      if (!options.corpus) throw new Error("--corpus pages-text.jsonl required for silver facts");
      const corpus = await loadCorpusPages(options.corpus, imported.accepted.flatMap((entry) => entry.gold.supportPages));
      const silver = await addSilverFacts({ cases: imported.accepted, corpus, apiKey: process.env[options["api-key-env"] ?? "OPENROUTER_API_KEY"], ...setup });
      writeCandidates(setup.out, { accepted: silver.accepted, skipped: [...imported.skipped, ...silver.skipped] });
      console.log(JSON.stringify({ guard: setup.guard.state() }));
    }
  } else if (command === "freeze") {
    if (!options.cases || !options["out-dir"] || !options.seed) throw new Error(USAGE);
    const candidates = options.cases.split(",").flatMap((path) => readJsonl(path));
    const { report } = freezeDataset({ candidates, outputDir: resolve(options["out-dir"]), seed: options.seed, testFraction: Number(options["test-fraction"] ?? 0.7), previous: options.previous ? readJson(options.previous) : null, tiers: options.tiers ? readJson(options.tiers) : null, createdAt, description: options.description ?? "" });
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
