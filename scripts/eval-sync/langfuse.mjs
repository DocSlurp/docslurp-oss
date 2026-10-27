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

// Split policy. Held-out splits are exported only into separate datasets whose names say `heldout`, and only to
// targets named by `--allow-heldout`. Tuning tooling must never read them back (see assertTuningReadable).
export const HELDOUT_SPLITS = Object.freeze(["heldout", "test", "holdout"]);
export const TUNING_SPLITS = Object.freeze(["development", "calibration", "train", "dev", "probe", "standards-probe", "pilot-review"]);
export function isHeldoutSplit(split) {
  if (HELDOUT_SPLITS.includes(split)) return true;
  if (TUNING_SPLITS.includes(split)) return false;
  throw new Error(`Unknown split ${JSON.stringify(split)}: classify it in HELDOUT_SPLITS or TUNING_SPLITS first`);
}
export function datasetNameFor(prefix, split) {
  return isHeldoutSplit(split) && split !== "heldout" ? `${prefix}/${split}-heldout` : `${prefix}/${split}`;
}
export function assertSplitName(name, split) {
  const heldout = isHeldoutSplit(split);
  if (typeof name !== "string" || !name.includes(split)) throw new Error("Dataset name must explicitly include its valid split");
  if (heldout && !name.includes("heldout")) throw new Error("Held-out dataset names must contain 'heldout'");
  if (!heldout && name.includes("heldout")) throw new Error("Only held-out datasets may contain 'heldout' in their name");
  return heldout;
}
/** Guard for any tuning/optimisation tool that reads a dataset back from Langfuse. Fails closed. */
export function assertTuningReadable(dataset) {
  const name = dataset?.name ?? "";
  if (/heldout|held-out|holdout/i.test(name) || dataset?.metadata?.heldout !== false || dataset?.metadata?.tuningReadable !== true) {
    throw new Error(`Refusing to read ${JSON.stringify(name)} for tuning: it is held out or not explicitly marked tuning-readable`);
  }
  return dataset;
}

// Langfuse drops C0/C1 control characters (other than tab, newline, carriage return and form feed) from stored JSON,
// so strings carrying them cannot round-trip. buildRecordItems wraps such strings losslessly with encodeUnsafe().
const UNSAFE_CHAR = /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** JSON text with every character outside printable ASCII escaped; always round-trips through Langfuse. */
export const asciiJson = (value) => JSON.stringify(value).replace(/[^\u0020-\u007e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** Wrap each string Langfuse cannot store as `{ "$asciiJson": "<JSON string literal>" }`; decodeUnsafe() reverses it. */
export function encodeUnsafe(value) {
  if (typeof value === "string") return UNSAFE_CHAR.test(value) ? { $asciiJson: asciiJson(value) } : value;
  if (Array.isArray(value)) return value.map(encodeUnsafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => { if (UNSAFE_CHAR.test(key)) throw new Error("Object key contains control characters"); return [key, encodeUnsafe(inner)]; }));
  return value;
}
export function decodeUnsafe(value) {
  if (Array.isArray(value)) return value.map(decodeUnsafe);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$asciiJson" && typeof value.$asciiJson === "string") return JSON.parse(value.$asciiJson);
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, decodeUnsafe(inner)]));
  }
  return value;
}
export function hasUnsafeControlChars(value) {
  if (typeof value === "string") return UNSAFE_CHAR.test(value);
  if (Array.isArray(value)) return value.some(hasUnsafeControlChars);
  if (value && typeof value === "object") return Object.entries(value).some(([key, inner]) => UNSAFE_CHAR.test(key) || hasUnsafeControlChars(inner));
  return false;
}

export const itemId = (datasetName, caseId) => `docslurp-${hash(`${datasetName}\0${caseId}`).slice(0, 48)}`;

/** Question/answer cases (retrieval, multisearch, agent capability). Payload shape is frozen so existing remote items stay identical. */
export function buildItems({ name, split, cases, gold = null, provenance = null, sourceHashes, commit, config = {} }) {
  assertSplitName(name, split);
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
      id: itemId(name, item.id),
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

/** Generic records from catalog adapters: `{ id, split, input, expectedOutput, metadata }`. */
export function buildRecordItems({ name, split, records, commit, config = {} }) {
  const heldout = assertSplitName(name, split);
  const seen = new Set();
  return records.map((record) => {
    if (typeof record.id !== "string" || !record.id || seen.has(record.id)) throw new Error("Missing or duplicate case identity");
    seen.add(record.id);
    if (record.split !== split) throw new Error("Mixed dataset splits are forbidden");
    const payload = {
      id: itemId(name, record.id),
      datasetName: name,
      input: encodeUnsafe(record.input),
      expectedOutput: encodeUnsafe(record.expectedOutput ?? null),
      metadata: encodeUnsafe({ ...record.metadata, caseId: record.id, split, heldout, tuningReadable: !heldout, sourceCommit: commit, config }),
    };
    payload.metadata.syncContentSha256 = hash(stableJson(payload));
    return payload;
  });
}

export function createClient({ baseUrl, publicKey, secretKey, fetchImpl = fetch, timeoutMs = 60_000 }) {
  const url = new URL(baseUrl);
  if (url.username || url.password || (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Langfuse requires HTTPS or localhost without URL credentials");
  const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  const root = baseUrl.replace(/\/$/, "");
  return async (path, body, { method, headers = {} } = {}) => {
    let response;
    try { response = await fetchImpl(`${root}/api/public${path}`, { method: method ?? (body ? "POST" : "GET"), headers: { Authorization: auth, "Content-Type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs), redirect: "error" }); }
    catch (error) { const code = error?.cause?.code ?? error?.name; throw new Error(`Langfuse request failed (${typeof code === "string" && /^[A-Z_a-z0-9]+$/.test(code) ? code : "details-redacted"})`); }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Langfuse HTTP ${response.status} (response body redacted)`);
    if (typeof response.text !== "function") return response.json();
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  };
}

export async function pool(values, limit, fn) {
  const results = new Array(values.length);
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, async () => {
    while (next < values.length && !failed) {
      const index = next++;
      try { results[index] = await fn(values[index], index); } catch (error) { failed = true; throw error; }
    }
  }));
  return results;
}

export async function listDatasetItems(api, name) {
  const items = new Map();
  let page = 1, totalPages = 1;
  do {
    const listed = await api(`/dataset-items?datasetName=${encodeURIComponent(name)}&page=${page}&limit=50`);
    if (!listed || !Array.isArray(listed.data)) throw new Error("Dataset item list readback failed");
    for (const item of listed.data) items.set(item.id, item);
    totalPages = listed.meta?.totalPages ?? 1;
    if (totalPages > 10_000) throw new Error("Dataset pagination exceeds safety bound");
    page++;
  } while (page <= totalPages);
  return items;
}
const sameItem = (remote, item) => remote?.metadata?.syncContentSha256 === item.metadata.syncContentSha256 && stableJson(remote.input) === stableJson(item.input) && stableJson(remote.expectedOutput ?? null) === stableJson(item.expectedOutput ?? null);
const datasetMetadataMatches = (remote, metadata) => Object.entries(metadata).every(([key, value]) => stableJson(remote?.metadata?.[key] ?? null) === stableJson(value ?? null));

/** Idempotent upsert of one dataset. Never deletes. Writes are read back individually, then the item list is re-verified. */
export async function syncDataset(api, { name, split, items, sourceHashes, commit, datasetMetadata = {}, description, concurrency = 6 }) {
  const path = `/v2/datasets/${encodeURIComponent(name)}`;
  const heldout = assertSplitName(name, split);
  const metadata = { split, heldout, tuningReadable: !heldout, sourceHashes, sourceCommit: commit, ...datasetMetadata };
  let dataset = await api(path);
  let datasetAction = "unchanged";
  if (!dataset || !datasetMetadataMatches(dataset, metadata)) {
    datasetAction = dataset ? "updated" : "created";
    await api("/v2/datasets", { name, description: description ?? `DocSlurp ${heldout ? "HELD-OUT (never read for tuning) " : ""}${split} evaluation evidence; historical summaries are not experiment runs`, metadata });
    dataset = await api(path);
    if (!dataset?.id || !datasetMetadataMatches(dataset, metadata)) throw new Error("Dataset metadata readback mismatch");
  }
  const remote = await listDatasetItems(api, name);
  let created = 0, updated = 0, unchanged = 0;
  await pool(items, concurrency, async (item) => {
    let existing = remote.get(item.id);
    if (existing && sameItem(existing, item)) { unchanged++; return; }
    if (!existing) {
      existing = await api(`/dataset-items/${item.id}`);
      if (existing && existing.datasetId !== dataset.id) throw new Error("Stable item ID belongs to a different dataset");
    }
    await api("/dataset-items", item);
    const readback = await api(`/dataset-items/${item.id}`);
    if (!sameItem(readback, item)) throw new Error("Dataset item readback mismatch");
    if (existing) updated++; else created++;
  });
  const ids = created + updated ? new Set((await listDatasetItems(api, name)).keys()) : new Set(remote.keys());
  if (!items.every((item) => ids.has(item.id))) throw new Error("Dataset readback missing expected item IDs");
  return { name, split, heldout, datasetId: dataset.id, dataset: datasetAction, expectedItems: items.length, remoteItems: ids.size, created, updated, unchanged, readbackVerified: true };
}

/** Reads only LANGFUSE_* keys. Values stay in memory and are never logged. */
export async function loadEnv(path, keys = ["LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"]) {
  const env = {};
  if (path) for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?(LANGFUSE_[A-Z_]+)\s*=\s*(.*)$/);
    if (match && keys.includes(match[1])) { let value = match[2].trim(); if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); env[match[1]] = value; }
  } else for (const key of keys) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export const gitHead = (cwd) => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd }).trim();

export function parseArgs(argv) {
  const flags = new Set(["--write", "--exclude-heldout", "--skip-datasets", "--skip-score-configs", "--skip-runs"]);
  const multi = new Set(["--manifest", "--run"]);
  const out = { manifest: [], run: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (flags.has(key)) { out[name] = true; continue; }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value`);
    if (multi.has(key)) out[name].push(value); else out[name] = value;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { runSync } = await import("./sync.mjs");
  const report = await runSync(args);
  if (args.output) await writeFile(args.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report.summary, null, 2));
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
