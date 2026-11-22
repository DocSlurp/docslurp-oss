/**
 * Shared plumbing for the summary-tree phase-0 eval: environment, spend
 * ledger, embedding cache and the document builder. Evaluation tooling only.
 *
 * Environment (all required unless noted):
 *   SUMMARY_TREE_EVAL_ROOT   external eval root (sources/, sealed/, artifacts/, cache/); never inside a repository
 *   SUMMARY_TREE_EVAL_OUT    scratch output directory (raw responses, ledger)
 *   SUMMARY_TREE_EVAL_ENV    env file to read the provider key from (only OPENROUTER_API_KEY is read)
 *   SUMMARY_TREE_EVAL_CAP_USD  hard spend cap for the ledger (default 3.5)
 *   DATABASE_URL             a throwaway local database (seed/arms only)
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultPipelineFeatures, resolveEmbeddingRoute, DEFAULT_PIPELINE_TEXT_MODEL } from "../../packages/shared/dist/index.js";
import { buildCanonicalChunksFromDocument, buildCanonicalDocumentFromMarkdown } from "../../worker/src/lib/canonical-document.js";
import { leafHash, type Leaf } from "./grouping-standin.mts";
import type { SourceEntry } from "./prepare-sources.mts";

export const need = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
export const ROOT = () => need("SUMMARY_TREE_EVAL_ROOT");
export const OUT = () => { const dir = need("SUMMARY_TREE_EVAL_OUT"); mkdirSync(dir, { recursive: true }); return dir; };
export const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const readJson = <T,>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
export const TEXT_MODEL = DEFAULT_PIPELINE_TEXT_MODEL;
export const FALLBACK_TEXT_MODEL = "openai/gpt-oss-120b";
export const EMBEDDING = defaultPipelineFeatures.embedding;
export const EMBEDDING_ROUTE = resolveEmbeddingRoute(EMBEDDING);
export const ORG = "stevalorg", USER = "steval-user", PROJECT = "steval-project", RUN = "steval-run";

/** Provider list prices in USD per 1M tokens, checked live on the run date; see the report for the source. */
export const LIST_PRICE: Record<string, { input: number; output: number }> = {
  [TEXT_MODEL]: { input: 0.065, output: 0.26 },
  [EMBEDDING_ROUTE.model]: { input: 0.004, output: 0 },
  // The product's own fallback when the default model's hosts are not allowed; used here only for provider content refusals.
  [FALLBACK_TEXT_MODEL]: { input: 0.04, output: 0.19 },
};

export function loadProviderKey(): void {
  if (process.env.OPENROUTER_API_KEY) return;
  const line = readFileSync(need("SUMMARY_TREE_EVAL_ENV"), "utf8").split("\n").find((row) => row.startsWith("OPENROUTER_API_KEY="));
  if (!line) throw new Error("OPENROUTER_API_KEY not found");
  process.env.OPENROUTER_API_KEY = line.slice("OPENROUTER_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

type LedgerRow = { at: string; step: string; model: string; inputTokens: number; outputTokens: number; usd: number; reportedUsd?: number };
const ledgerPath = () => join(OUT(), "ledger.jsonl");
export const ledgerRows = (): LedgerRow[] => existsSync(ledgerPath()) ? readFileSync(ledgerPath(), "utf8").trim().split("\n").filter(Boolean).map((row) => JSON.parse(row) as LedgerRow) : [];
export const ledgerTotal = () => ledgerRows().reduce((sum, row) => sum + Math.max(row.usd, row.reportedUsd ?? 0), 0);
let spent: number | null = null;
/** Throws before a paid call once the cap is reached. */
export function assertBudget(): void {
  spent ??= ledgerTotal();
  const cap = Number(process.env.SUMMARY_TREE_EVAL_CAP_USD ?? 3.5);
  if (spent >= cap) throw new Error(`Spend cap reached: ${spent.toFixed(4)} of ${cap} USD`);
}
export function recordSpend(step: string, model: string, inputTokens: number, outputTokens: number, reportedCents?: number): number {
  const price = LIST_PRICE[model];
  if (!price) throw new Error(`No list price recorded for ${model}`);
  const usd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
  const row: LedgerRow = { at: new Date().toISOString(), step, model, inputTokens, outputTokens, usd, ...(reportedCents !== undefined ? { reportedUsd: reportedCents / 100 } : {}) };
  appendFileSync(ledgerPath(), JSON.stringify(row) + "\n");
  spent = (spent ?? ledgerTotal() - Math.max(usd, row.reportedUsd ?? 0)) + Math.max(usd, row.reportedUsd ?? 0);
  console.log(`[ai-usage] ${step} model=${model} input_tokens=${inputTokens}${outputTokens ? ` output_tokens=${outputTokens}` : ""}`);
  return usd;
}

/** Vectors by sha256(model, task, text), so an unchanged input is never paid for twice. */
export class VectorCache {
  private readonly dir: string;
  private readonly known = new Map<string, Float32Array>();
  constructor(private readonly scope: string) { this.dir = join(ROOT(), "cache", "vectors"); mkdirSync(this.dir, { recursive: true }); this.load(); }
  private file() { return join(this.dir, `${this.scope}.jsonl`); }
  private load() {
    if (!existsSync(this.file())) return;
    for (const line of readFileSync(this.file(), "utf8").split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      // Copy out of the Buffer: small Buffers share a pooled ArrayBuffer, so its bytes start at byteOffset.
      const bytes = Buffer.from(line.slice(tab + 1), "base64");
      this.known.set(line.slice(0, tab), new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    }
  }
  key(text: string) { return sha(`${this.scope}\n${text}`); }
  get(text: string) { return this.known.get(this.key(text)); }
  set(text: string, vector: ArrayLike<number>) {
    const value = Float32Array.from(vector as ArrayLike<number>);
    this.known.set(this.key(text), value);
    appendFileSync(this.file(), `${this.key(text)}\t${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64")}\n`);
  }
}

/**
 * Worker provider calls read a per-job provider policy and fail closed (restricted hosts) outside one. A project's
 * default policy allows every host of the default text model, so the eval runs under that default.
 */
async function withProviderPolicy<T>(allowAllHosts: boolean, fn: () => Promise<T>): Promise<T> {
  const { runWithProviderRateScope } = await import("../../worker/src/lib/provider-rate-limit.js");
  return runWithProviderRateScope({ orgId: null, allowChinaProviders: allowAllHosts }, fn);
}
const withDefaultProviderPolicy = <T,>(fn: () => Promise<T>) => withProviderPolicy(true, fn);

/** The default model's host refused the output on content grounds (seen on historical fiction). */
export const isContentRefusal = (error: unknown) => /inappropriate content/i.test(`${(error as Error)?.message ?? ""} ${(error as { responseBody?: string })?.responseBody ?? ""} ${JSON.stringify((error as { cause?: { value?: unknown } })?.cause?.value ?? "")}`);

let workerConfig: unknown;
async function config() {
  if (!workerConfig) { loadProviderKey(); workerConfig = (await import("../../worker/src/config.js")).fromEnv(); }
  return workerConfig as never;
}

/** Document-task vectors through the worker's own embedding call, cached. */
export async function embedDocuments(texts: string[], step: string): Promise<Float32Array[]> {
  const cache = new VectorCache(`doc-${EMBEDDING_ROUTE.model.replaceAll("/", "_")}`);
  const missing = [...new Set(texts.filter((text) => !cache.get(text)))];
  if (missing.length) {
    const [{ embedTextChunks }, { resolveEmbeddingModel }] = await Promise.all([import("../../worker/src/stages/embedding-runtime.js"), import("../../worker/src/embeddings/resolver.js")]);
    const cfg = await config();
    const profile = { ...resolveEmbeddingModel(cfg, defaultPipelineFeatures as never), batchSize: 128 };
    for (let at = 0; at < missing.length; at += 2048) {
      assertBudget();
      const batch = missing.slice(at, at + 2048);
      let tokens = 0;
      const result = await embedTextChunks({ chunks: batch, profile, config: cfg, privacyMode: "standard", batchConcurrency: 4, onRemoteUsage: async (usage) => { tokens += usage.inputTokens; } });
      recordSpend(step, EMBEDDING_ROUTE.model, tokens, 0);
      result.vectors.forEach((vector, i) => cache.set(batch[i]!, vector));
    }
  }
  return texts.map((text) => cache.get(text)!);
}

export type Generated = { text: string; finishReason: string; inputTokens: number; outputTokens: number; ms: number; model: string };
/**
 * One text call on the default model. `restrictedHosts` routes it the way the product does for a project that
 * disallows the default model's hosts (its built-in fallback model); callers use it only after a content refusal.
 */
export async function generate(step: string, system: string, prompt: string, maxOutputTokens: number, options: { restrictedHosts?: boolean } = {}): Promise<Generated> {
  assertBudget();
  const { generateOpenRouterText } = await import("../../worker/src/lib/ai.js");
  await config();
  const started = Date.now();
  const result = await withProviderPolicy(!options.restrictedHosts, () => generateOpenRouterText({
    operation: "document-summary", apiKey: process.env.OPENROUTER_API_KEY!, privacyMode: "standard", model: TEXT_MODEL, maxOutputTokens,
    textGeneration: { model: null, models: {}, reasoningEfforts: { "document-summary": "none" }, maxOutputTokens: { "document-summary": maxOutputTokens } } as never,
    system, prompt,
  }));
  const served = String((result.usage as { metadata?: { routedModel?: string } }).metadata?.routedModel ?? TEXT_MODEL);
  const expected = options.restrictedHosts ? FALLBACK_TEXT_MODEL : TEXT_MODEL;
  if (served !== expected) throw new Error(`Served by ${served}, expected ${expected}; results would not be comparable`);
  const inputTokens = result.usage.inputTokens ?? 0, outputTokens = result.usage.outputTokens ?? 0;
  recordSpend(step, served, inputTokens, outputTokens, (result.usage as { costCents?: number }).costCents);
  return { text: result.text, finishReason: result.finishReason, inputTokens, outputTokens, ms: Date.now() - started, model: served };
}

/** `generate`, and on a provider content refusal one more call through the product's restricted-host fallback route. */
export async function generateWithRefusalFallback(step: string, system: string, prompt: string, maxOutputTokens: number): Promise<Generated & { refused: boolean }> {
  try { return { ...(await generate(step, system, prompt, maxOutputTokens)), refused: false }; }
  catch (error) {
    if (!isContentRefusal(error)) throw error;
    console.log(`[content-refusal] ${step}: default model's host refused; using the restricted-host fallback route`);
    return { ...(await generate(`${step}:refusal-fallback`, system, prompt, maxOutputTokens, { restrictedHosts: true })), refused: true };
  }
}

export type EvalChunk = {
  id: string; index: number; text: string; rawText: string; tokenEstimate: number; headingPath: string[];
  pageNumber: number | null; pageNumbers: number[]; metadata: Record<string, unknown>; vector: number[];
};
export type EvalDocument = { id: string; title: string; filename: string; pages: number; text: string; chunks: EvalChunk[]; documentContext: string };

export const loadManifest = (path: string) => readJson<{ sources: SourceEntry[] }>(path);
export const sourceText = (id: string) => readFileSync(join(ROOT(), "sources", `${id}.md`), "utf8");

/**
 * Chunks a prepared source exactly as the embed stage does (canonical blocks,
 * default pipeline chunking, contextual preamble), then embeds. `text`
 * overrides the stored source for version-pair variants.
 */
export async function buildDocument(entry: Pick<SourceEntry, "id" | "title">, options: { text?: string; documentId?: string; hostedContext?: boolean; step: string }): Promise<EvalDocument> {
  const documentId = options.documentId ?? entry.id;
  const text = options.text ?? sourceText(entry.id);
  const pages = text.split("\f").length;
  const filename = `${entry.title}.md`;
  const canonical = buildCanonicalDocumentFromMarkdown({ documentId, text, pageCount: pages, extractor: "eval-prepared-markdown" });
  const drafts = buildCanonicalChunksFromDocument(canonical, filename, { chunkOverlap: defaultPipelineFeatures.chunkOverlap });
  const { contextualizeChunksForEmbedding, resolveDocumentContext } = await import("../../worker/src/stages/embedding-runtime.js");
  const cfg = await config();
  // One short hosted call per document, as the default pipeline makes; cached by document text so variants reuse it.
  const contextCache = join(ROOT(), "cache", "document-context"); mkdirSync(contextCache, { recursive: true });
  const contextFile = join(contextCache, `${entry.id}.json`);
  let documentContext: { summary: string; usage?: { inputTokens?: number; outputTokens?: number; source?: string } };
  if (existsSync(contextFile)) documentContext = readJson(contextFile);
  else if (options.hostedContext === false) documentContext = { summary: "" };
  else {
    assertBudget();
    documentContext = await withDefaultProviderPolicy(() => resolveDocumentContext({ privacyMode: "standard", documentTitle: filename, documentText: text, config: cfg }));
    if (documentContext.usage?.source === "openrouter") recordSpend(`${options.step}:document-context`, TEXT_MODEL, documentContext.usage.inputTokens ?? 0, documentContext.usage.outputTokens ?? 0);
    writeFileSync(contextFile, JSON.stringify(documentContext));
  }
  const contextualized = await contextualizeChunksForEmbedding({
    privacyMode: "standard", documentTitle: filename, documentText: text, config: cfg, documentContext: documentContext as never,
    chunks: drafts.map((chunk) => ({ text: chunk.text, headingPath: chunk.headingPath, pageNumber: chunk.pageNumber, pageNumbers: chunk.pageNumbers })),
  });
  const vectors = await embedDocuments(contextualized.chunks.map((chunk) => chunk.text), `${options.step}:embed`);
  const chunks = drafts.map<EvalChunk>((chunk, index) => {
    const own = contextualized.chunks[index]!;
    return {
      id: `${documentId}-${index.toString().padStart(3, "0")}`, index, text: own.text, rawText: own.rawText, tokenEstimate: Math.ceil(own.text.length / 4),
      headingPath: chunk.headingPath, pageNumber: chunk.pageNumber, pageNumbers: chunk.pageNumbers, vector: Array.from(vectors[index]!),
      metadata: {
        documentId, source: "eval-prepared-markdown", headingPath: chunk.headingPath, pageNumber: chunk.pageNumber, pageNumbers: chunk.pageNumbers,
        blockIds: chunk.blockIds, blockTypes: chunk.blockTypes, evidenceType: chunk.evidenceType, tableGranularity: chunk.tableGranularity ?? null,
        locator: chunk.locator ?? null, overlapIndex: chunk.overlapIndex ?? 0, rawText: own.rawText, contextPreamble: own.contextPreamble,
        sourceTrace: { canonicalDocumentUri: null, parserArtifactUri: null, sourceArtifactUri: null, blockIds: chunk.blockIds, pageNumbers: chunk.pageNumbers, extractor: "eval-prepared-markdown" },
      },
    };
  });
  return { id: documentId, title: entry.title, filename, pages, text, chunks, documentContext: documentContext.summary };
}

/** Leaves per the plan: no overlap chunks, no row or cell table chunks. */
export function leavesOf(document: EvalDocument): { leaves: Leaf[]; chunks: EvalChunk[] } {
  const chunks = document.chunks.filter((chunk) => (chunk.metadata.overlapIndex ?? 0) === 0 && !["row", "cell"].includes(String(chunk.metadata.tableGranularity ?? "")));
  return { chunks, leaves: chunks.map((chunk) => ({ index: chunk.index, hash: leafHash(chunk.rawText), headingPath: chunk.headingPath, pageNumbers: chunk.pageNumbers })) };
}

export const artifactPath = (id: string) => { const dir = join(ROOT(), "artifacts"); mkdirSync(dir, { recursive: true }); return join(dir, `${id}.chunks.json`); };
export function loadDocument(id: string): EvalDocument { return readJson<EvalDocument>(artifactPath(id)); }
