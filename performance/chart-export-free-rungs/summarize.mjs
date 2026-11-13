#!/usr/bin/env node
// Summarize a `bench.mjs guest` result (several arms) into Markdown tables.
//
//   node summarize.mjs <result.json> [--time cpu|wall]
//
// Guest-only throughput: a parser-VM command costs the guest process's time plus the VM's own per-command overhead
// (exec, staging, reset), which this harness does not see. `--time cpu` (default, for a loaded dev host) uses guest
// CPU time as its duration: the guest is single-threaded and CPU-bound, so on an idle VM wall ≈ CPU. `--time wall`
// uses measured wall time (use it for runs inside a real VM).
// Doppler figure workloads count the source PDF's pages while the guest processes only its figure SVGs, so their
// pages / min is not comparable with the other sets.
import { readFileSync } from "node:fs";

const [file, ...flags] = process.argv.slice(2);
const timeKey = flags.includes("--time") ? flags[flags.indexOf("--time") + 1] : "cpu";
const { results } = JSON.parse(readFileSync(file, "utf8"));
const arms = [...new Set(results.map((r) => r.arm))];
const label = (a) => a.split("/").pop();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");

// Correctness: every arm must produce the same output hash per workload.
const ids = [...new Set(results.map((r) => r.id))];
const mismatches = ids.filter((id) => new Set(results.filter((r) => r.id === id).map((r) => r.hash)).size !== 1);
const failures = results.filter((r) => r.fail);
console.log(`Outputs identical across arms: ${mismatches.length === 0 ? "yes" : `NO (${mismatches.join(", ")})`}; failed runs: ${failures.length}`);
console.log(`Runs per arm per workload: ${median(results.map((r) => r.cpuMs.length))}; time basis: ${timeKey}\n`);

const sets = ["office", "embedded", "svg-upload", "doppler-figures", "free-path (all but adversarial)", "adversarial"];
console.log("| set | arm | guest runs | pages | visuals | CPU ms / run (median) | CPU ms / page | CPU ms / visual | peak RSS MB (max) | pages / min (guest) |");
console.log("|---|---|--:|--:|--:|--:|--:|--:|--:|--:|");
for (const set of sets) {
  for (const arm of arms) {
    const rows = results.filter((r) => r.arm === arm && (set.startsWith("free-path") ? r.set !== "adversarial" : r.set === set));
    if (!rows.length) continue;
    const pages = rows.reduce((s, r) => s + r.pages, 0);
    const visuals = rows.reduce((s, r) => s + r.visuals, 0);
    const cpu = rows.reduce((s, r) => s + r.medCpuMs, 0);
    const t = rows.reduce((s, r) => s + (timeKey === "wall" ? r.medWallMs : r.medCpuMs), 0);
    const rss = Math.max(...rows.map((r) => r.maxRssMb));
    const ppm = pages / (t / 60000);
    console.log(`| ${set} | ${label(arm)} | ${rows.length} | ${pages} | ${visuals} | ${(cpu / rows.length).toFixed(0)} | ${(cpu / pages).toFixed(1)} | ${visuals ? (cpu / visuals).toFixed(1) : "-"} | ${rss.toFixed(0)} | ${fmtInt(ppm)} |`);
  }
}

// Paired effect: per workload, arm / first arm (median CPU), then the median and range of those ratios.
console.log("\n| arm vs " + label(arms[0]) + " | CPU ratio per workload: median (min-max) | peak RSS delta MB: median (min-max) |");
console.log("|---|---|---|");
for (const arm of arms.slice(1)) {
  const ratios = [], rss = [];
  for (const id of ids) {
    const a = results.find((r) => r.id === id && r.arm === arms[0]);
    const b = results.find((r) => r.id === id && r.arm === arm);
    if (!a || !b || a.set === "adversarial") continue;
    ratios.push(b.medCpuMs / a.medCpuMs);
    rss.push(b.maxRssMb - a.maxRssMb);
  }
  console.log(`| ${label(arm)} | ${median(ratios).toFixed(2)} (${Math.min(...ratios).toFixed(2)}-${Math.max(...ratios).toFixed(2)}) | ${median(rss).toFixed(0)} (${Math.min(...rss).toFixed(0)} to ${Math.max(...rss).toFixed(0)}) |`);
}

// Noise: per-workload spread within an arm (IQR / median of CPU samples).
const spread = (xs) => { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; return (q(0.75) - q(0.25)) / median(xs); };
console.log("\nWithin-arm noise (CPU IQR / median, median over workloads): " + arms.map((a) => `${label(a)} ${(median(results.filter((r) => r.arm === a).map((r) => spread(r.cpuMs))) * 100).toFixed(1)}%`).join(", "));
