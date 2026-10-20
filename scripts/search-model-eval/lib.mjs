// Shared helpers for the search-agent model-comparison harness.
// Plain Node ESM, no dependencies: hashing, seeded randomness, JSONL I/O,
// the model price policy, the budget guard and an OpenRouter client that
// logs and ledgers every call.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DATASET_SCHEMA = "docslurp-search-model-eval@v1";
export const TIERS = ["mid-5k", "large-58k"];
export const KINDS = ["single_hop", "multi_hop", "unanswerable", "labeled"];
export const SPLITS = ["dev", "test"];
export const STOP_REASONS = ["answered", "answered_without_citations", "step_limit", "tool_call_limit", "timeout", "error", "no_evidence"];
export const DEFAULT_GENERATOR_MODEL = "google/gemini-3.8-flash";
export const DEFAULT_JUDGE_MODEL = "google/gemini-3.8-flash";
export const DEFAULT_BASELINE_MODEL = "z-ai/glm-5.3-flash";
export const DEFAULT_PRICES_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../lib/model-prices.json");
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const normalize = (text) => String(text ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** JSON with sorted object keys, so hashes do not depend on property order. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
export const hashOf = (value) => sha256(stableStringify(value));

/** Uniform [0, 1) from a seed and a key; the basis of every deterministic choice. */
export function unitHash(seed, key) {
  return Number.parseInt(sha256(`${seed}\0${key}`).slice(0, 12), 16) / 2 ** 48;
}

/** Seeded PRNG (mulberry32) for bootstrap resampling and audits. */
export function seededRandom(seed) {
  let state = Number.parseInt(sha256(String(seed)).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic seeded order: sort by hash of (seed, key). */
export function seededOrder(items, seed, keyOf) {
  return [...items].map((item) => ({ item, rank: unitHash(seed, keyOf(item)) })).sort((a, b) => a.rank - b.rank).map(({ item }) => item);
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at ${path}:${index + 1}`); }
  });
}
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const appendJsonl = (path, value) => appendFileSync(path, `${JSON.stringify(value)}\n`);
/** Evidence is never overwritten: `wx` fails when the file exists. */
export const writeJsonExclusive = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
export const writeTextExclusive = (path, text) => writeFileSync(path, text, { flag: "wx" });

export function parseArgs(argv, { booleans = [] } = {}) {
  const options = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { options._.push(arg); continue; }
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) options[key] = inline;
    else if (booleans.includes(key)) options[key] = true;
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
      options[key] = value;
      i++;
    }
  }
  return options;
}

export const expandHome = (path) => (path?.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

/** Credentials file reader; the file is read at runtime and never printed. */
export function apiKeyResolver({ credentialsPath = null, fieldByTier = { "mid-5k": "midApiKey", "large-58k": "largeApiKey" }, envByTier = null, env = process.env }) {
  const credentials = credentialsPath ? JSON.parse(readFileSync(expandHome(credentialsPath), "utf8")) : null;
  return (tier) => {
    const key = envByTier?.[tier] ? env[envByTier[tier]] : credentials?.[fieldByTier[tier]];
    if (!key) throw new Error(`No API key for tier ${tier}`);
    return key;
  };
}

// ---------------------------------------------------------------- price policy

/** Pro and Ultra models are never used in evaluations, including judges and retries. */
export const PROHIBITED_MODEL = /(?:^|[-_/:.])(?:pro|ultra)(?:$|[-_/:.])/i;
export const MAX_OUTPUT_USD_PER_MTOK = 50;

export function loadPrices(path = DEFAULT_PRICES_PATH, overrides = {}) {
  const file = readJson(path);
  return { ...file, models: { ...file.models, ...overrides } };
}

/** Throws unless the model is allowed: not Pro/Ultra, known price, output < $50/M. */
export function assertModelAllowed(model, prices) {
  if (typeof model !== "string" || !model.trim()) throw new Error("Model id required");
  if (PROHIBITED_MODEL.test(model)) throw new Error(`Prohibited model (Pro/Ultra): ${model}`);
  const price = prices?.models?.[model];
  if (!price || !Number.isFinite(price.input) || !Number.isFinite(price.output) || price.input < 0 || price.output < 0) throw new Error(`Unknown or unpriced model: ${model}; add a verified price to the price file or config`);
  if (price.output >= MAX_OUTPUT_USD_PER_MTOK) throw new Error(`Prohibited model (output price $${price.output}/M >= $${MAX_OUTPUT_USD_PER_MTOK}/M): ${model}`);
  return price;
}

export const tokenCostUsd = (price, inputTokens, outputTokens) => ((inputTokens ?? 0) * price.input + (outputTokens ?? 0) * price.output) / 1e6;

// ---------------------------------------------------------------- budget guard

/**
 * Hard USD cap. Each call reserves a pessimistic estimate before it starts and
 * is reconciled to its actual cost afterwards. A call without a reported cost
 * stays charged at its estimate. New reservations are refused once
 * actual + reserved + next estimate would exceed the cap.
 */
export class BudgetGuard {
  constructor({ capUsd, logPath = null, now = () => new Date().toISOString(), priorActualUsd = 0 }) {
    if (!(Number.isFinite(capUsd) && capUsd > 0)) throw new Error("Budget cap (USD) must be a positive number");
    this.capUsd = capUsd;
    this.logPath = logPath;
    this.now = now;
    this.actualUsd = priorActualUsd;
    this.reservations = new Map();
    this.refusals = 0;
    this.sequence = 0;
  }

  /** Rebuild spend from a previous guard log: reconciled actuals plus never-reconciled estimates. */
  static fromLog({ capUsd, logPath, now }) {
    const events = logPath ? readJsonl(logPath) : [];
    const open = new Map();
    let actual = 0;
    for (const event of events) {
      if (event.event === "reserve") open.set(event.reservationId, event.estimateUsd);
      if (event.event === "reconcile") { open.delete(event.reservationId); actual += event.chargedUsd; }
    }
    for (const estimate of open.values()) actual += estimate;
    const guard = new BudgetGuard({ capUsd, logPath, now, priorActualUsd: actual });
    if (events.length) guard.log({ event: "resume", priorEvents: events.length, unreconciledChargedAtEstimate: open.size });
    return guard;
  }

  get reservedUsd() { let sum = 0; for (const r of this.reservations.values()) sum += r.estimateUsd; return sum; }
  state() { return { capUsd: this.capUsd, actualUsd: round6(this.actualUsd), reservedUsd: round6(this.reservedUsd), headroomUsd: round6(this.capUsd - this.actualUsd - this.reservedUsd), openReservations: this.reservations.size, refusals: this.refusals }; }
  log(event) { if (this.logPath) appendJsonl(this.logPath, { at: this.now(), ...event, state: this.state() }); }

  /** Returns a reservation id, or null when the call would break the cap. */
  reserve({ key, model, estimateUsd }) {
    if (!(Number.isFinite(estimateUsd) && estimateUsd >= 0)) throw new Error("Reservation needs a finite estimate");
    if (this.actualUsd + this.reservedUsd + estimateUsd > this.capUsd) {
      this.refusals++;
      this.log({ event: "refuse", key, model, estimateUsd });
      return null;
    }
    const reservationId = `${process.pid}-${++this.sequence}-${randomBytes(3).toString("hex")}`;
    this.reservations.set(reservationId, { key, model, estimateUsd });
    this.log({ event: "reserve", reservationId, key, model, estimateUsd });
    return reservationId;
  }

  /** Settle a reservation with the actual USD cost; null keeps the pessimistic estimate. */
  reconcile(reservationId, { actualUsd = null, source = "unknown" } = {}) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error(`Unknown reservation ${reservationId}`);
    this.reservations.delete(reservationId);
    const known = Number.isFinite(actualUsd) && actualUsd >= 0;
    const chargedUsd = known ? actualUsd : reservation.estimateUsd;
    this.actualUsd += chargedUsd;
    const event = { event: "reconcile", reservationId, key: reservation.key, model: reservation.model, estimateUsd: reservation.estimateUsd, actualUsd: known ? actualUsd : null, chargedUsd, source: known ? source : "unknown-charged-at-estimate" };
    this.log(event);
    return event;
  }
}
const round6 = (value) => Math.round(value * 1e6) / 1e6;

// ---------------------------------------------------------------- OpenRouter client

/**
 * One OpenRouter chat completion with usage accounting. Logs the
 * `[ai-usage]` line and appends the actual usage and provider-reported cost
 * to the spend ledger. A budget guard, when given, must admit the call first.
 */
export async function openRouterJson({ model, messages, apiKey, metric, ledgerPath, guard = null, prices, maxTokens = 2048, fetchImpl = fetch, timeoutMs = 120_000, scope = {}, log = console.log }) {
  const price = assertModelAllowed(model, prices);
  if (!apiKey) throw new Error("OpenRouter API key missing");
  const promptChars = messages.reduce((sum, message) => sum + String(message.content).length, 0);
  const estimateUsd = tokenCostUsd(price, Math.ceil(promptChars / 3) + 500, maxTokens);
  const reservationId = guard?.reserve({ key: `${metric}:${scope.caseId ?? scope.key ?? ""}`, model, estimateUsd });
  if (guard && !reservationId) throw new BudgetExceededError(`Budget cap reached before ${metric}`);
  let body;
  try {
    const response = await fetchImpl(OPENROUTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "X-Title": "docslurp-search-model-eval" },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0, response_format: { type: "json_object" }, usage: { include: true } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    try { body = JSON.parse(raw); } catch { body = null; }
    if (!response.ok || !body) throw new Error(`OpenRouter HTTP ${response.status}`);
  } catch (error) {
    if (guard) guard.reconcile(reservationId, { actualUsd: body?.usage?.cost ?? null, source: "openrouter-usage" });
    throw error;
  }
  const inputTokens = body.usage?.prompt_tokens ?? null;
  const outputTokens = body.usage?.completion_tokens ?? null;
  const reportedCost = Number.isFinite(body.usage?.cost) ? body.usage.cost : null;
  const costUsd = reportedCost ?? (inputTokens !== null ? tokenCostUsd(price, inputTokens, outputTokens) : null);
  const costSource = reportedCost !== null ? "openrouter-usage" : costUsd !== null ? "tokens-x-list-price" : "unknown";
  log(`[ai-usage] ${metric} model=${model} input_tokens=${inputTokens ?? 0} output_tokens=${outputTokens ?? 0}`);
  if (guard) guard.reconcile(reservationId, { actualUsd: costUsd, source: costSource });
  const entry = { at: new Date().toISOString(), metric, model, resolvedModel: body.model ?? null, generationId: body.id ?? null, inputTokens, outputTokens, costUsd, costSource, scope };
  if (ledgerPath) appendJsonl(ledgerPath, entry);
  const content = body.choices?.[0]?.message?.content ?? "";
  return { content, json: parseJsonContent(content), usage: entry };
}

export class BudgetExceededError extends Error {}

/** Parses a JSON object out of model text, tolerating code fences. */
export function parseJsonContent(content) {
  const text = String(content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch {} }
  return null;
}

// ---------------------------------------------------------------- statistics

export function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
export const mean = (values) => { const finite = values.filter(Number.isFinite); return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null; };
export const sum = (values) => values.filter(Number.isFinite).reduce((a, b) => a + b, 0);

/** Seeded percentile-bootstrap 95% CI of the mean. Null values are excluded. */
export function bootstrapCi(values, { seed = "bootstrap", iterations = 2000, alpha = 0.05 } = {}) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { n: 0, mean: null, low: null, high: null };
  const random = seededRandom(seed);
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < finite.length; j++) total += finite[Math.floor(random() * finite.length)];
    means.push(total / finite.length);
  }
  return { n: finite.length, mean: mean(finite), low: quantile(means, alpha / 2), high: quantile(means, 1 - alpha / 2) };
}

export const tokenize = (text) => new Set(normalize(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
export function jaccard(a, b) {
  const left = tokenize(a), right = tokenize(b);
  if (!left.size && !right.size) return 1;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}
