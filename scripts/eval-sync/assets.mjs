import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { buildItems, createClient, hash, loadEnv, stableJson, syncDataset } from "./langfuse.mjs";

const digest = (value) => hash(stableJson(value));
const fieldsEqual = (remote, desired) => remote && Object.entries(desired).every(([key, value]) => stableJson(remote[key]) === stableJson(value));

export function validateAssets(manifest) {
  if (manifest.schemaVersion !== 1 || !manifest.sourceCommit || !manifest.namespace?.startsWith("docslurp/")) throw new Error("Asset manifest requires schemaVersion 1, sourceCommit and docslurp/ namespace");
  const seen = new Set();
  for (const prompt of manifest.prompts ?? []) {
    if (!prompt.name?.startsWith(`${manifest.namespace}/`) || seen.has(prompt.name)) throw new Error("Prompt name must be unique and namespaced");
    seen.add(prompt.name);
    if (prompt.type !== "text" || typeof prompt.prompt !== "string" || !prompt.prompt.trim()) throw new Error("Expected nonempty text prompt");
    if (prompt.labels?.some(label => label === "production" || label === "latest")) throw new Error("Sync cannot promote production/latest labels");
  }
  seen.clear();
  for (const evaluator of manifest.evaluators ?? []) {
    if (!evaluator.name?.startsWith(`${manifest.namespace}/`) || seen.has(evaluator.name)) throw new Error("Evaluator name must be unique and namespaced");
    seen.add(evaluator.name);
    if (evaluator.type === "code") {
      if (!evaluator.sourceCode?.trim() || !["TYPESCRIPT", "PYTHON"].includes(evaluator.sourceCodeLanguage)) throw new Error("Invalid code evaluator");
    } else if (evaluator.type === "llm_as_judge") {
      if (!evaluator.prompt || !evaluator.outputDefinition || !evaluator.modelConfig?.provider || !evaluator.modelConfig?.model) throw new Error("Judge requires prompt, output definition and explicit model; project defaults are forbidden");
      const pricing = evaluator.pricing;
      if (!pricing?.source?.startsWith("https://") || !pricing.verifiedAt || !Number.isFinite(pricing.outputUsdPerMillion) || pricing.outputUsdPerMillion < 0 || pricing.outputUsdPerMillion >= 50) throw new Error("Judge requires verified permitted pricing");
      if (/(?:^|[\W_])(pro|ultra)(?:$|[\W_])/i.test(evaluator.modelConfig.model)) throw new Error("Pro/Ultra judges are forbidden");
    } else throw new Error("Unsupported evaluator type");
  }
  for (const dataset of manifest.datasets ?? []) {
    if (!dataset.name?.startsWith(`${manifest.namespace}/`) || !["development", "heldout"].includes(dataset.split)) throw new Error("Invalid dataset namespace/split");
    if (dataset.exportApproved !== true) throw new Error("Dataset needs explicit exportApproved provenance");
    if (dataset.split === "heldout" && dataset.humanReviewed !== true) throw new Error("Heldout data must be human reviewed");
  }
}

export async function syncPrompt(api, spec, commit) {
  const content = { type: spec.type, prompt: spec.prompt, config: { ...spec.config, sourceCommit: commit } };
  const sha = digest(content);
  // Langfuse deployment labels are limited to 36 characters. Keep the full
  // digest in the report and compare the complete content on every readback.
  const label = `sync-${sha.slice(0, 31)}`;
  const path = `/v2/prompts/${encodeURIComponent(spec.name)}?label=${label}&resolve=false`;
  let remote = await api(path);
  const unchanged = Boolean(remote);
  if (remote && !fieldsEqual(remote, content)) throw new Error("Immutable prompt version drift");
  if (!remote) {
    await api("/v2/prompts", { name: spec.name, ...content, labels: [label, ...(spec.labels ?? [])], tags: ["docslurp", "eval-sync"], commitMessage: `Source ${commit}; SHA256 ${sha}` });
    remote = await api(path);
  }
  if (!fieldsEqual(remote, content) || !Number.isInteger(remote.version)) throw new Error("Prompt readback mismatch");
  return { name: spec.name, version: remote.version, contentSha256: sha, label, unchanged, readbackVerified: true };
}

async function listEvaluators(api) {
  const all = [], seen = new Set();
  let cursor;
  do {
    const page = await api(`/v2/evaluators?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!Array.isArray(page?.data)) throw new Error("Langfuse evaluator API unavailable");
    all.push(...page.data);
    cursor = page.meta?.cursor;
    if (cursor && (seen.has(cursor) || seen.size >= 1000)) throw new Error("Invalid evaluator pagination");
    seen.add(cursor);
  } while (cursor);
  return all;
}

export async function syncEvaluator(api, spec, commit) {
  const { pricing, ...definition } = spec;
  const contentSha256 = digest({ definition, pricing: pricing ?? null, commit });
  // Immutable versions avoid changing evaluators attached to existing experiments.
  // Names are not API identifiers: reject ambiguity rather than choosing a match.
  const desired = { ...definition, name: `${spec.name}@${contentSha256.slice(0, 16)}` };
  const matches = (await listEvaluators(api)).filter(item => item.name === desired.name);
  if (matches.length > 1) throw new Error("Ambiguous evaluator identity; reconcile duplicate remote names");
  let remote = matches[0];
  const unchanged = Boolean(remote);
  if (!remote) remote = await api("/v2/evaluators", desired);
  if (!remote?.id) throw new Error("Evaluator creation did not return an ID");
  remote = await api(`/v2/evaluators/${encodeURIComponent(remote.id)}`);
  // The API accepts a user-prompt string shortcut but always returns chat messages.
  const comparable = { ...remote };
  if (typeof desired.prompt === "string" && Array.isArray(remote?.prompt) && remote.prompt.length === 1 && remote.prompt[0].role === "user") comparable.prompt = remote.prompt[0].content;
  if (!fieldsEqual(comparable, desired)) throw new Error("Evaluator readback mismatch");
  return { name: spec.name, id: remote.id, version: remote.version, contentSha256, status: remote.status, pausedReason: remote.pausedReason ?? null, unchanged, readbackVerified: true };
}

export async function syncAssets(api, manifest, datasets) {
  validateAssets(manifest);
  // Check evaluator availability before writing any assets.
  if (manifest.evaluators?.length) await listEvaluators(api);
  const report = { at: new Date().toISOString(), sourceCommit: manifest.sourceCommit, prompts: [], evaluators: [], datasets: [], failures: [], complete: true, llmCalls: 0, evaluationRulesCreated: 0 };
  for (const prompt of manifest.prompts ?? []) report.prompts.push(await syncPrompt(api, prompt, manifest.sourceCommit));
  for (const dataset of datasets) report.datasets.push(await syncDataset(api, dataset));
  for (const evaluator of manifest.evaluators ?? []) {
    try { report.evaluators.push(await syncEvaluator(api, evaluator, manifest.sourceCommit)); }
    catch (error) {
      // A disabled native evaluator runtime must not prevent independent assets
      // from syncing. Retain an explicit failure, never claim complete success.
      report.failures.push({ kind: "evaluator", name: evaluator.name, error: error.message });
      report.complete = false;
    }
  }
  report.runtimeReady = report.complete && report.evaluators.every(item => item.status === "active");
  return report;
}

export async function loadAssets(file) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  for (const spec of [...(manifest.prompts ?? []), ...(manifest.evaluators ?? [])]) {
    for (const [fileKey, field] of [["promptFile", "prompt"], ["sourceCodeFile", "sourceCode"]]) {
      if (spec[fileKey]) {
        spec[field] = await readFile(resolve(dirname(file), spec[fileKey]), "utf8");
        delete spec[fileKey];
      }
    }
  }
  validateAssets(manifest);
  const datasets = [];
  for (const spec of manifest.datasets ?? []) {
    const raw = await readFile(resolve(dirname(file), spec.cases), "utf8");
    const sourceHashes = { cases: hash(raw) };
    const cases = JSON.parse(raw);
    const items = buildItems({ ...spec, cases, sourceHashes, commit: manifest.sourceCommit, config: { ...manifest.config, humanReviewed: spec.humanReviewed === true, purpose: spec.purpose } });
    datasets.push({ ...spec, items, sourceHashes, commit: manifest.sourceCommit });
  }
  return { manifest, datasets };
}

async function main() {
  const args = process.argv.slice(2);
  const option = key => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
  if (!option("--manifest")) throw new Error("Use --manifest PATH [--write --env-file PATH --base-url URL --output PATH]");
  const { manifest, datasets } = await loadAssets(option("--manifest"));
  let report = { dryRun: true, prompts: manifest.prompts?.length ?? 0, evaluators: manifest.evaluators?.length ?? 0, datasets: datasets.map(d => ({ name: d.name, items: d.items.length })), llmCalls: 0 };
  if (args.includes("--write")) {
    const env = await loadEnv(option("--env-file"));
    for (const key of ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) if (!env[key]) throw new Error(`${key} required`);
    const api = createClient({ baseUrl: option("--base-url") ?? env.LANGFUSE_BASE_URL, publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY });
    report = await syncAssets(api, manifest, datasets);
  }
  if (option("--output")) await writeFile(option("--output"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (report.complete === false) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
