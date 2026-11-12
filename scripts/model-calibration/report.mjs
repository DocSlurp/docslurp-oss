// Summarize a run: per feature × arm — deterministic metric means, failure rates, latency p50/p95, cost,
// reasoning-token distribution; plus judge win/tie/loss when judge files exist.
// Usage: node report.mjs --run dev1 [--split dev] [--json]
import { readFileSync, readdirSync } from "node:fs";

const arg = (flag, fallback) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : fallback; };
const run = arg("--run"); const which = arg("--split", "all");
const dir = new URL(`./runs/${run}/`, import.meta.url);
const rows = readFileSync(new URL("results.jsonl", dir), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  .filter((r) => which === "all" || r.split === which);

const pct = (values, p) => { const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const mean = (values) => { const v = values.filter((x) => typeof x === "number" || typeof x === "boolean").map(Number); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

const groups = new Map();
for (const row of rows) {
  const key = `${row.feature}|${row.arm}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
const summary = [];
for (const [key, list] of groups) {
  const [feature, arm] = key.split("|");
  const metrics = {};
  for (const name of new Set(list.flatMap((r) => Object.keys(r.metrics ?? {})))) {
    if (name === "calls") continue;
    metrics[name] = mean(list.map((r) => r.metrics?.[name]));
  }
  const calls = list.flatMap((r) => r.calls ?? []);
  const ok = calls.filter((c) => c.status === 200);
  summary.push({ feature, arm, n: list.length, failed: list.filter((r) => r.error).length / list.length,
    wallP50: pct(list.map((r) => r.wallMs), 0.5), wallP95: pct(list.map((r) => r.wallMs), 0.95),
    callP50: pct(ok.map((c) => c.latencyMs), 0.5), ttftP50: pct(ok.map((c) => c.ttftMs), 0.5),
    reasoningP50: pct(ok.map((c) => c.reasoningTokens ?? 0), 0.5), reasoningP95: pct(ok.map((c) => c.reasoningTokens ?? 0), 0.95), reasoningMax: pct(ok.map((c) => c.reasoningTokens ?? 0), 1),
    lengthRate: ok.length ? ok.filter((c) => c.finishReason === "length").length / ok.length : null,
    http4xx: calls.filter((c) => c.status >= 400).length, costPerCaseUsd: list.reduce((a, r) => a + (r.costUsd ?? 0), 0) / list.length,
    hosts: Object.entries(ok.reduce((m, c) => ((m[c.servedBy ?? "?"] = (m[c.servedBy ?? "?"] ?? 0) + 1), m), {})).map(([h, n]) => `${h}:${n}`).join(" "),
    metrics });
}
summary.sort((a, b) => a.feature.localeCompare(b.feature) || a.arm.localeCompare(b.arm));

const judges = [];
for (const file of readdirSync(dir).filter((f) => f.startsWith("judge-") && f.endsWith(".jsonl"))) {
  const verdicts = readFileSync(new URL(file, dir), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((v) => which === "all" || v.split === which);
  const byFeature = new Map();
  for (const v of verdicts.filter((v) => !v.swapped)) { if (!byFeature.has(v.feature)) byFeature.set(v.feature, []); byFeature.get(v.feature).push(v); }
  for (const [feature, list] of byFeature) {
    judges.push({ file, feature, n: list.length, win: list.filter((v) => v.winner === "candidate").length, tie: list.filter((v) => v.winner === "tie").length,
      loss: list.filter((v) => v.winner === "baseline").length, candSevere: list.filter((v) => v.candidateSevere).length, baseSevere: list.filter((v) => v.baselineSevere).length,
      candScore: mean(list.map((v) => v.candidateScore)), baseScore: mean(list.map((v) => v.baselineScore)) });
  }
  const swapped = verdicts.filter((v) => v.swapped);
  const agree = swapped.filter((s) => verdicts.find((v) => !v.swapped && v.feature === s.feature && v.case === s.case)?.winner === s.winner).length;
  if (swapped.length) judges.push({ file, feature: "(position-swap agreement)", n: swapped.length, agreement: agree / swapped.length });
}

if (process.argv.includes("--json")) { console.log(JSON.stringify({ summary, judges }, null, 2)); process.exit(0); }
const fmt = (v) => (v === null || v === undefined ? "–" : typeof v === "number" ? (Math.abs(v) < 10 && !Number.isInteger(v) ? v.toFixed(2) : String(Math.round(v))) : String(v));
for (const s of summary) {
  console.log(`${s.feature.padEnd(30)} ${s.arm.padEnd(16)} n=${String(s.n).padStart(3)} fail=${fmt(s.failed)} p50=${fmt(s.wallP50)}ms p95=${fmt(s.wallP95)}ms ttft=${fmt(s.ttftP50)} rsn p50/p95/max=${fmt(s.reasoningP50)}/${fmt(s.reasoningP95)}/${fmt(s.reasoningMax)} len=${fmt(s.lengthRate)} 4xx=${s.http4xx} $/case=${(s.costPerCaseUsd * 1000).toFixed(3)}m`);
  console.log(`   ${Object.entries(s.metrics).map(([k, v]) => `${k}=${fmt(v)}`).join(" ")}  [${s.hosts}]`);
}
for (const j of judges) console.log(`JUDGE ${j.file} ${j.feature.padEnd(30)} ${j.agreement !== undefined ? `agreement=${fmt(j.agreement)} n=${j.n}` : `n=${j.n} W/T/L=${j.win}/${j.tie}/${j.loss} severe cand/base=${j.candSevere}/${j.baseSevere} score cand/base=${fmt(j.candScore)}/${fmt(j.baseScore)}`}`);
