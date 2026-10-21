import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const modes = ["off", "moderation", "judge", "cascade"];
const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const stats = (values) => {
  if (!values.length) return { count: 0, mean: null, p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1] };
};

/** Offline analysis only. Pair by immutable workload identity AND repetition, not order. */
export function compareOverhead(samples) {
  if (!Array.isArray(samples) || !samples.length) throw new Error("Nonempty paired samples required");
  const pairs = new Map();
  for (const s of samples) {
    if (!s.pairId || !s.workloadHash || !s.traceId || !modes.includes(s.mode) || !["allow", "block", "review_required", "error"].includes(s.outcome)
      || !finite(s.elapsedMs) || !(s.providerCostUsd === null || finite(s.providerCostUsd))) throw new Error("Invalid sample identity, timing, outcome or cost");
    const pair = pairs.get(s.pairId) ?? new Map();
    if (pair.has(s.mode)) throw new Error("Duplicate pair/mode");
    if ([...pair.values()].some(other => other.workloadHash !== s.workloadHash)) throw new Error("Paired workload mismatch");
    pair.set(s.mode, s); pairs.set(s.pairId, pair);
  }
  const results = [];
  for (const mode of modes.slice(1)) {
    const selected = [...pairs.values()].filter(p => p.has(mode));
    if (!selected.length) continue;
    if (selected.some(p => !p.has("off"))) throw new Error("Every guarded sample needs its paired off baseline");
    const all = selected.map(p => p.get(mode));
    // Fast rejection is not a speedup for equivalent successful work.
    const allowed = selected.filter(p => p.get(mode).outcome === "allow" && p.get("off").outcome === "allow");
    const knownCosts = selected.filter(p => p.get(mode).providerCostUsd !== null && p.get("off").providerCostUsd !== null);
    results.push({ mode, pairs: selected.length,
      outcomes: Object.fromEntries(["allow", "block", "review_required", "error"].map(o => [o, all.filter(s => s.outcome === o).length])),
      allElapsedMs: stats(all.map(s => s.elapsedMs)),
      allowedPairedDeltaMs: stats(allowed.map(p => p.get(mode).elapsedMs - p.get("off").elapsedMs)),
      knownCostPairs: knownCosts.length, unknownCostPairs: selected.length - knownCosts.length,
      pairedCostDeltaUsd: stats(knownCosts.map(p => p.get(mode).providerCostUsd - p.get("off").providerCostUsd)),
    });
  }
  if (!results.length) throw new Error("At least one guarded arm is required");
  return { evidence: "supplied-paired-observations", results, qualityMeasured: false };
}

export function estimateOverhead({ checks, inputTokens, outputTokens, inputUsdPerMillion, outputUsdPerMillion, escalationFraction }) {
  if (![checks, inputTokens, outputTokens, inputUsdPerMillion, outputUsdPerMillion, escalationFraction].every(finite) || escalationFraction > 1) throw new Error("Invalid pricing assumptions");
  const judge = checks * (inputTokens * inputUsdPerMillion + outputTokens * outputUsdPerMillion) / 1e6;
  return { evidence: "estimate-not-benchmark", assumptions: { checks, inputTokens, outputTokens, inputUsdPerMillion, outputUsdPerMillion, escalationFraction },
    incrementalProviderCostUsd: { off: 0, moderation: 0, judge, cascade: judge * escalationFraction },
    latencyMs: null, excludes: ["application compute", "OCR/transcription", "storage/egress", "observability", "human review", "retries", "gateway fees"], qualityMeasured: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [kind, input, output] = process.argv.slice(2);
  if (!["compare", "estimate"].includes(kind) || !input || !output) throw new Error("Usage: guardrail-overhead.mjs compare|estimate INPUT.json OUTPUT.json");
  const data = JSON.parse(await readFile(input, "utf8"));
  const report = kind === "compare" ? compareOverhead(data.samples) : { ...estimateOverhead(data), sources: data.sources ?? [] };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
