// Calibration runner: features × arms × cases, bounded concurrency, hard budget stop, append-only JSONL.
// Usage: tsx run.mts --run <name> --features a,b --arms incumbent,mm-minimal --split dev|heldout|all --budget-usd 1
import "./shim.mts";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { withArm, settle, type Arm } from "./shim.mts";
import { FEATURES } from "./features.mts";
import { split } from "./corpus.mts";
import { setOpenRouterProviderPolicyResolver } from "../../packages/shared/dist/index.js";

// Outside a job the worker fails closed (no China-based hosts). Benchmark the default organization policy
// (China-based hosts allowed) unless CHINA_PROVIDERS=0 asks for the restricted policy.
const allowChinaProviders = process.env.CHINA_PROVIDERS !== "0";
setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders, speedBoost: false }));

const MM = "minimax/minimax-m3.1-flash";
const NO_FP4 = ["fp8", "fp16", "bf16", "fp32", "unknown"];
export const ARMS: Record<string, Arm> = {
  incumbent: { id: "incumbent", reasoning: "keep", provider: "keep" },
  "mm-asis": { id: "mm-asis", model: MM, reasoning: "keep", provider: "omit" },
  "mm-default": { id: "mm-default", model: MM, reasoning: "omit", provider: "omit" },
  "mm-minimal": { id: "mm-minimal", model: MM, reasoning: { effort: "minimal" }, provider: "omit" },
  "mm-low": { id: "mm-low", model: MM, reasoning: { effort: "low" }, provider: "omit" },
  "mm-minimal-r256": { id: "mm-minimal-r256", model: MM, reasoning: { effort: "minimal" }, provider: "omit", extraOutputTokens: 256 },
  "mm-minimal-r512": { id: "mm-minimal-r512", model: MM, reasoning: { effort: "minimal" }, provider: "omit", extraOutputTokens: 512 },
  "mm-minimal-r768": { id: "mm-minimal-r768", model: MM, reasoning: { effort: "minimal" }, provider: "omit", extraOutputTokens: 768 },
  "mm-low-r512": { id: "mm-low-r512", model: MM, reasoning: { effort: "low" }, provider: "omit", extraOutputTokens: 512 },
  "mm-minimal-px": { id: "mm-minimal-px", model: MM, reasoning: { effort: "minimal" }, extraOutputTokens: 512, provider: { sort: "price", quantizations: NO_FP4, allow_fallbacks: true } },
  "mm-minimal-lat": { id: "mm-minimal-lat", model: MM, reasoning: { effort: "minimal" }, extraOutputTokens: 512, provider: { sort: "latency", quantizations: NO_FP4, allow_fallbacks: true } },
};

const arg = (flag: string, fallback?: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : fallback; };
const runName = arg("--run") ?? "";
if (!/^[a-z0-9-]+$/.test(runName)) throw new Error("--run <name> required");
const featureIds = arg("--features", "all")!;
const armIds = arg("--arms", "incumbent,mm-minimal")!.split(",");
const which = arg("--split", "dev");
const budget = Number(arg("--budget-usd", "1"));
const concurrency = Number(arg("--concurrency", "6"));
const limit = Number(arg("--limit", "1000"));
const features = FEATURES.filter((f) => featureIds === "all" || featureIds.split(",").includes(f.id));
const outDir = new URL(`./runs/${runName}/`, import.meta.url);
mkdirSync(outDir, { recursive: true });
const outFile = new URL("results.jsonl", outDir);
if (existsSync(outFile) && !process.argv.includes("--append")) throw new Error(`results exist for run ${runName}; pass --append to add arms/features`);

const jobs: Array<() => Promise<void>> = [];
let spent = 0;
let stopped = false;
for (const feature of features) for (const armId of armIds) {
  const arm = ARMS[armId];
  if (!arm) throw new Error(`unknown arm ${armId}`);
  const selected = feature.cases().filter((c) => which === "all" || split(`${feature.id}:${c.id}`) === which).slice(0, limit);
  for (const c of selected) {
    jobs.push(async () => {
      if (stopped) return;
      const started = performance.now();
      const { value, error, calls } = await withArm(arm, () => feature.run(c, arm.model ?? feature.incumbent));
      await settle(calls);
      const wall = Math.round(performance.now() - started);
      const cost = calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
      spent += cost;
      if (spent > budget) stopped = true;
      let scored: ReturnType<typeof feature.score> | undefined;
      let scoreError: string | undefined;
      try { scored = feature.score(c, value, calls); } catch (e) { scoreError = String(e); }
      appendFileSync(outFile, JSON.stringify({ run: runName, feature: feature.id, arm: arm.id, case: c.id, split: split(`${feature.id}:${c.id}`), wallMs: wall, costUsd: cost,
        error, scoreError, metrics: scored?.metrics, output: scored?.output, judge: scored?.judge, calls }) + "\n");
      process.stdout.write(".");
    });
  }
}
console.log(`${jobs.length} jobs, budget $${budget}`);
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => { while (next < jobs.length) await jobs[next++]!(); }));
console.log(`\nspent $${spent.toFixed(4)}${stopped ? " (STOPPED at budget)" : ""}`);
process.exit(0);
