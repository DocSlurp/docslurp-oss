#!/usr/bin/env node
// Correlates app-side `lancedb.s3.*` proxy spans with `lancedb.search` adapter spans from a storage burn.
// Usage: node scripts/analyze-lancedb-search-reads.mjs <spans.jsonl[.gz]> [more files...]
// Input rows: {name, svc, start (epoch ms), ms, op, bytes, status}. Object keys are not present in slim exports,
// so reads are grouped by operation and response size; see docs/evals/lancedb-search-read-breakdown-2026-10.md.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const SLACK_MS = 5;
const SIZE_CLASSES = [["<=512B", 512], ["<=8KiB", 8192], ["<=64KiB", 65536], ["<=1MiB", 1048576], [">1MiB", Infinity]];
const quantile = (values, q) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const sizeClass = (bytes) => SIZE_CLASSES.find(([, max]) => bytes <= max)[0];
const fmt = (v, d = 0) => (v === null || v === undefined ? "n/a" : v.toFixed(d));

function load(path) {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString() : raw.toString();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Union length of [start, end) intervals: wall time during which at least one storage request was in flight. */
function unionMs(intervals) {
  let total = 0, curStart = -Infinity, curEnd = -Infinity;
  for (const [s, e] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (s > curEnd) { if (curEnd > curStart) total += curEnd - curStart; curStart = s; curEnd = e; } else curEnd = Math.max(curEnd, e);
  }
  return total + (curEnd > curStart ? curEnd - curStart : 0);
}

/** Serial rounds: a request starts a new round when it begins after every earlier request has finished. */
function rounds(intervals) {
  let count = 0, end = -Infinity;
  for (const [s, e] of [...intervals].sort((a, b) => a[0] - b[0])) { if (s >= end) count++; end = Math.max(end, e); }
  return count;
}

export function analyze(rows) {
  const app = rows.filter((r) => r.svc?.endsWith("-app"));
  const worker = rows.filter((r) => r.svc?.endsWith("-worker"));
  const s3 = app.filter((r) => r.name.startsWith("lancedb.s3.")).sort((a, b) => a.start - b.start);
  const searches = app.filter((r) => r.name === "lancedb.search").sort((a, b) => a.start - b.start);
  const writes = worker.filter((r) => /^lancedb\.s3\.(PutObject|UploadPart|CompleteMultipartUpload|CopyObject)$/.test(r.name)).map((r) => r.start).sort((a, b) => a - b);
  const writeNear = (t) => { // any worker Lance write within +-5 s
    let lo = 0, hi = writes.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (writes[mid] < t - 5000) lo = mid + 1; else hi = mid; }
    return lo < writes.length && writes[lo] <= t + 5000;
  };
  const overlaps = (s) => searches.some((o) => o !== s && o.start < s.start + s.ms + SLACK_MS && o.start + o.ms > s.start - SLACK_MS);
  const isolated = searches.filter((s) => !overlaps(s));
  let pointer = 0;
  const per = [];
  for (const s of isolated) {
    while (pointer < s3.length && s3[pointer].start < s.start - SLACK_MS - 2000) pointer++;
    const mine = [];
    for (let i = pointer; i < s3.length && s3[i].start <= s.start + s.ms + SLACK_MS; i++) if (s3[i].start >= s.start - SLACK_MS) mine.push(s3[i]);
    const intervals = mine.map((r) => [r.start, r.start + r.ms]);
    per.push({ search: s, reads: mine, storageMs: unionMs(intervals), rounds: rounds(intervals), underIngest: writeNear(s.start) });
  }
  return { app, worker, s3, searches, isolated, per };
}

function groupStats(per, keyOf) {
  const counts = new Map(); // key -> {n per search list, ms list}
  for (const p of per) {
    const seen = new Map();
    for (const r of p.reads) { const k = keyOf(r); seen.set(k, (seen.get(k) ?? 0) + 1); const e = counts.get(k) ?? { perSearch: [], ms: [], bytes: 0, searchesWith: 0 }; e.ms.push(r.ms); e.bytes += r.bytes ?? 0; counts.set(k, e); }
    for (const [k, n] of seen) { const e = counts.get(k); e.perSearch.push(n); e.searchesWith++; }
  }
  return [...counts].map(([k, e]) => ({ class: k, requestsPerSearch: e.ms.length / per.length, searchesWithPct: 100 * e.searchesWith / per.length, p50: quantile(e.ms, .5), p95: quantile(e.ms, .95), meanMs: e.ms.reduce((a, b) => a + b, 0) / e.ms.length, mbPerSearch: e.bytes / 1e6 / per.length }))
    .sort((a, b) => b.requestsPerSearch - a.requestsPerSearch);
}

/** Sum of per-round wall time, where a round is a run of overlapping requests (the serial critical path). */
function roundSum(reads) {
  let total = 0, start = -Infinity, end = -Infinity;
  for (const r of [...reads].sort((a, b) => a.start - b.start)) {
    if (r.start >= end) { if (end > start) total += end - start; start = r.start; end = r.start + r.ms; } else end = Math.max(end, r.start + r.ms);
  }
  return total + (end > start ? end - start : 0);
}

/**
 * Upper-bound savings if a class of requests were removed from the critical path.
 * `repeat` marks a GET whose exact response size was already seen in an earlier search within REPEAT_WINDOW_MS
 * (a proxy for "same byte range of an immutable file": keys are absent from slim exports).
 */
const REPEAT_WINDOW_MS = 600_000;
export function scenarios(per) {
  const lastSeen = new Map();
  const marked = [];
  for (const p of [...per].sort((a, b) => a.search.start - b.search.start)) {
    const fresh = new Map();
    const reads = p.reads.map((r) => {
      const t = lastSeen.get(r.bytes);
      const repeat = r.op === "GetObject" && t !== undefined && r.start - t < REPEAT_WINDOW_MS;
      fresh.set(r.bytes, r.start);
      return { ...r, repeat };
    });
    for (const [k, v] of fresh) lastSeen.set(k, v);
    marked.push({ p, reads });
  }
  const defs = {
    "skip version LIST/HEAD (#59 read-consistency/prewarm)": (r) => r.op === "ListObjectsV2" || r.op === "HeadObject",
    "repeat reads >=64KiB cached (#59 session cache / #60 disk cache)": (r) => r.repeat && r.bytes >= 65536,
    "all repeat GETs cached (#59 / #60 upper bound)": (r) => r.repeat,
    "LIST skipped and all repeat GETs cached (upper bound)": (r) => r.repeat || r.op === "ListObjectsV2" || r.op === "HeadObject",
  };
  const out = [];
  for (const [label, drop] of Object.entries(defs)) {
    const saved = [], after = [], removed = [];
    for (const { p, reads } of marked) {
      const before = roundSum(reads), kept = reads.filter((r) => !drop(r));
      const s = before - roundSum(kept);
      saved.push(s); after.push(p.search.ms - s); removed.push(reads.length - kept.length);
    }
    out.push({ label, savedP50: quantile(saved, .5), savedMean: saved.reduce((a, b) => a + b, 0) / saved.length, afterP50: quantile(after, .5), afterP95: quantile(after, .95), removedMean: removed.reduce((a, b) => a + b, 0) / removed.length });
  }
  return out;
}

function summary(label, per) {
  if (!per.length) return `${label}: no searches`;
  const ms = per.map((p) => p.search.ms), st = per.map((p) => p.storageMs), n = per.map((p) => p.reads.length), r = per.map((p) => p.rounds);
  const share = per.map((p) => Math.min(1, p.storageMs / p.search.ms));
  return `${label}: searches=${per.length} search_p50=${fmt(quantile(ms, .5))}ms p95=${fmt(quantile(ms, .95))}ms | reads/search p50=${quantile(n, .5)} mean=${fmt(n.reduce((a, b) => a + b, 0) / n.length, 1)} p95=${quantile(n, .95)} | serial_rounds p50=${quantile(r, .5)} p95=${quantile(r, .95)} | storage_busy_ms p50=${fmt(quantile(st, .5))} | storage_share p50=${fmt(100 * quantile(share, .5))}% mean=${fmt(100 * share.reduce((a, b) => a + b, 0) / share.length)}%`;
}

if (process.argv[1]?.endsWith("analyze-lancedb-search-reads.mjs")) {
  for (const file of process.argv.slice(2)) {
    const a = analyze(load(file));
    const embed = a.app.filter((r) => r.name === "openrouter.embedding").map((r) => r.ms);
    const unattributed = a.s3.length - a.per.reduce((t, p) => t + p.reads.length, 0);
    console.log(`\n## ${file}`);
    console.log(`app lancedb.search spans=${a.searches.length} isolated=${a.isolated.length}; app lancedb.s3 requests=${a.s3.length} (attributed to isolated searches=${a.s3.length - unattributed}); app query embeddings=${embed.length} p50=${fmt(quantile(embed, .5))}ms p95=${fmt(quantile(embed, .95))}ms`);
    console.log(summary("all isolated", a.per));
    console.log(summary("  ingest-quiet (no worker Lance write within 5s)", a.per.filter((p) => !p.underIngest)));
    console.log(summary("  under ingest", a.per.filter((p) => p.underIngest)));
    const key = (r) => (r.op === "ListObjectsV2" ? "LIST" : `${r.op} ${sizeClass(r.bytes ?? 0)}`);
    console.log("class | req/search | searches with % | p50 ms | p95 ms | MB/search");
    console.log("scenario | saved p50 ms | saved mean ms | search p50 after | search p95 after | requests removed/search");
    for (const sc of scenarios(a.per)) console.log(`${sc.label} | ${fmt(sc.savedP50)} | ${fmt(sc.savedMean)} | ${fmt(sc.afterP50)} | ${fmt(sc.afterP95)} | ${fmt(sc.removedMean, 1)}`);
    for (const g of groupStats(a.per, key)) console.log(`${g.class} | ${fmt(g.requestsPerSearch, 2)} | ${fmt(g.searchesWithPct)} | ${fmt(g.p50)} | ${fmt(g.p95)} | ${fmt(g.mbPerSearch, 2)}`);
  }
}
