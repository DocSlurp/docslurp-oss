#!/usr/bin/env -S pnpm exec tsx
/**
 * Calibrates the chat scope-decline threshold (DEFAULT_SCOPE_DECLINE_THRESHOLD).
 *
 * Inputs:
 * - --traces <dir>: recorded production /v1/search traces (the retrieval-quality
 *   evidence root). Each trace's question and its top results are an on-topic
 *   positive scored on the results it actually retrieved.
 * - --queries <file>: authored probes (docs/evals/retrieval-quality/scope-decline-queries-v1.json).
 *   Paraphrased on-topic questions and off-topic questions are scored against the
 *   pool of every passage in the traces. The pool is a superset of any top-k, so
 *   off-topic scores are an upper bound (conservative for the decline's recall).
 *
 * Output: JSON with each question's score and precision/recall of the
 * "unrelated" (decline) decision per threshold. Makes no network calls.
 *
 * Usage: pnpm exec tsx scripts/retrieval-quality/scope-decline-calibrate.mts --traces <dir> --queries <file>
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { decideScopeDecline, scopeRelevance, type ScopeEvidence } from "../../server/src/search/scope-relevance.ts";

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : name.endsWith(".json") ? [path] : [];
  });
}

type Trace = { query: string; results: ScopeEvidence[] };

function readTraces(dir: string): Trace[] {
  const byQuery = new Map<string, ScopeEvidence[]>();
  for (const file of walk(dir)) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const record = item as { request?: { url?: string }; body?: unknown; raw?: unknown };
      if (!record?.request?.url) continue;
      let body = record.body as { results?: Array<{ text?: string; citation?: { headingPath?: string[]; filename?: string } }> } | undefined;
      if (!body && typeof record.raw === "string" && record.raw.startsWith("{")) {
        try { body = JSON.parse(record.raw); } catch { body = undefined; }
      }
      if (!body?.results) continue;
      const query = new URL(record.request.url).searchParams.get("q");
      if (!query) continue;
      // The first ten results, as chat retrieves at most its resultCount (8 by default).
      const results = body.results.slice(0, 10).map(result => ({
        text: result.text ?? "", headingPath: result.citation?.headingPath ?? [], filename: result.citation?.filename ?? "",
      }));
      if (!byQuery.has(query) || (byQuery.get(query)!.length < results.length)) byQuery.set(query, results);
    }
  }
  return [...byQuery].map(([query, results]) => ({ query, results }));
}

const traces = readTraces(arg("--traces"));
const probes = JSON.parse(readFileSync(arg("--queries"), "utf8")) as { onTopicParaphrases: string[]; offTopic: string[]; offTopicNearDomain: string[] };
const pool = [...new Map(traces.flatMap(trace => trace.results).map(passage => [passage.text, passage])).values()];

type Scored = { group: "on-topic-traced" | "on-topic-paraphrase" | "off-topic" | "off-topic-near-domain"; query: string; score: number | null; skipped?: string };
/** The shipped decision (decideScopeDecline) at threshold 1 reports why a question is never judged; otherwise its score. */
function score(group: Scored["group"], query: string, evidence: ScopeEvidence[]): Scored {
  const decision = decideScopeDecline({ query, evidence, threshold: 1, historyTurns: 0 });
  return { group, query, score: decision.skipped ? null : scopeRelevance(query, evidence).score, ...(decision.skipped ? { skipped: decision.skipped } : {}) };
}
const scored: Scored[] = [
  ...traces.map(trace => score("on-topic-traced", trace.query, trace.results)),
  ...probes.onTopicParaphrases.map(query => score("on-topic-paraphrase", query, pool)),
  ...probes.offTopic.map(query => score("off-topic", query, pool)),
  ...probes.offTopicNearDomain.map(query => score("off-topic-near-domain", query, pool)),
];

// Never-judged questions are never declined: they count as answered (a miss when off-topic).
const judged = scored.map(item => item.score === null ? { ...item, score: 1 } : item);
const isUnrelated = (item: Scored) => item.group.startsWith("off-topic");
const thresholds = [0.1, 0.15, 0.2, 0.25, 0.3, 0.34, 0.4, 0.45, 0.5, 0.6];
const table = thresholds.map(threshold => {
  const declined = judged.filter(item => (item.score ?? 1) < threshold);
  const truePositives = declined.filter(isUnrelated).length;
  const unrelated = judged.filter(isUnrelated).length;
  const related = judged.length - unrelated;
  return {
    threshold,
    declined: declined.length,
    precision: declined.length ? +(truePositives / declined.length).toFixed(3) : null,
    recall: unrelated ? +(truePositives / unrelated).toFixed(3) : null,
    falseDeclines: declined.length - truePositives,
    falseDeclineRate: related ? +((declined.length - truePositives) / related).toFixed(3) : null,
    byGroup: Object.fromEntries((["on-topic-traced", "on-topic-paraphrase", "off-topic", "off-topic-near-domain"] as const).map(group => {
      const members = judged.filter(item => item.group === group);
      return [group, `${members.filter(item => (item.score ?? 1) < threshold).length}/${members.length} declined`];
    })),
  };
});

console.log(JSON.stringify({
  traces: traces.length, poolPassages: pool.length,
  unjudged: scored.filter(item => item.score === null).map(item => ({ group: item.group, skipped: item.skipped, query: item.query })),
  table,
  scores: scored.map(item => ({ group: item.group, score: item.score === null ? null : +item.score.toFixed(3), query: item.query })),
}, null, 2));
