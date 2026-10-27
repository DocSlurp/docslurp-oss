#!/usr/bin/env -S pnpm exec tsx
/**
 * Calibrates the chat scope-decline threshold (DEFAULT_SCOPE_DECLINE_THRESHOLD)
 * on the calibrated vector signal: bge-m3 cosine run through the same local
 * transformers.js pipeline the noise baseline was measured with
 * (search/relevance.ts, `transformers.js/Xenova/bge-m3`), rescaled above that
 * baseline. Top-k only: a question's score is its best cosine among the top-k
 * passages of its corpus, which is what a vector search returns.
 *
 * Inputs:
 * - --traces <dir>: recorded production /v1/search traces (the retrieval-quality
 *   evidence root). Their passages form the corpus; each traced question is an
 *   on-topic positive.
 * - --queries <file>: authored probes (scope-decline-queries-v2.json), by class.
 *
 * Every question goes through the shipped decision (decideScopeDecline), so
 * classes the decision never judges (follow-ups, CJK and Thai) count as
 * answered. Labels are self-assigned by the author of the probes.
 *
 * Usage: pnpm exec tsx scripts/retrieval-quality/scope-decline-calibrate.mts --traces <dir> --queries <file> [--k 8]
 *        pnpm exec tsx scripts/retrieval-quality/scope-decline-calibrate.mts --from <earlier output.json>
 *        (re-judges saved scores with the current decision rules, without re-embedding)
 * Local CPU only: no network, no paid calls (the model is read from ~/.cache).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { embedConfiguredText } from "../../server/src/lib/ai.ts";
import { decideScopeDecline, type ScopeSignal } from "../../server/src/search/scope-relevance.ts";

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

type Passage = { text: string; corpus: string };

function readTraces(dir: string): { questions: Array<{ query: string; corpus: string }>; passages: Passage[] } {
  const questions = new Map<string, string>();
  const passages = new Map<string, Passage>();
  for (const file of walk(dir)) {
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
      for (const result of body.results) if (result.text) passages.set(result.text, { text: result.text, corpus });
    }
  }
  return { questions: [...questions].map(([query, corpus]) => ({ query, corpus })), passages: [...passages.values()] };
}

const BASELINE = 0.65; // NOISE_BASELINES["transformers.js/Xenova/bge-m3"]
const PIPELINE = "transformers.js/Xenova/bge-m3";
const k = Number(arg("--k", "8"));

async function embed(text: string): Promise<number[]> {
  const { embedding } = await embedConfiguredText({ value: text.slice(0, 2_000), runtime: "local", provider: "transformers.js", model: "Xenova/bge-m3", normalize: true, privacyMode: "standard" });
  return embedding;
}
const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index]!, 0);

type Probe = { class: string; label: "related" | "unrelated"; query: string; history?: boolean; corpus?: "all" | "tiny" };
type Row = { class: string; label: "related" | "unrelated"; query: string; cosine: number; relevance: number; history?: boolean; skipped?: string };
const rows: Row[] = [];
function judgeRow(row: Omit<Row, "skipped">) {
  const signal: ScopeSignal = { name: "vector", pipeline: PIPELINE, topCosine: row.cosine, relevance: row.relevance };
  const decision = decideScopeDecline({ query: row.query, signal, evidenceCount: 1, threshold: 1, historyTurns: row.history ? 2 : 0, searchConfigured: false, webTools: false, filtered: false });
  rows.push({ ...row, ...(decision.skipped ? { skipped: decision.skipped } : {}) });
}
let meta: { passages: number; tinyCorpusPassages: number };
const from = process.argv.includes("--from") ? arg("--from") : null;
if (from) {
  const saved = JSON.parse(readFileSync(from, "utf8")) as { passages: number; tinyCorpusPassages: number; rows: Row[] };
  meta = { passages: saved.passages, tinyCorpusPassages: saved.tinyCorpusPassages };
  const probes = (JSON.parse(readFileSync(arg("--queries", "docs/evals/retrieval-quality/scope-decline-queries-v2.json"), "utf8")) as { probes: Probe[] }).probes;
  const history = new Set(probes.filter(probe => probe.history).map(probe => probe.query));
  for (const { skipped: _skipped, ...row } of saved.rows) judgeRow({ ...row, history: row.history ?? history.has(row.query) });
} else {
  const { questions, passages } = readTraces(arg("--traces"));
  const probes = (JSON.parse(readFileSync(arg("--queries"), "utf8")) as { probes: Probe[] }).probes;
  const corpora = [...new Set(passages.map(passage => passage.corpus))];
  // Tiny corpus: the three shortest passages of the smaller workspace.
  const smaller = corpora.sort((a, b) => passages.filter(p => p.corpus === a).length - passages.filter(p => p.corpus === b).length)[0]!;
  const tiny = passages.filter(p => p.corpus === smaller).sort((a, b) => a.text.length - b.text.length).slice(0, 3);
  meta = { passages: passages.length, tinyCorpusPassages: tiny.length };
  console.error(`embedding ${passages.length} passages and ${questions.length + probes.length} questions with ${PIPELINE} (local CPU)…`);
  const vectors = new Map<string, number[]>();
  for (const passage of passages) vectors.set(passage.text, await embed(passage.text));
  const score = async (query: string, pool: Passage[]) => {
    const q = await embed(query);
    return pool.map(passage => dot(q, vectors.get(passage.text)!)).sort((a, b) => b - a).slice(0, k)[0] ?? 0;
  };
  const measure = async (probe: Probe, pool: Passage[]) => {
    const cosine = await score(probe.query, pool);
    const relevance = Math.max(0, Math.min(1, (cosine - BASELINE) / (1 - BASELINE)));
    judgeRow({ class: probe.class, label: probe.label, query: probe.query, cosine: +cosine.toFixed(4), relevance: +relevance.toFixed(4), ...(probe.history ? { history: true } : {}) });
  };
  for (const question of questions) await measure({ class: "on-topic-traced", label: "related", query: question.query }, passages.filter(p => p.corpus === question.corpus));
  for (const probe of probes) await measure(probe, probe.corpus === "tiny" ? tiny : passages);
}

const declinedAt = (row: Row, threshold: number) => !row.skipped && row.relevance < threshold;
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
console.log(JSON.stringify({ pipeline: PIPELINE, baseline: BASELINE, k, ...meta, table, rows }, null, 2));
