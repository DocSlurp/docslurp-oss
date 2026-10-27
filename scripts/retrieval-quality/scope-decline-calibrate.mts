#!/usr/bin/env -S pnpm exec tsx
/**
 * Calibrates the chat quick-decline threshold (DEFAULT_SCOPE_DECLINE_THRESHOLD)
 * through the search pipeline's own functions, so it sees the population the
 * shortcut judges in production:
 *
 * 1. Vector branch: the top 20 passages by bge-m3 cosine, from the same local
 *    transformers.js pipeline the noise baseline was measured with, reported in
 *    the vector adapter's `1 / (1 + squaredL2)` score space.
 * 2. Lexical branch, emulating the full-text adapter: rows containing every
 *    content term (strict match), else the OR backoff (rows with any term,
 *    marked `lexicalMatch: "partial"`), top 20 by term coverage.
 * 3. The shipped annotateEvidenceRelevance, reciprocal rank fusion with the best
 *    branch relevance, applyRelevanceFloor at the default 0.1, and the top 8
 *    (chat's default resultCount) as the returned evidence.
 * 4. The shipped vectorScopeSignal and decideScopeDecline with the real evidence
 *    count and the keyword-evidence flag.
 *
 * Limits: the lexical branch is an emulation (Postgres `english` stemming and
 * ts_rank differ from termCoverage), graph and page-locator branches are absent,
 * and labels are self-assigned by the author of the probes.
 *
 * Usage: pnpm exec tsx scripts/retrieval-quality/scope-decline-calibrate.mts --traces <dir> --queries <file> [--cache <embeddings.json>]
 * Local CPU only: no network, no paid calls (the model is read from ~/.cache).
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { embedConfiguredText } from "../../server/src/lib/ai.ts";
import { annotateEvidenceRelevance, applyRelevanceFloor, contentTerms, DEFAULT_MIN_SCORE, termCoverage, withBestRelevance } from "../../server/src/search/relevance.ts";
import { reciprocalRankFusion } from "../../server/src/search/rrf.ts";
import { decideScopeDecline, scopeEvidenceKey, vectorScopeSignal } from "../../server/src/search/scope-relevance.ts";
import type { EvidenceRetrievalResult } from "../../server/src/search/retrieval-adapters.ts";
import type { SearchChunk } from "../../server/src/services/search.ts";

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : name.endsWith(".json") ? [path] : [];
  });
}

type Passage = { id: string; text: string; corpus: string };

function readTraces(dir: string): { questions: Array<{ query: string; corpus: string }>; passages: Passage[] } {
  const questions = new Map<string, string>();
  const passages = new Map<string, Passage>();
  for (const file of walk(dir)) {
    if (file.includes("scope-decline-")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const record = item as { request?: { url?: string }; body?: unknown; raw?: unknown };
      if (!record?.request?.url) continue;
      let body = record.body as { results?: Array<{ text?: string }> } | undefined;
      if (!body && typeof record.raw === "string" && record.raw.startsWith("{")) {
        try { body = JSON.parse(record.raw); } catch { body = undefined; }
      }
      if (!body?.results) continue;
      const url = new URL(record.request.url);
      const query = url.searchParams.get("q");
      const corpus = url.searchParams.get("workspaceId") ?? "unknown";
      if (query) questions.set(query, corpus);
      for (const result of body.results) if (result.text && !passages.has(result.text)) passages.set(result.text, { id: `p${passages.size}`, text: result.text, corpus });
    }
  }
  return { questions: [...questions].map(([query, corpus]) => ({ query, corpus })), passages: [...passages.values()] };
}

const PIPELINE = "transformers.js/Xenova/bge-m3";
const BRANCH_DEPTH = 20;
const RESULT_COUNT = 8;

async function embed(text: string): Promise<number[]> {
  const { embedding } = await embedConfiguredText({ value: text.slice(0, 2_000), runtime: "local", provider: "transformers.js", model: "Xenova/bge-m3", normalize: true, privacyMode: "standard" });
  return embedding;
}
const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);

type Probe = { class: string; label: "related" | "unrelated"; query: string; history?: boolean; corpus?: "all" | "tiny" };
const { questions, passages } = readTraces(arg("--traces"));
const probes = (JSON.parse(readFileSync(arg("--queries"), "utf8")) as { probes: Probe[] }).probes;
const corpora = [...new Set(passages.map(passage => passage.corpus))];
const smaller = [...corpora].sort((a, b) => passages.filter(p => p.corpus === a).length - passages.filter(p => p.corpus === b).length)[0]!;
const tiny = passages.filter(p => p.corpus === smaller).sort((a, b) => a.text.length - b.text.length).slice(0, 3);

const cachePath = process.argv.includes("--cache") ? arg("--cache") : null;
const cache: Record<string, number[]> = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
async function vectorOf(text: string): Promise<number[]> {
  cache[text] ??= await embed(text);
  return cache[text]!;
}
console.error(`embedding up to ${passages.length} passages and ${questions.length + probes.length} questions with ${PIPELINE} (local CPU; ${Object.keys(cache).length} cached)…`);
for (const passage of passages) await vectorOf(passage.text);

function chunkOf(passage: Passage, score: number, extra: Partial<SearchChunk> = {}): SearchChunk {
  const index = Number(passage.id.slice(1));
  return { id: passage.id, documentId: passage.corpus, runId: "r", chunkIndex: index, text: passage.text, headingPath: [], pageNumber: null, tokenEstimate: 0, score, filename: "", pageNumbers: [], blockIds: [], ...extra } as SearchChunk;
}

type Row = { class: string; label: "related" | "unrelated"; query: string; relevance: number | null; evidence: number; keywordEvidence: boolean; skipped?: string };
const rows: Row[] = [];
async function measure(probe: Probe, pool: Passage[]) {
  const q = await vectorOf(probe.query);
  const vector = pool.map(passage => ({ passage, cos: dot(q, cache[passage.text]!) })).sort((a, b) => b.cos - a.cos).slice(0, BRANCH_DEPTH)
    .map(({ passage, cos }) => chunkOf(passage, 1 / (1 + (2 - 2 * cos))));
  const terms = contentTerms(probe.query).join(" ");
  const coverage = pool.map(passage => ({ passage, coverage: terms ? termCoverage(terms, passage.text) : 0 }));
  const strict = coverage.filter(entry => entry.coverage === 1);
  const lexical = (strict.length ? strict.map(entry => chunkOf(entry.passage, 1))
    : coverage.filter(entry => entry.coverage > 0).sort((a, b) => b.coverage - a.coverage).map(entry => chunkOf(entry.passage, entry.coverage, { lexicalMatch: "partial" })))
    .slice(0, BRANCH_DEPTH);
  const evidence: EvidenceRetrievalResult[] = [{ adapter: "vector", chunks: vector }, { adapter: "lexical", chunks: lexical }];
  const lists = annotateEvidenceRelevance(evidence, { query: probe.query, embeddingPipeline: PIPELINE });
  const fused = withBestRelevance(reciprocalRankFusion(lists) ?? [], lists);
  const returned = applyRelevanceFloor(fused, DEFAULT_MIN_SCORE).kept.slice(0, RESULT_COUNT);
  const strong = new Set(annotateEvidenceRelevance([evidence[1]!], { query: probe.query, embeddingPipeline: PIPELINE })
    .flat().filter(chunk => (chunk.relevance ?? 1) > 0 && (chunk.relevance ?? 1) >= DEFAULT_MIN_SCORE).map(chunk => scopeEvidenceKey(chunk)));
  const base = vectorScopeSignal(evidence, PIPELINE);
  const signal = base ? { ...base, nonVectorEvidence: returned.some(chunk => strong.has(scopeEvidenceKey(chunk))) } : null;
  const decision = decideScopeDecline({ query: probe.query, signal, evidenceCount: returned.length, threshold: 1, historyTurns: probe.history ? 2 : 0, searchConfigured: false, webTools: false, filtered: false });
  rows.push({ class: probe.class, label: probe.label, query: probe.query, relevance: signal?.relevance === null || signal?.relevance === undefined ? null : +signal.relevance.toFixed(4),
    evidence: returned.length, keywordEvidence: Boolean(signal?.nonVectorEvidence), ...(decision.skipped ? { skipped: decision.skipped } : {}) });
}
for (const question of questions) await measure({ class: "on-topic-traced", label: "related", query: question.query }, passages.filter(p => p.corpus === question.corpus));
for (const probe of probes) await measure(probe, probe.corpus === "tiny" ? tiny : passages);
if (cachePath) writeFileSync(cachePath, JSON.stringify(cache));

const declinedAt = (row: Row, threshold: number) => !row.skipped && row.relevance !== null && row.relevance < threshold;
const thresholds = [0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3];
const classes = [...new Set(rows.map(row => row.class))];
const table = thresholds.map(threshold => {
  const declined = rows.filter(row => declinedAt(row, threshold));
  const unrelated = rows.filter(row => row.label === "unrelated");
  const tp = declined.filter(row => row.label === "unrelated").length;
  return {
    threshold,
    precision: declined.length ? +(tp / declined.length).toFixed(3) : null,
    recall: unrelated.length ? +(tp / unrelated.length).toFixed(3) : null,
    falseDeclines: declined.length - tp,
    byClass: Object.fromEntries(classes.flatMap(name => (["related", "unrelated"] as const).map(label => {
      const members = rows.filter(row => row.class === name && row.label === label);
      return members.length ? [`${name}:${label}`, `${members.filter(row => declinedAt(row, threshold)).length}/${members.length} declined`] : null;
    }).filter((entry): entry is [string, string] => entry !== null))),
  };
});
const skips = rows.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row.skipped ?? "judged"]: (counts[row.skipped ?? "judged"] ?? 0) + 1 }), {});
console.log(JSON.stringify({ pipeline: PIPELINE, floor: DEFAULT_MIN_SCORE, branchDepth: BRANCH_DEPTH, resultCount: RESULT_COUNT, passages: passages.length, tinyCorpusPassages: tiny.length, skips, table, rows }, null, 2));
