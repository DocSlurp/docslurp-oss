/**
 * Synthetic quality screening of the actual worker generation paths, not ingestion throughput.
 *
 * Eval-only harness. It calls the production graph extractor and, reflectively, the private
 * `generateSummary` / `atomizeParagraphs` methods, so the product prompts, output limits and model
 * routing are exercised unchanged. It adds no product API.
 *
 * Instrument contract (each item has a test in run.test.mts):
 *  - Every OpenRouter request is observed at the bottom of the fetch stack: status, latency, and the raw
 *    response text for successes and failures alike. A paid request outside an armed operation, to an
 *    unknown OpenRouter endpoint, for another model, or without an output cap is refused before it is sent.
 *  - Each ok receipt is read in either wire shape (Responses or Chat Completions), priced from the receipt
 *    itself via resolveOpenRouterUsage, and recorded through PipelineUsageEventLedger. Provider cost and
 *    ledger (marked-up) cost are kept apart. Receipts are cross-checked against the generation count the
 *    production path reported, so an operation cannot succeed with zero or missing calls.
 *  - Spend is checked before each operation and again before each request against a worst-case bound
 *    (request bytes >= tokens, output cap) in the units the DB budget query sums.
 *  - Raw envelopes are written before accounting. Accounting or persistence faults stop the run after the
 *    evidence is on disk.
 *  - Only `<split>/runner-inputs.json` and the source files it names are read. Label files are never opened.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { judgeIntegrity } from '../evaluation-integrity-judge.mjs';

type Json = Record<string, any>;

export const EXPERIMENT = 'extraction-quality-20261017';
/** $10 ceiling minus the $0.131995 acceptance exercise, rounded down. */
export const MAX_BUDGET_CENTS = 986;
/** AI SDK default: one try plus two retries. */
export const SDK_ATTEMPTS = 3;
/** Prompt scaffolding and entity hints on top of document text, bytes per call. */
const PROMPT_OVERHEAD_BYTES = 16_384;
export const OPERATIONS = ['graph', 'points', 'summary'] as const;
type Operation = (typeof OPERATIONS)[number];
const TEXT_OPERATION: Record<Operation, string> = { graph: 'graph-extraction', points: 'proposition-extraction', summary: 'document-summary' };
const BASE_MAX_OUTPUT: Record<Operation, number> = { graph: 0, points: 4096, summary: 512 };
const PAID_PATHS = new Set(['/api/v1/chat/completions', '/api/v1/responses']);

export class RunnerHalt extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'RunnerHalt'; }
}

// ---------------------------------------------------------------- arguments and model policy

const VALUE_FLAGS = ['--dataset', '--split', '--out', '--model', '--arm', '--org', '--workspace', '--user', '--budget-cents', '--limit', '--repeat', '--operations', '--generation', '--graph-config', '--graph-scope'];
const BOOLEAN_FLAGS = ['--confirm'];

/** Prohibited tiers: Pro/Ultra anywhere in the id, with any common delimiter (`gpt-x-pro:online`, `o3_pro`). */
export const PROHIBITED_MODEL = /(^|[-/_:.])(pro|ultra)($|[-/_:.])/i;

export function assertAllowedModel(model: string) {
  if (!/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._:-]+$/i.test(model)) throw new Error('Model must be a hosted OpenRouter id (vendor/model); private llm:// routes bypass this instrument');
  if (PROHIBITED_MODEL.test(model)) throw new Error('Pro/Ultra models prohibited');
}

export function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (BOOLEAN_FLAGS.includes(key)) { flags.add(key); continue; }
    if (!VALUE_FLAGS.includes(key)) throw new Error(`Unknown argument ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (values.has(key)) throw new Error(`Duplicate argument ${key}`);
    values.set(key, value);
    i++;
  }
  const need = (key: string) => { const value = values.get(key); if (!value) throw new Error(`Missing ${key}`); return value; };
  const split = need('--split');
  if (split !== 'development' && split !== 'heldout') throw new Error('--split must be development or heldout');
  if (split === 'heldout' && !flags.has('--confirm')) throw new Error('Held-out cases are scored once per frozen finalist; pass --confirm');
  if (split === 'development' && flags.has('--confirm')) throw new Error('--confirm applies to held-out runs only');
  const model = need('--model');
  assertAllowedModel(model);
  const arm = need('--arm');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(arm)) throw new Error('--arm must be a short file-safe label');
  const budgetCents = Number(values.get('--budget-cents') ?? MAX_BUDGET_CENTS);
  if (!Number.isFinite(budgetCents) || budgetCents <= 0 || budgetCents > MAX_BUDGET_CENTS) throw new Error(`--budget-cents must be in (0, ${MAX_BUDGET_CENTS}]`);
  const limit = Number(values.get('--limit') ?? 100);
  const repeat = Number(values.get('--repeat') ?? 1);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 2) throw new Error('--repeat must be 1 or 2');
  const operations = [...new Set((values.get('--operations') ?? 'graph,points,summary').split(',').map(op => op.trim()))] as Operation[];
  if (!operations.length || operations.some(op => !OPERATIONS.includes(op))) throw new Error('Unknown operation');
  const json = (key: string, fallback: string) => { try { return JSON.parse(values.get(key) ?? fallback) as Json; } catch { throw new Error(`${key} must be JSON`); } };
  return {
    dataset: resolve(need('--dataset')), destination: resolve(need('--out')), split, confirm: flags.has('--confirm'), model, arm,
    scope: { orgId: need('--org'), workspaceId: need('--workspace') }, userId: need('--user'),
    budgetCents, limit, repeat, operations,
    generation: json('--generation', '{}'), graphOverrides: json('--graph-config', '{}'), graphScope: values.get('--graph-scope') ?? 'Workspace documents',
  };
}

/** Live-catalog pricing for exactly this id; the output-price ceiling and sentinel prices fail closed. */
export function catalogPricing(catalog: Json, model: string) {
  const selected = catalog?.data?.find?.((m: Json) => m.id === model);
  const input = Number(selected?.pricing?.prompt);
  const output = Number(selected?.pricing?.completion);
  const valid = (n: number) => Number.isFinite(n) && n >= 0; // OpenRouter uses -1 for variable-priced routers.
  if (!selected || !valid(input) || !valid(output) || output * 1e6 >= 50) throw new Error('Model missing verified affordable pricing');
  return { inputPerToken: input, outputPerToken: output };
}

// ---------------------------------------------------------------- source identity and dataset

const GIT_IDENTITY_PATHS = ['worker/src', 'packages/shared/src', 'scripts/extraction-quality/run.mts'];

/** Identity of the core checkout the code under test is imported from; refuses uncommitted candidate or runner code. */
export function sourceIdentity(coreRoot: string) {
  const git = (...args: string[]) => execFileSync('git', ['-C', coreRoot, ...args], { encoding: 'utf8' }).trim();
  if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(coreRoot)) throw new Error('Runner is not inside its own core checkout');
  const dirty = git('status', '--porcelain=v1', '--untracked-files=all', '--', ...GIT_IDENTITY_PATHS);
  if (dirty) throw new Error(`Commit candidate and runner changes before measurement:\n${dirty}`);
  const [workerTree, sharedTree, runnerBlob] = git('rev-parse', ...GIT_IDENTITY_PATHS.map(path => `HEAD:${path}`)).split('\n');
  return { head: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), workerTree, sharedTree, runnerBlob };
}

const within = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

/** Reads the gold-free input list and the sources it names. Never opens label files. */
export async function loadInputs(dataset: string, split: string, limit: number) {
  const root = await realpath(dataset);
  const splitDir = resolve(root, split);
  const inputs = JSON.parse(await readFile(resolve(splitDir, 'runner-inputs.json'), 'utf8'));
  if (inputs.schema !== 'docslurp-extraction-quality-inputs@v1' || inputs.split !== split || !Array.isArray(inputs.cases) || !inputs.cases.length) throw new Error('Unsupported or mismatched runner-inputs.json');
  const manifest = JSON.parse(await readFile(resolve(root, 'integrity-manifest.json'), 'utf8'));
  const checked = new Map<string, string>(manifest.cases.map((c: Json) => [c.id, c.source?.sha256]));
  const cases = [];
  for (const entry of inputs.cases.slice(0, limit)) {
    if (!/^[a-z0-9-]{12,}$/.test(entry.id ?? '')) throw new Error('Invalid case id');
    if (typeof entry.source?.path !== 'string' || isAbsolute(entry.source.path)) throw new Error('Invalid source path');
    const file = await realpath(resolve(splitDir, entry.source.path));
    if (!within(splitDir, file)) throw new Error('Source outside split directory');
    const bytes = await readFile(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== entry.source.sha256) throw new Error('Source changed after dataset freeze');
    if (checked.get(entry.id) !== sha256) throw new Error('Source is not covered by the integrity-checked manifest');
    cases.push({ id: entry.id as string, text: bytes.toString('utf8'), sha256, bytes: bytes.length, pageSeparator: (entry.source.pageSeparator as string) || '\f' });
  }
  return cases;
}

/** Pages become paragraph-separated markdown for summary/points and one chunk per page for the graph. */
export function prepareText(text: string, pageSeparator: string) {
  const pages = text.split(pageSeparator);
  return { pages, document: pages.join('\n\n'), chunks: pages.map((chunk, i) => ({ id: `source-${i}`, text: chunk, pageNumber: i + 1 })) };
}

/** Mirrors PropositionIndexStage (paragraph filter and 3000-char batches); assertProductionSeams guards drift. */
export function pointBatches(document: string): string[][] {
  const paragraphs = document.split(/\n\n+/).map(p => p.trim()).filter(p => p.length >= 100);
  const batches: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    if (current.length > 0 && length + paragraph.length > 3000) { batches.push(current); current = []; length = 0; }
    current.push(paragraph);
    length += paragraph.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Fails closed when the production code this harness mirrors changes shape. */
export async function assertProductionSeams(coreRoot: string) {
  const expectations: Array<[string, string[]]> = [
    ['worker/src/stages/proposition-index.ts', ['.split(/\\n\\n+/)', 'p.length >= 100', 'batchParagraphs(paragraphs, 3000)', 'currentLen + p.length > maxChars', 'maxOutputTokens: 4096']],
    ['worker/src/stages/document-summary.ts', ['maxOutputTokens: 512']],
  ];
  for (const [file, needles] of expectations) {
    const source = await readFile(resolve(coreRoot, file), 'utf8');
    for (const needle of needles) if (!source.includes(needle)) throw new Error(`Production seam changed in ${file} (${needle}); repair harness and rebaseline`);
  }
}

// ---------------------------------------------------------------- receipts

export type Receipt =
  | { ok: true; id?: string; model?: string; provider?: string; shape: 'responses' | 'chat'; inputTokens: number; outputTokens: number; reasoningTokens: number; finishReason: string; truncated: boolean; usage: Json }
  | { ok: false; reason: string };

const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Reads a provider response body in either wire shape. Responses (the AI SDK default for `provider(model)`) has no `choices`. */
export function readReceipt(text: string): Receipt {
  let json: Json;
  try { json = JSON.parse(text); } catch { return { ok: false, reason: 'unparseable-json' }; }
  if (!json || typeof json !== 'object') return { ok: false, reason: 'unparseable-json' };
  if (json.error) return { ok: false, reason: 'provider-error-body' };
  const shape = Array.isArray(json.choices) ? 'chat' : Array.isArray(json.output) || json.object === 'response' ? 'responses' : undefined;
  if (!shape) return { ok: false, reason: 'unknown-shape' };
  const usage = json.usage;
  if (!usage || typeof usage !== 'object') return { ok: false, reason: 'missing-usage' };
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens;
  if (!count(inputTokens) || !count(outputTokens)) return { ok: false, reason: 'missing-token-counts' };
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const finishReason: string = shape === 'chat'
    ? json.choices[0]?.finish_reason ?? 'unknown'
    : json.status === 'completed' ? 'stop' : json.incomplete_details?.reason ?? json.status ?? 'unknown';
  const truncated = ['length', 'max_output_tokens', 'max_tokens'].includes(finishReason) || json.status === 'incomplete';
  return { ok: true, id: json.id, model: json.model, provider: typeof json.provider === 'string' ? json.provider : undefined, shape, inputTokens, outputTokens, reasoningTokens: count(reasoningTokens) ? reasoningTokens : 0, finishReason, truncated, usage };
}

// ---------------------------------------------------------------- request capture and pre-send guards

export interface CapturedRequest {
  seq: number; at: string; kind: 'paid' | 'free' | 'foreign' | 'blocked'; method: string; path: string;
  requestedModel?: string; maxOutputTokens?: number; reasoning?: unknown; requestKeys?: string[]; requestBytes?: number; requestSha256?: string; worstCaseLedgerCents?: number;
  status?: number; ok?: boolean; ms?: number; responseText?: string; readError?: string; networkError?: { name: string; message: string }; haltReason?: string;
}

export interface Arm { expectedModel: string; maxAttempts: number; roomLedgerCents: number; inputPerToken: number; outputPerToken: number; ledgerFactor: number }

/** Upper bound of one request in ledger units: tokens never exceed bytes, output never exceeds the requested cap. */
export const worstCaseLedgerCents = (bytes: number, maxOutputTokens: number, arm: Pick<Arm, 'inputPerToken' | 'outputPerToken' | 'ledgerFactor'>) =>
  (bytes * arm.inputPerToken + maxOutputTokens * arm.outputPerToken) * 100 * arm.ledgerFactor;

export function createReceiptCapture(baseFetch: typeof fetch, now: () => number = () => performance.now()) {
  let armed: Arm | null = null;
  let requests: CapturedRequest[] = [];
  let paidAttempts = 0;
  let committed = 0;
  let halted: string | null = null;
  let seq = 0;
  const refuse = (request: CapturedRequest, reason: string) => {
    halted ??= reason;
    request.kind = 'blocked';
    request.haltReason = reason;
    requests.push(request);
    return new RunnerHalt(reason);
  };

  const capturingFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const request: CapturedRequest = { seq: ++seq, at: new Date().toISOString(), kind: 'foreign', method, path: url.pathname };
    if (url.origin !== 'https://openrouter.ai') { request.kind = 'foreign'; request.path = `${url.origin}${url.pathname}`; requests.push(request); return baseFetch(input, init); }
    if (url.pathname === '/api/v1/generation' || url.pathname.startsWith('/api/v1/models')) {
      if (method !== 'GET') throw refuse(request, 'non-get-free-endpoint');
      request.kind = 'free'; // Accounting lookups cost nothing and are not part of the generation evidence.
      return baseFetch(input, init);
    }
    if (halted) throw refuse(request, halted);
    if (!PAID_PATHS.has(url.pathname) || method !== 'POST') throw refuse(request, `unexpected-openrouter-endpoint:${method} ${url.pathname}`);
    request.kind = 'paid';
    if (!armed) throw refuse(request, 'paid-request-outside-operation');
    if (typeof init?.body !== 'string') throw refuse(request, 'unverifiable-request-body');
    let body: Json;
    try { body = JSON.parse(init.body); } catch { throw refuse(request, 'unparseable-request-body'); }
    const maxOutputTokens = body.max_output_tokens ?? body.max_tokens ?? body.max_completion_tokens;
    const bytes = Buffer.byteLength(init.body);
    Object.assign(request, { requestedModel: body.model, maxOutputTokens, reasoning: body.reasoning ?? body.reasoning_effort, requestKeys: Object.keys(body).sort(), requestBytes: bytes, requestSha256: createHash('sha256').update(init.body).digest('hex') });
    if (body.model !== armed.expectedModel || PROHIBITED_MODEL.test(String(body.model))) throw refuse(request, `unexpected-request-model:${String(body.model)}`);
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) throw refuse(request, 'uncapped-output');
    if (paidAttempts >= armed.maxAttempts) throw refuse(request, 'attempt-allowance-exceeded');
    const worst = worstCaseLedgerCents(bytes, maxOutputTokens, armed);
    request.worstCaseLedgerCents = worst;
    if (committed + worst > armed.roomLedgerCents) throw refuse(request, 'budget-guard');
    // Every attempt reserves its worst case, including retries: a timed-out attempt may still have been billed.
    paidAttempts++;
    committed += worst;
    requests.push(request);

    const started = now();
    let response: Response;
    try { response = await baseFetch(input, init); } catch (error) {
      request.ms = now() - started;
      request.networkError = { name: (error as Error)?.name ?? 'Error', message: String((error as Error)?.message ?? error) };
      throw error;
    }
    request.status = response.status;
    request.ok = response.ok;
    try { request.responseText = await response.clone().text(); } catch (error) { request.readError = String((error as Error)?.message ?? error); }
    request.ms = now() - started;
    return response;
  };

  return {
    fetch: capturingFetch,
    get halted() { return halted; },
    arm(next: Arm) { armed = next; requests = []; paidAttempts = 0; committed = 0; },
    /** Ends the operation and hands over everything observed, including refused requests. */
    disarm() { armed = null; const taken = requests; requests = []; return taken; },
  };
}

// ---------------------------------------------------------------- accounting

export interface AccountingDeps {
  resolveUsage(args: { providerName?: string; generationId?: string; usage: { inputTokens: number; outputTokens: number; raw: unknown } }): Promise<{ inputTokens: number; outputTokens: number; costCents?: number; metadata?: Json }>;
  ledger: { record(input: Json): { costCents: number } | null; readonly pendingCount: number; checkpoint(): { events: Json[]; commit(): void } };
  persist(events: Json[]): Promise<number>;
  prices: { inputPerToken: number; outputPerToken: number };
}

export interface Accounting {
  attempts: number;
  failedAttempts: Array<{ seq: number; status?: number; reason: string }>;
  receipts: Array<{ seq: number; id?: string; servedModel?: string; routedProvider?: string; finishReason: string; truncated: boolean; inputTokens: number; outputTokens: number; reasoningTokens: number; providerCostCents: number; ledgerCostCents: number; costSource: string; estimated: boolean }>;
  unaccounted: Array<{ seq: number; reason: string }>;
  events: Json[];
  persisted: boolean;
  persistedCents: number;
  persistError?: string;
  inputTokens: number; outputTokens: number; reasoningTokens: number; providerCostCents: number; ledgerCostCents: number;
}

/** Prices every ok receipt, records it in the ledger and persists the batch. Faults are returned, never swallowed. */
export async function accountRequests(requests: CapturedRequest[], ctx: { operation: string; model: string; metadata: Json }, deps: AccountingDeps): Promise<Accounting> {
  const out: Accounting = { attempts: 0, failedAttempts: [], receipts: [], unaccounted: [], events: [], persisted: false, persistedCents: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, providerCostCents: 0, ledgerCostCents: 0 };
  for (const request of requests.filter(r => r.kind === 'paid')) {
    out.attempts++;
    if (request.networkError || request.ok === false) { out.failedAttempts.push({ seq: request.seq, status: request.status, reason: request.networkError?.name ?? `http-${request.status}` }); continue; }
    if (request.ok === undefined || request.responseText === undefined) { out.unaccounted.push({ seq: request.seq, reason: request.readError ? `unreadable-response:${request.readError}` : 'no-response' }); continue; }
    const receipt = readReceipt(request.responseText);
    if (!receipt.ok) {
      (receipt.reason === 'provider-error-body' ? out.failedAttempts : out.unaccounted).push({ seq: request.seq, reason: receipt.reason });
      continue;
    }
    let usage: Awaited<ReturnType<AccountingDeps['resolveUsage']>> | undefined;
    try { usage = await deps.resolveUsage({ providerName: receipt.provider, generationId: receipt.id, usage: { inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, raw: receipt.usage } }); } catch { /* fall through to the flagged catalog estimate */ }
    const inputTokens = usage?.inputTokens ?? receipt.inputTokens;
    const outputTokens = usage?.outputTokens ?? receipt.outputTokens;
    const estimated = usage?.costCents === undefined;
    const providerCostCents = usage?.costCents ?? (inputTokens * deps.prices.inputPerToken + outputTokens * deps.prices.outputPerToken) * 100;
    const costSource = estimated ? 'runner-catalog-estimate' : String(usage?.metadata?.costSource ?? 'provider');
    const event = deps.ledger.record({
      provider: 'openrouter', model: ctx.model, metric: `quality-${ctx.operation}`, amount: 1, unit: 'generation', inputTokens, outputTokens, costCents: providerCostCents,
      metadata: { ...usage?.metadata, ...ctx.metadata, ...(estimated ? { costSource, costReconciliationRequired: true } : {}), receiptId: receipt.id ?? null, servedModel: receipt.model ?? null, routedProvider: receipt.provider ?? null, finishReason: receipt.finishReason, reasoningTokens: receipt.reasoningTokens, rawInputTokens: receipt.inputTokens, rawOutputTokens: receipt.outputTokens, requestSeq: request.seq },
    });
    if (!event) { out.unaccounted.push({ seq: request.seq, reason: 'ledger-rejected-zero-usage' }); continue; }
    out.receipts.push({ seq: request.seq, id: receipt.id, servedModel: receipt.model, routedProvider: receipt.provider, finishReason: receipt.finishReason, truncated: receipt.truncated, inputTokens, outputTokens, reasoningTokens: receipt.reasoningTokens, providerCostCents, ledgerCostCents: event.costCents, costSource, estimated });
    out.inputTokens += inputTokens; out.outputTokens += outputTokens; out.reasoningTokens += receipt.reasoningTokens;
    out.providerCostCents += providerCostCents; out.ledgerCostCents += event.costCents;
  }
  if (deps.ledger.pendingCount > 0) {
    const checkpoint = deps.ledger.checkpoint();
    out.events = checkpoint.events;
    try { out.persistedCents = await deps.persist(checkpoint.events); checkpoint.commit(); out.persisted = true; }
    catch (error) { out.persistError = String((error as Error)?.message ?? error).slice(0, 500); }
  }
  return out;
}

/** Cross-checks receipts against what the production path itself reported. Problems stop the run; warnings are recorded. */
export function reconcile(acc: Accounting, expected: { generations: number; inputTokens: number; outputTokens: number }, plannedCalls: number) {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const item of acc.unaccounted) problems.push(`unaccounted-receipt:${item.reason}`);
  if (acc.persistError) problems.push(`persistence-failed:${acc.persistError}`);
  else if (acc.persisted && Math.abs(acc.persistedCents - acc.ledgerCostCents) > 1e-6) problems.push(`persisted-cost-mismatch:${acc.persistedCents}!=${acc.ledgerCostCents}`);
  if (acc.receipts.some(r => r.estimated)) problems.push('estimated-cost-needs-reconciliation');
  if (plannedCalls > 0 && acc.attempts === 0 && expected.generations === 0) problems.push('no-provider-call-observed');
  if (acc.receipts.length < expected.generations) problems.push(`missed-calls:reported=${expected.generations},receipts=${acc.receipts.length}`);
  const orphanReceipts = Math.max(0, acc.receipts.length - expected.generations);
  if (orphanReceipts) warnings.push(`billed-but-unreported-generations:${orphanReceipts}`);
  else if (acc.inputTokens !== expected.inputTokens || acc.outputTokens !== expected.outputTokens) warnings.push(`token-mismatch:reported=${expected.inputTokens}/${expected.outputTokens},receipts=${acc.inputTokens}/${acc.outputTokens}`);
  return { problems, warnings, orphanReceipts };
}

// ---------------------------------------------------------------- outputs

/** Scorer input (docslurp-extraction-quality-outputs@v1). Requested-but-failed artifacts are empty; unrequested ones are omitted. */
export function scorerOutputs(records: Json[], meta: { runId: string; split: string; repetition: number; operations: string[] }) {
  const cases: Json = {};
  for (const record of records.filter(r => r.repetition === meta.repetition)) {
    const entry: Json = {};
    if (meta.operations.includes('graph')) entry.graph = record.graph ? { entities: record.graph.entities, relationships: record.graph.relationships } : { entities: [], relationships: [] };
    if (meta.operations.includes('points')) entry.keyPoints = record.keyPoints;
    if (meta.operations.includes('summary')) entry.summary = record.summary;
    cases[record.id] = entry;
  }
  return { schema: 'docslurp-extraction-quality-outputs@v1', runId: meta.runId, split: meta.split, cases };
}

export function describeError(error: unknown, secret?: string) {
  const scrub = (value: unknown) => { const text = String(value ?? ''); return (secret ? text.split(secret).join('[redacted]') : text).slice(0, 4000); };
  const e = error as Json;
  return { name: e?.name ?? 'UnknownError', message: scrub(e?.message ?? error), statusCode: e?.statusCode, responseBody: e?.responseBody === undefined ? undefined : scrub(e.responseBody), reason: e?.reason };
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (within(coreRoot, args.destination)) throw new Error('--out must be outside the repository');
  const identity = sourceIdentity(coreRoot);
  const runnerSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
  await mkdir(args.destination, { recursive: false });
  const write = (name: string, value: unknown) => writeFile(resolve(args.destination, name), JSON.stringify(value, null, 2));

  // Source text only. The integrity judge reads labels in its own scan; this runner never opens them.
  const integrity = judgeIntegrity({ dataset: args.dataset, repo: coreRoot, base: 'HEAD' });
  await write('integrity.json', integrity);
  if (!integrity.passed) throw new Error('Integrity screening failed; inspect separately before any provider call');
  const cases = await loadInputs(args.dataset, args.split, args.limit);

  const catalogResponse = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) });
  if (!catalogResponse.ok) throw new Error('Cannot verify live model pricing');
  const prices = catalogPricing(await catalogResponse.json() as Json, args.model);

  const shared = await import('../../packages/shared/src/index.ts');
  const { fromEnv } = await import('../../worker/src/config.ts');
  const config = fromEnv();
  const apiKey = config.openRouterApiKey;
  if (!apiKey) throw new Error('Missing OpenRouter key');
  if (shared.resolveSupportedModelIdWithWarning(args.model) !== args.model) throw new Error('Model id is deprecated and would be substituted at call time; use the replacement id');
  // Workspace-style config, validated the way a pipeline would be. The arm's model comes from --model only.
  const generation = shared.textGenerationConfigSchema.strict().parse(args.generation) as import('../../packages/shared/src/index.ts').TextGenerationConfig;
  if (generation.model || Object.keys(generation.models).length) throw new Error('Set the model with --model, not in --generation');
  const graphConfig = shared.graphConfigSchema.strict().parse({ ...shared.defaultGraphConfig, ...args.graphOverrides });
  await assertProductionSeams(coreRoot);
  const ledgerFactor = Math.max(1, Number(shared.priceAiUsageEvent({ provider: 'openrouter', model: args.model, metric: 'probe', amount: 0, unit: 'generation', costCents: 1, inputTokens: 0, outputTokens: 0, metadata: {} } as never).costCents) || 1);

  const { extractDocumentGraph, buildExtractionWindows } = await import('../../worker/src/graph/extract.ts');
  const { DocumentSummaryStage } = await import('../../worker/src/stages/document-summary.ts');
  const { PropositionIndexStage } = await import('../../worker/src/stages/proposition-index.ts');
  const { PipelineUsageEventLedger } = await import('../../worker/src/pipeline/usage-ledger.ts');
  const { persistScopedUsageEvents } = await import('../../worker/src/db/usage-event-store.ts');
  const { assertCanSpend } = await import('../../server/src/services/billing/spend-guard.ts');
  const { attributedUsage } = await import('../../server/src/services/usage-attribution.ts');
  const { sql } = await import('../../server/src/db.ts');
  const { env: serverEnv } = await import('../../server/src/config.ts');

  // Private seams are called reflectively, eval-only. No substitute prompt is used.
  const summaryStage = new DocumentSummaryStage(undefined as never, undefined as never, config);
  const pointStage = new PropositionIndexStage(undefined as never, undefined as never, config);
  const summaryMethod = Reflect.get(summaryStage, 'generateSummary');
  const pointMethod = Reflect.get(pointStage, 'atomizeParagraphs');
  if (typeof summaryMethod !== 'function' || typeof pointMethod !== 'function') throw new Error('Worker generation seam changed; repair harness and rebaseline');

  const database = (() => { try { const u = new URL(serverEnv.databaseUrl); return { host: u.host, name: u.pathname.slice(1) }; } catch { return null; } })();
  const runId = `${EXPERIMENT}/${args.arm}/${new Date().toISOString()}`;
  await write('run.json', {
    at: new Date().toISOString(), runId, experiment: EXPERIMENT, arm: args.arm, split: args.split, source: identity, runnerSha256, model: args.model, generation, graphConfig, graphScope: args.graphScope,
    operations: args.operations, repeat: args.repeat, limit: args.limit, datasetHash: integrity.datasetHash, productionHash: integrity.productionHash, runtime: process.version, database,
    deployment: { textGenerationProfile: config.textGenerationProfile ?? null, textGenerationModelEnv: config.textGenerationModel ?? null },
    pricing: { inputPerMillion: prices.inputPerToken * 1e6, outputPerMillion: prices.outputPerToken * 1e6, ledgerFactor }, scope: args.scope, budgetCents: args.budgetCents,
    boundary: 'worker generation only; excludes ingestion, embeddings and storage',
    deviations: ['graph chunks are source pages, not ingestion chunks', 'summary and points read pages joined by blank lines, not extracted markdown', 'privacyMode standard, no PII gate, no pipeline checkpointing', 'ledger plan is null (no plan credit factor)'],
  });

  const capture = createReceiptCapture(globalThis.fetch);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = capture.fetch;

  const records: Json[] = [];
  const runStart = Date.now();
  let abortReason: string | undefined;
  let unpersistedLedgerCents = 0;
  const totals = { attempts: 0, receipts: 0, orphanReceipts: 0, failedAttempts: 0, providerCostCents: 0, ledgerCostCents: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, estimatedReceipts: 0 };
  const statusCounts: Record<string, Record<string, number>> = {};
  const flush = async () => {
    await write('records.json', records);
    for (let repetition = 0; repetition < args.repeat; repetition++) await write(`outputs-r${repetition}.json`, scorerOutputs(records, { runId, split: args.split, repetition, operations: args.operations }));
  };

  async function dbSpendCents() {
    const [row] = await sql`select coalesce(sum(cost_cents),0)::double precision as cents from ${attributedUsage(null, sql)} au where org_id=${args.scope.orgId} and metadata->>'experiment'=${EXPERIMENT}`;
    return Number(row!.cents) + unpersistedLedgerCents;
  }

  async function runOperation(operation: Operation, entry: (typeof cases)[number], repetition: number, record: Json) {
    const prepared = prepareText(entry.text, entry.pageSeparator);
    const settings = shared.resolvePipelineTextGenerationOptions({ operation: TEXT_OPERATION[operation] as never, config: generation, deploymentProfile: config.textGenerationProfile, maxOutputTokens: operation === 'graph' ? shared.graphDepthProfiles[graphConfig.depth].maxOutputTokens : BASE_MAX_OUTPUT[operation] });
    const batches = operation === 'points' ? pointBatches(prepared.document) : [];
    const windows = operation === 'graph' ? buildExtractionWindows(prepared.chunks.map(c => c.text), shared.graphDepthProfiles[graphConfig.depth].windowChars, shared.graphDepthProfiles[graphConfig.depth].windows) : [];
    const inputs = operation === 'graph' ? windows : operation === 'points' ? batches.map(b => b.join('\n\n')) : [prepared.document];
    const plannedCalls = operation === 'summary' ? 1 : inputs.length;
    const bytes = inputs.reduce((sum, text) => sum + Buffer.byteLength(text), 0) + plannedCalls * PROMPT_OVERHEAD_BYTES;
    const arm = { expectedModel: args.model, maxAttempts: plannedCalls * SDK_ATTEMPTS, roomLedgerCents: 0, inputPerToken: prices.inputPerToken, outputPerToken: prices.outputPerToken, ledgerFactor };
    const plannedWorst = worstCaseLedgerCents(bytes, settings.maxOutputTokens * plannedCalls, arm);
    const spent = await dbSpendCents();
    if (spent + plannedWorst >= args.budgetCents) throw new RunnerHalt(`budget-reservation:spent=${spent.toFixed(4)},planned=${plannedWorst.toFixed(4)},cap=${args.budgetCents}`);
    await assertCanSpend(args.scope.orgId, args.scope.workspaceId, { hold: false });

    arm.roomLedgerCents = args.budgetCents - spent;
    capture.arm(arm);
    const ledger = new PipelineUsageEventLedger();
    const failures: Json[] = [];
    const reported: Array<{ inputTokens: number; outputTokens: number; finishReason?: string; window?: number }> = [];
    const started = performance.now();
    try {
      if (operation === 'graph') {
        const graph = await extractDocumentGraph({
          filename: 'document.txt', chunks: prepared.chunks,
          context: { config: graphConfig, scope: args.graphScope, model: args.model, apiKey, useLlm: true, privacyMode: 'standard', textGeneration: generation, deploymentProfile: config.textGenerationProfile, onUsage: (usage, details) => reported.push({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, finishReason: details.finishReason, window: details.window }) },
        });
        const names = new Map(graph.nodes.map(n => [n.key, n.canonicalName]));
        record.graph = {
          entities: graph.nodes.map(n => ({ id: n.key, name: n.canonicalName, type: n.entityType, aliases: n.aliases })),
          relationships: graph.edges.filter(e => e.normalizedPredicate !== 'comentions' && e.normalizedPredicate !== 'co_mentions').map(e => ({ source: names.get(e.sourceKey), predicate: e.predicate, target: names.get(e.targetKey) })),
          source: graph.source, windowsPlanned: plannedCalls, windowsParsed: graph.windows, windowsReported: reported.length,
        };
      } else if (operation === 'summary') {
        const result = await summaryMethod.call(summaryStage, prepared.document, args.model, 'standard', undefined, generation);
        reported.push({ inputTokens: result.inputTokens, outputTokens: result.outputTokens });
        record.summary = result.text;
      } else {
        record.pointSources = [];
        record.filteredParagraphs = prepared.document.split(/\n\n+/).filter(p => p.trim() && p.trim().length < 100).length;
        for (const [index, group] of batches.entries()) {
          if (capture.halted) break;
          try {
            const result = await pointMethod.call(pointStage, group, args.model, 'standard', undefined, generation);
            reported.push({ inputTokens: result.inputTokens, outputTokens: result.outputTokens });
            result.groups.forEach((points: string[], i: number) => {
              for (const point of points.map(p => p.trim()).filter(Boolean)) { record.keyPoints.push(point); record.pointSources.push({ point, sourceParagraph: group[i] }); }
            });
          } catch (error) { failures.push({ batch: index, ...describeError(error, apiKey) }); }
        }
      }
    } catch (error) { failures.push(describeError(error, apiKey)); }
    const generationMs = performance.now() - started;
    const requests = capture.disarm();
    // Evidence first: an accounting or database outage cannot erase receipts.
    await write(`${entry.id}-${repetition}-${operation}-raw.json`, { operation, model: args.model, generationMs, plannedCalls, haltReason: capture.halted, failures, requests });

    const accountingStarted = performance.now();
    const accounting = await accountRequests(requests, { operation, model: args.model, metadata: { experiment: EXPERIMENT, arm: args.arm, operation, caseId: entry.id, repetition, split: args.split, source: identity.head, runnerSha256 } }, {
      resolveUsage: usage => shared.resolveOpenRouterUsage({ apiKey, model: args.model, providerName: usage.providerName, generationId: usage.generationId, usage: usage.usage }),
      ledger, prices,
      persist: events => persistScopedUsageEvents({ client: sql, userId: args.userId, scope: args.scope, usageEvents: events as never, debitMetadata: { experiment: EXPERIMENT, arm: args.arm } }),
    });
    const accountingMs = performance.now() - accountingStarted;
    if (accounting.events.length) await write(`${entry.id}-${repetition}-${operation}-ledger.json`, { persisted: accounting.persisted, persistError: accounting.persistError, events: accounting.events });
    if (!accounting.persisted) unpersistedLedgerCents += accounting.ledgerCostCents;

    const expected = reported.reduce((sum, r) => ({ generations: sum.generations + 1, inputTokens: sum.inputTokens + r.inputTokens, outputTokens: sum.outputTokens + r.outputTokens }), { generations: 0, inputTokens: 0, outputTokens: 0 });
    const { problems, warnings, orphanReceipts } = reconcile(accounting, expected, plannedCalls);
    if (capture.halted) problems.push(`guard:${capture.halted}`);

    let status = 'ok';
    let reason: string | undefined;
    if (plannedCalls === 0) { status = 'no-input'; reason = 'no text reached a model call'; }
    else if (!accounting.receipts.length) { status = 'failed'; reason = failures[0]?.name ?? (accounting.failedAttempts[0]?.reason ?? 'no-successful-generation'); }
    else if (operation === 'graph' && record.graph?.source === 'heuristic') { status = 'fallback'; reason = 'every window failed to parse or call; heuristic graph'; }
    else if (failures.length || (operation === 'graph' && (record.graph?.windowsParsed ?? 0) < plannedCalls)) { status = 'partial'; reason = failures[0]?.name ?? 'window-not-parsed'; }
    else if (operation === 'summary' && !String(record.summary).trim()) { status = 'empty'; reason = 'blank summary'; }
    else if (operation === 'points' && !record.keyPoints.length) { status = 'empty'; reason = 'no key points'; }
    if (status === 'ok' && accounting.receipts.some(r => r.truncated)) { status = 'partial'; reason = 'truncated-generation'; }

    const stage = {
      status, reason, generationMs, accountingMs, plannedCalls, attempts: accounting.attempts, okReceipts: accounting.receipts.length, failedAttempts: accounting.failedAttempts, orphanReceipts,
      finishReasons: accounting.receipts.map(r => r.finishReason), truncated: accounting.receipts.some(r => r.truncated), receipts: accounting.receipts,
      usage: { inputTokens: accounting.inputTokens, outputTokens: accounting.outputTokens, reasoningTokens: accounting.reasoningTokens, providerCostCents: accounting.providerCostCents, ledgerCostCents: accounting.ledgerCostCents },
      persisted: accounting.persisted, failures, warnings, problems,
    };
    totals.attempts += accounting.attempts; totals.receipts += accounting.receipts.length; totals.orphanReceipts += orphanReceipts; totals.failedAttempts += accounting.failedAttempts.length;
    totals.providerCostCents += accounting.providerCostCents; totals.ledgerCostCents += accounting.ledgerCostCents; totals.inputTokens += accounting.inputTokens; totals.outputTokens += accounting.outputTokens; totals.reasoningTokens += accounting.reasoningTokens;
    totals.estimatedReceipts += accounting.receipts.filter(r => r.estimated).length;
    (statusCounts[operation] ??= {})[status] = (statusCounts[operation]![status] ?? 0) + 1;
    return stage;
  }

  try {
    outer: for (let repetition = 0; repetition < args.repeat; repetition++) for (const entry of cases) {
      const record: Json = { id: entry.id, repetition, sourceSha256: entry.sha256, bytes: entry.bytes, graph: null, keyPoints: [], pointSources: [], summary: '', stages: {} };
      records.push(record);
      for (const operation of args.operations) {
        try {
          const stage = await runOperation(operation, entry, repetition, record);
          record.stages[operation] = stage;
          if (stage.problems.length) abortReason = `${operation}:${stage.problems.join(',')}`;
        } catch (error) {
          capture.disarm();
          record.stages[operation] = { status: 'aborted', failures: [describeError(error, apiKey)] };
          abortReason = error instanceof RunnerHalt ? error.reason : `${operation}:${describeError(error, apiKey).name}`;
        }
        await flush();
        if (abortReason) break outer;
      }
      // Held-out detail stays in the output files; the console carries aggregates only.
      if (args.split === 'development') console.log(JSON.stringify({ arm: args.arm, caseId: entry.id, repetition, stages: Object.fromEntries(Object.entries(record.stages).map(([op, s]: [string, any]) => [op, { status: s.status, ms: Math.round(s.generationMs ?? 0), receipts: s.okReceipts, ledgerCents: s.usage?.ledgerCostCents }])) }));
    }
  } finally {
    globalThis.fetch = originalFetch;
    const graphOps = records.filter(r => r.stages.graph).length;
    await write('summary.json', { status: abortReason ? 'aborted' : 'complete', abortReason, runId, split: args.split, cases: new Set(records.map(r => r.id)).size, records: records.length, wallMs: Date.now() - runStart, statusCounts, graphFallbackRate: graphOps ? (statusCounts.graph?.fallback ?? 0) / graphOps : null, unpersistedLedgerCents, totals });
    if (args.split === 'heldout') console.log(JSON.stringify({ arm: args.arm, split: 'heldout', status: abortReason ? 'aborted' : 'complete', records: records.length, statusCounts, totals }));
    await sql.end({ timeout: 2 });
  }
  if (abortReason) { process.exitCode = 1; console.error(`Aborted: ${abortReason}`); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
