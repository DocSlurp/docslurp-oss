import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function buildItems({ name, split, cases, gold = null, provenance = null, sourceHashes, commit, config = {} }) {
  if (!["development", "heldout"].includes(split) || !name.includes(split)) throw new Error("Dataset name must explicitly include its valid split");
  const seen = new Set();
  const goldById = new Map((gold ?? []).map((item) => [item.id, item]));
  if (gold !== null && goldById.size !== gold.length) throw new Error("Duplicate gold identity");
  if (gold !== null && (gold.length !== cases.length || cases.some((item) => !goldById.has(item.id)))) throw new Error("Separate gold must label every case exactly once");
  return cases.map((item) => {
    if (typeof item.id !== "string" || !item.id || seen.has(item.id)) throw new Error("Missing or duplicate case identity");
    seen.add(item.id);
    if (item.split && item.split !== split) throw new Error("Mixed dataset splits are forbidden");
    if (typeof item.question !== "string") throw new Error("Case question is required");
    const { original, retrieval, diagnosis, provenance: caseProvenance, ...caseFields } = item;
    const expectedOutput = goldById.get(item.id) ?? Object.fromEntries(Object.entries(caseFields).filter(([key]) => !["id", "version", "split", "question"].includes(key)));
    const historicalEvidence = original ? { ...original, evidenceType: "historical-summary-not-experiment", costs: { providerActualUsd: null, providerEstimatedUsd: null, customerLedgerUsd: null, status: "not-provided-in-summary" } } : null;
    const payload = {
      id: `docslurp-${hash(`${name}\0${item.id}`).slice(0, 48)}`,
      datasetName: name,
      input: { caseId: item.id, question: item.question },
      expectedOutput,
      metadata: { split, caseVersion: item.version ?? null, sourceHashes, sourceCommit: commit, config, provenance: caseProvenance ?? provenance, retrievalConfig: retrieval ?? null, diagnosis: diagnosis ?? null, historicalEvidence },
      ...(item.sourceTraceId ? { sourceTraceId: item.sourceTraceId } : {}),
      ...(item.sourceObservationId ? { sourceObservationId: item.sourceObservationId } : {}),
    };
    payload.metadata.syncContentSha256 = hash(stableJson(payload));
    return payload;
  });
}

export function createClient({ baseUrl, publicKey, secretKey, fetchImpl = fetch }) {
  const url = new URL(baseUrl);
  if (url.username || url.password || (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Langfuse requires HTTPS or localhost without URL credentials");
  const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  return async (path, body) => {
    let response;
    try { response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/public${path}`, { method: body ? "POST" : "GET", headers: { Authorization: auth, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000), redirect: "error" }); }
    catch (error) { const code = error?.cause?.code ?? error?.name; throw new Error(`Langfuse request failed (${typeof code === "string" && /^[A-Z_a-z0-9]+$/.test(code) ? code : "details-redacted"})`); }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Langfuse HTTP ${response.status} (response body redacted)`);
    return response.json();
  };
}

export async function syncDataset(api, { name, split, items, sourceHashes, commit }) {
  const path = `/v2/datasets/${encodeURIComponent(name)}`;
  let dataset = await api(path);
  if (!dataset) dataset = await api("/v2/datasets", { name, description: `DocSlurp ${split} evaluation evidence; historical summaries are not experiment runs`, metadata: { split, sourceHashes, sourceCommit: commit } });
  let created = 0, updated = 0, unchanged = 0;
  for (const item of items) {
    const remote = await api(`/dataset-items/${item.id}`);
    if (remote && remote.datasetId !== dataset.id) throw new Error("Stable item ID belongs to a different dataset");
    if (remote?.metadata?.syncContentSha256 === item.metadata.syncContentSha256 && stableJson(remote.input) === stableJson(item.input) && stableJson(remote.expectedOutput) === stableJson(item.expectedOutput)) { unchanged++; continue; }
    await api("/dataset-items", item);
    const readback = await api(`/dataset-items/${item.id}`);
    if (readback?.metadata?.syncContentSha256 !== item.metadata.syncContentSha256 || stableJson(readback.input) !== stableJson(item.input) || stableJson(readback.expectedOutput) !== stableJson(item.expectedOutput)) throw new Error("Dataset item readback mismatch");
    if (remote) updated++; else created++;
  }
  const ids = new Set();
  let page = 1, totalPages = 1;
  do {
    const listed = await api(`/dataset-items?datasetName=${encodeURIComponent(name)}&page=${page}&limit=100`);
    if (!listed || !Array.isArray(listed.data)) throw new Error("Dataset item list readback failed");
    for (const item of listed.data) ids.add(item.id);
    totalPages = listed.meta?.totalPages ?? 1;
    if (totalPages > 1000) throw new Error("Dataset pagination exceeds safety bound");
    page++;
  } while (page <= totalPages);
  if (!items.every((item) => ids.has(item.id))) throw new Error("Dataset readback missing expected item IDs");
  return { name, split, expectedItems: items.length, remoteItems: ids.size, created, updated, unchanged, readbackVerified: true };
}

async function loadEnv(path) {
  const env = { ...process.env };
  if (path) for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?(LANGFUSE_[A-Z_]+)\s*=\s*(.*)$/);
    if (match) { let value = match[2].trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); env[match[1]] = value; }
  }
  return env;
}
async function main() {
  const args = process.argv.slice(2);
  const option = (key) => args[args.indexOf(key) + 1];
  if (!args.includes("--manifest")) throw new Error("Use --manifest PATH [--env-file PATH] [--output PATH] [--write]");
  const manifest = JSON.parse(await readFile(option("--manifest"), "utf8"));
  const commit = manifest.sourceCommit ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const loaded = [];
  for (const spec of manifest.datasets) {
    const raw = await readFile(spec.cases, "utf8");
    const parsed = JSON.parse(raw);
    const goldRaw = spec.gold ? await readFile(spec.gold, "utf8") : null;
    const provenanceRaw = spec.provenance ? await readFile(spec.provenance, "utf8") : null;
    const sourceHashes = { cases: hash(raw), ...(goldRaw ? { gold: hash(goldRaw) } : {}), ...(provenanceRaw ? { provenance: hash(provenanceRaw) } : {}), ...(spec.source ? { source: hash(await readFile(spec.source)) } : {}) };
    const items = buildItems({ ...spec, cases: Array.isArray(parsed) ? parsed : parsed.cases, gold: goldRaw ? JSON.parse(goldRaw) : null, provenance: provenanceRaw ? JSON.parse(provenanceRaw) : null, sourceHashes, commit, config: manifest.config ?? {} });
    loaded.push({ ...spec, items, sourceHashes, commit });
  }
  if (args.includes("--outbox")) await writeFile(option("--outbox"), JSON.stringify({ sourceCommit: commit, datasets: loaded.map(({ name, split, items, sourceHashes }) => ({ name, split, items, sourceHashes })) }, null, 2) + "\n", { mode: 0o600 });
  let results;
  if (args.includes("--write")) {
    const env = await loadEnv(args.includes("--env-file") ? option("--env-file") : null);
    for (const key of ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) if (!env[key]) throw new Error(`${key} required`);
    const api = createClient({ baseUrl: args.includes("--base-url") ? option("--base-url") : env.LANGFUSE_BASE_URL, publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY });
    results = [];
    for (const spec of loaded) results.push(await syncDataset(api, spec));
  } else results = loaded.map(({ name, split, items }) => ({ name, split, expectedItems: items.length, dryRun: true }));
  const report = { at: new Date().toISOString(), sourceCommit: commit, datasets: results, experimentRunsCreated: 0, experimentLinking: "pending-supported-trace-evidence-import", llmCalls: 0 };
  if (args.includes("--output")) await writeFile(option("--output"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
