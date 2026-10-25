import { delimitedTableMarkdown } from "../lib/delimited-table.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { withObservation, aiResultDetails, instrumentFetch } from "@docslurp/shared/observability";
import { isUtf8 } from "node:buffer";
import path from "node:path";

import type { CanonicalDocument } from "@docslurp/shared";
import { localEmbeddingPooling, type EmbeddingPooling, assertProviderAllowed, authorizePrivateModelCall, textModelCallDescriptor, canonicalDocumentSchema, DEEPINFRA_EMBEDDING_BASE_URL, validateDeepInfraEmbedding, fitEmbeddingDimensions, openRouterEmbeddingRoute, validateHostedEmbeddingVector, OPENROUTER_BASE_URL, PRIVATE_MODEL_PROVIDER, isProviderCallAllowed, resolvePipelineTextModel, createOpenRouterRoutingFetch, type PrivacyMode, type TextGenerationConfig } from "@docslurp/shared";
import { embedMany } from "ai";
import { embedPerplexity } from "@docslurp/shared";
import { noteWorkProgress, withRequestTimeout } from "../lib/work-progress.js";
import { runWithProviderRateLimit } from "../lib/provider-rate-limit.js";
import { createSerialQueue, runBounded, type ConcurrencyLimiter } from "../lib/bounded-concurrency.js";
import { ProviderRetryableError, providerLimiter, toProviderRetryableError } from "../lib/provider-retry.js";
import { createOpenAI, openai } from "@ai-sdk/openai";

import type { Config } from "../config.js";
import { canonicalDocumentToText } from "../lib/canonical-document.js";
import { generateOpenRouterText } from "../lib/ai.js";
import { textModelApiKey, textUsageLabels } from "../lib/text-model-route.js";
import { buildTrustedDocumentTaskPrompt } from "../lib/trusted-llm-task.js";
import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import type { Document, EmbeddingProfile } from "../models.js";
import { chunkTextWithMeta } from "../pipeline/chunking.js";
import type { CommandRunner } from "../tools/runner.js";
import { localEmbeddingThreadEnabled, sharedLocalEmbeddingPool } from "./local-embedding-thread.js";
import { stripLeadingFrontmatter } from "../lib/markdown-structure.js";
import {
  type ArtifactStore,
  cleanupTempFile,
  keyFromStorageUri,
} from "../tools/storage.js";
export interface EmbeddingChunk {
  id: string;
  index: number;
  text: string;
  tokenEstimate: number;
  vector: number[];
  headingPath?: string[];
  pageNumber?: number | null;
  pageNumbers?: number[];
  blockIds?: string[];
  blockTypes?: string[];
  evidenceType?: string | null;
  canonicalDocumentUri?: string | null;
  tableGranularity?: string | null;
  tableRowIndex?: number | null;
  tableRowCount?: number | null;
  tableColumnNames?: string[];
  tableColumnTypes?: string[];
  tableCells?: Array<Record<string, unknown>>;
  tableCell?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

export interface EmbeddingArtifact {
  documentId: string;
  embedding: EmbeddingProfile;
  vectorBackends: string[];
  chunking: string;
  source: Record<string, unknown>;
  chunks: EmbeddingChunk[];
  usage?: Record<string, unknown>;
  runtime: Record<string, unknown>;
}

export interface VectorBackendRecord {
  id: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  vector: number[];
  metadata: Record<string, unknown>;
  /** LanceDB hydration columns (@docslurp/shared/lancedb-hydration); other backends ignore them. */
  runId?: string;
  pageNumber?: number;
  hydration?: string;
}

const DEFAULT_LOCAL_TRANSFORMERSJS_DTYPE = "q8";
const localEmbeddingPipelineCache = new Map<
  string,
  Promise<LocalEmbeddingPipelineCacheEntry>
>();

type LocalEmbeddingPipeline = (
  input: string | string[],
  options?: Record<string, unknown>,
) => Promise<{
  tolist?: () => unknown;
  data?: ArrayLike<number>;
  dims?: number[];
}>;

type LocalEmbeddingPipelineFactory = (
  task: "feature-extraction",
  model: string,
  options?: Record<string, unknown>,
) => Promise<LocalEmbeddingPipeline>;

interface LocalEmbeddingPipelineCacheEntry {
  pipeline: LocalEmbeddingPipeline;
  dtype: string;
}

export interface JsonSchemaArtifact {
  documentId: string;
  keys: Record<string, string[]>;
}

export interface ContextualChunkDraft {
  text: string;
  headingPath?: string[];
  pageNumber?: number | null;
  pageNumbers?: number[];
}

export interface ContextualizedChunk {
  rawText: string;
  text: string;
  contextPreamble: string;
}

export interface ContextualChunkUsage {
  costCents?: number;
  metadata?: Record<string, unknown>;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** `reused`: the document context came from a prior embedding artifact; no model call. */
  source: "heuristic" | "anthropic" | "openrouter" | "private" | "reused";
}

const CONTEXTUAL_CHUNK_SUMMARY_LIMIT = 240;
const CONTEXTUAL_SOURCE_LIMIT = 12_000;

export async function extractTextForEmbedding(
  document: Document,
  runner: CommandRunner,
  storage: ArtifactStore,
  markdownArtifactUri?: string,
  signal?: AbortSignal,
  canonicalArtifactUri?: string,
): Promise<{
  text: string;
  extractor: string;
  schemaArtifact?: JsonSchemaArtifact;
  canonicalDocument?: CanonicalDocument;
}> {
  const canonicalDocument = canonicalArtifactUri
    ? await readCanonicalDocumentArtifact(storage, canonicalArtifactUri)
    : undefined;
  const artifactText = markdownArtifactUri
    ? await readExtractedMarkdown(storage, markdownArtifactUri)
    : null;
  const canonicalText = canonicalDocument
    ? canonicalDocumentToText(canonicalDocument)
    : null;
  if (artifactText) {
    return {
      text: artifactText,
      extractor: "extract-markdown-artifact",
      canonicalDocument,
    };
  }

  if (canonicalText) {
    return {
      text: canonicalText,
      extractor: "canonical-document-artifact",
      canonicalDocument,
    };
  }

  if (isCsvLike(document)) {
    const data = await storage.getBytes(document.sourceKey);
    const text = delimitedTableMarkdown(data.toString("utf8"), document.filename);
    return { text, extractor: "csv-to-markdown-table", canonicalDocument };
  }

  if (isJsonLike(document)) {
    const data = await storage.getBytes(document.sourceKey);
    if (isUtf8(data)) {
      const raw = data.toString("utf8");
      const result = parseJsonContent(raw, document);
      return { ...result, canonicalDocument };
    }
  }

  if (isTextLike(document)) {
    const data = await storage.getBytes(document.sourceKey);
    if (isUtf8(data)) {
      return {
        text: data.toString("utf8"),
        extractor: "raw-text",
        canonicalDocument,
      };
    }
  }

  const tempFile = await storage.downloadToTempFile(
    document.sourceKey,
    trustedTempDownloadPattern("docslurp-source-", document),
  );

  try {
    const isPdf =
      path.extname(document.filename).toLowerCase() === ".pdf" ||
      document.mimeType.toLowerCase().includes("pdf");

    if (isPdf) {
      try {
        const result = await runner.run(
          await runner.extractText(tempFile),
          signal,
        );
        if (result.stdout.trim()) {
          return {
            text: result.stdout,
            extractor: "pdftotext",
            canonicalDocument,
          };
        }
      } catch {
        // Fall through to the next extractor.
      }
    }

    try {
      const result = await runner.run(
        await runner.extractMarkdown(tempFile),
        signal,
      );
      if (result.stdout.trim()) {
        return { text: result.stdout, extractor: "pandoc", canonicalDocument };
      }
    } catch {
      // Fall through to raw bytes.
    }

    const bytes = await storage.getBytes(document.sourceKey);
    if (isUtf8(bytes)) {
      return {
        text: bytes.toString("utf8"),
        extractor: "raw-bytes",
        canonicalDocument,
      };
    }
  } finally {
    await cleanupTempFile(tempFile);
  }

  throw new Error(`no extractor produced text for ${document.filename}`);
}

async function readExtractedMarkdown(
  storage: ArtifactStore,
  artifactUri: string,
): Promise<string | null> {
  try {
    const key = artifactUri.replace(/^s3:\/\/[^/]+\//, "");
    const data = await storage.getBytes(key);
    if (!isUtf8(data)) {
      return null;
    }

    const raw = data.toString("utf8");
    if (!artifactUri.endsWith(".json")) {
      return raw;
    }

    const parsed = JSON.parse(raw) as { textArtifactUri?: string };
    if (!parsed.textArtifactUri) {
      return null;
    }

    const nestedKey = parsed.textArtifactUri.replace(/^s3:\/\/[^/]+\//, "");
    const nestedBytes = await storage.getBytes(nestedKey);
    return isUtf8(nestedBytes) ? nestedBytes.toString("utf8") : null;
  } catch {
    return null;
  }
}

async function readCanonicalDocumentArtifact(
  storage: ArtifactStore,
  artifactUri: string,
): Promise<CanonicalDocument | undefined> {
  try {
    const key = keyFromStorageUri(artifactUri, storage.bucket);
    if (!key) {
      return undefined;
    }

    const parsed = canonicalDocumentSchema.safeParse(
      await storage.getJson(key),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function buildChunks(
  text: string,
  fallback: string,
  options?: { chunkOverlap?: boolean },
): { texts: string[]; headingPaths: string[][] } {
  const overlapOpts = options?.chunkOverlap
    ? { overlapFraction: 0.5 }
    : undefined;
  const metas = [...chunkTextWithMeta(text, 1800, overlapOpts)];
  if (metas.length === 0) {
    return { texts: [fallback], headingPaths: [[]] };
  }
  return {
    texts: metas.map((m) => m.text),
    headingPaths: metas.map((m) => m.headingPath),
  };
}

export function estimateTokens(text: string): number {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return words === 0 ? 0 : Math.floor(words * 1.3);
}

/** Per-batch usage for remote routes. Private routes also carry the operator-priced cost. */
export interface RemoteEmbeddingUsage {
  inputTokens: number;
  chunks: number;
  costCents?: number;
  costMetadata?: Record<string, unknown>;
}

export async function embedTextChunks(args: {
  onRemoteUsage?: (usage: RemoteEmbeddingUsage) => Promise<void>;
  /**
   * Remote routes only: batches in flight at once (default 1, serial). Usage
   * callbacks still run one at a time; after one throws no new batch starts.
   */
  batchConcurrency?: number;
  /** Remote routes only: a slot pool shared with other callers (e.g. sibling windows). */
  batchLimiter?: ConcurrencyLimiter;
  /**
   * Remote routes only: runs once a batch holds its slot, before the request
   * is sent. Throw to stop (e.g. a reached cost cap), so batches queued behind
   * the limiter are never sent after the caller has decided to stop.
   */
  beforeBatch?: () => void | Promise<void>;
  chunks: string[];
  profile: EmbeddingProfile;
  config: Config;
  /** Workspace privacy mode; hosted embedding routes are refused outside `standard`. */
  privacyMode: PrivacyMode;
  signal?: AbortSignal;
  runner?: CommandRunner;
  onBatchComplete?: (progress: {
    completed: number;
    total: number;
    batchSize: number;
    durationMs: number;
    rssBytes: number;
  }) => Promise<void> | void;
}): Promise<{
  vectors: number[][];
  usage: Record<string, unknown>;
  totalTokens?: number;
  /** Set for private routes: sum of operator-priced batch costs. */
  costCents?: number;
}> {
  // Embedding is required work with no local substitute at this point, so a
  // hosted route under local-only/strict-privacy fails the document closed.
  assertProviderAllowed(args.privacyMode, {
    provider: args.profile.provider,
    model: args.profile.model,
    operation: "worker.embedding",
    target: args.profile.target,
    modelUri: args.profile.modelUri,
    capability: "embedding",
    baseUrl: args.profile.provider === PRIVATE_MODEL_PROVIDER ? args.profile.baseUrl : undefined,
  });
  if (args.profile.runtime === "remote") {
    return await embedRemoteChunks(args);
  }

  return await embedLocalChunks(args);
}

export type DocumentContext = { summary: string; usage?: ContextualChunkUsage };

/**
 * The one-sentence document context that prefixes every chunk's embedding
 * input: a reused summary, a hosted-model summary, or the local heuristic.
 * Never rejects; provider failures fall back to the heuristic.
 */
export async function resolveDocumentContext(args: {
  textGeneration?: TextGenerationConfig;
  privacyMode: PrivacyMode;
  documentTitle: string;
  documentText: string;
  config: Config;
  signal?: AbortSignal;
  reusedDocumentContext?: string;
}): Promise<DocumentContext> {
  return args.reusedDocumentContext
    ? {
        summary: args.reusedDocumentContext,
        usage: { provider: "reused", model: "document-context", inputTokens: 0, outputTokens: 0, source: "reused" as const },
      }
    : await buildDocumentContextSummary({
        textGeneration: args.textGeneration,
        privacyMode: args.privacyMode,
        documentTitle: args.documentTitle,
        documentText: args.documentText,
        config: args.config,
        signal: args.signal,
      });
}

export async function contextualizeChunksForEmbedding(args: {
  textGeneration?: TextGenerationConfig;
  /** Outside `standard`, preambles use the local heuristic instead of a hosted model. */
  privacyMode: PrivacyMode;
  documentTitle: string;
  documentText: string;
  chunks: ContextualChunkDraft[];
  config: Config;
  signal?: AbortSignal;
  /** A previously generated document context for the same title, text and model (embedding reuse). */
  reusedDocumentContext?: string;
  /** Already resolved (see resolveDocumentContext); skips the summary call. */
  documentContext?: DocumentContext;
}): Promise<{ chunks: ContextualizedChunk[]; usage?: ContextualChunkUsage; documentContext: string }> {
  const context = args.documentContext ?? await resolveDocumentContext(args);

  return {
    chunks: args.chunks.map((chunk) => {
      const rawText = chunk.text.trim();
      const contextPreamble = buildChunkContextPreamble({
        documentTitle: args.documentTitle,
        documentContext: context.summary,
        headingPath: chunk.headingPath,
        pageNumber: chunk.pageNumber,
        pageNumbers: chunk.pageNumbers,
      });

      return {
        rawText,
        contextPreamble,
        text: contextPreamble ? `${contextPreamble}\n\n${rawText}` : rawText,
      };
    }),
    usage: context.usage,
    documentContext: context.summary,
  };
}

function isCsvLike(document: Document): boolean {
  const ext = path.extname(document.filename).toLowerCase();
  return ext === ".csv" || ext === ".tsv" || document.mimeType === "text/csv";
}

function isJsonLike(document: Document): boolean {
  const ext = path.extname(document.filename).toLowerCase();
  const mime = document.mimeType.toLowerCase();
  return (ext === ".json" || ext === ".jsonl") && mime.includes("json");
}

function parseJsonContent(
  raw: string,
  document: Document,
): { text: string; extractor: string; schemaArtifact?: JsonSchemaArtifact } {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const isJsonl =
    lines.length > 1 &&
    lines.every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    });

  const schemaKeys: Record<string, Set<string>> = {};

  function trackType(key: string, value: unknown): void {
    if (!schemaKeys[key]) schemaKeys[key] = new Set();
    if (value === null) schemaKeys[key].add("null");
    else if (Array.isArray(value)) schemaKeys[key].add("array");
    else schemaKeys[key].add(typeof value);
  }

  if (isJsonl) {
    const textLines: string[] = [];
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const pairs: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        pairs.push(`${k}: ${String(v)}`);
        trackType(k, v);
      }
      textLines.push(pairs.join(", "));
    }
    const schemaArtifact = buildSchemaArtifact(document.id, schemaKeys);
    return {
      text: textLines.join("\n"),
      extractor: "jsonl-flatten",
      schemaArtifact,
    };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const flatLines: string[] = [];
    flattenJson(parsed, "", flatLines, schemaKeys);
    const schemaArtifact = buildSchemaArtifact(document.id, schemaKeys);
    return {
      text: flatLines.join("\n"),
      extractor: "json-flatten",
      schemaArtifact,
    };
  } catch {
    return { text: raw, extractor: "raw-text" };
  }
}

function flattenJson(
  value: unknown,
  prefix: string,
  out: string[],
  schemaKeys: Record<string, Set<string>>,
): void {
  if (value === null || value === undefined) {
    const key = prefix || "(root)";
    out.push(`${key}: null`);
    if (schemaKeys) {
      if (!schemaKeys[key]) schemaKeys[key] = new Set();
      schemaKeys[key].add("null");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (prefix) {
      if (!schemaKeys[prefix]) schemaKeys[prefix] = new Set();
      schemaKeys[prefix].add("array");
    }
    for (let i = 0; i < value.length; i++) {
      flattenJson(
        value[i],
        prefix ? `${prefix}[${i}]` : `[${i}]`,
        out,
        schemaKeys,
      );
    }
    return;
  }
  if (typeof value === "object") {
    if (prefix) {
      if (!schemaKeys[prefix]) schemaKeys[prefix] = new Set();
      schemaKeys[prefix].add("object");
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenJson(v, prefix ? `${prefix}.${k}` : k, out, schemaKeys);
    }
    return;
  }
  const key = prefix || "(root)";
  out.push(`${key}: ${String(value)}`);
  if (!schemaKeys[key]) schemaKeys[key] = new Set();
  schemaKeys[key].add(typeof value);
}

function buildSchemaArtifact(
  documentId: string,
  schemaKeys: Record<string, Set<string>>,
): JsonSchemaArtifact {
  const keys: Record<string, string[]> = {};
  for (const [k, types] of Object.entries(schemaKeys)) {
    keys[k] = [...types];
  }
  return { documentId, keys };
}

function isTextLike(document: Document): boolean {
  const mime = document.mimeType.toLowerCase();
  const ext = path.extname(document.filename).toLowerCase();
  return (
    mime.startsWith("text/") ||
    [".md", ".txt", ".json", ".jsonl", ".csv"].includes(ext)
  );
}

/** Pre-call estimate for the fleet TPM bucket (about 4 characters per token); settled with actual usage. */
export function estimateEmbeddingTokens(batch: string[]): number {
  let characters = 0;
  for (const text of batch) characters += text.length;
  return Math.max(1, Math.ceil(characters / 4));
}

/** 429/5xx, or an AI SDK error it marks retryable (network failures). */
function classifyEmbeddingError(error: unknown, provider: string): ProviderRetryableError | null {
  const byStatus = toProviderRetryableError(error, provider, "embedding request");
  if (byStatus) return byStatus;
  const retryable = Boolean(error && typeof error === "object" && (error as { isRetryable?: unknown }).isRetryable === true);
  if (!retryable) return null;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderRetryableError(`embedding request failed: ${message}`.slice(0, 500), provider, null, null, 1);
}

function embeddingMaxRetries(): number {
  const parsed = Number.parseInt(process.env.AI_PROVIDER_MAX_RETRIES ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 4;
}

async function embedRemoteChunks(args: {
  onRemoteUsage?: (usage: RemoteEmbeddingUsage) => Promise<void>;
  batchConcurrency?: number;
  batchLimiter?: ConcurrencyLimiter;
  beforeBatch?: () => void | Promise<void>;
  chunks: string[];
  profile: EmbeddingProfile;
  config: Config;
  privacyMode: PrivacyMode;
  signal?: AbortSignal;
}) {
  const isPrivate = args.profile.provider === PRIVATE_MODEL_PROVIDER;
  const isNativePerplexity = args.profile.provider === "perplexity";
  const sharedModel = isPrivate || isNativePerplexity ? null : createRemoteEmbeddingModel(args.profile, args.config);
  let privateCostCents = 0;
  const providerOptions = remoteEmbeddingProviderOptions(args.profile);

  const registeredRoute = args.profile.provider === "openrouter" ? openRouterEmbeddingRoute(args.profile.model) : null;
  const batchSize = clampBatchSize(args.profile.batchSize ?? 32, 1, registeredRoute?.batchSize ?? (isNativePerplexity ? 128 : 256));
  // The hosted endpoint caps the sum at 120,000 tokens. UTF-8 bytes plus
  // tokenizer overhead are a conservative admission bound, never billed usage.
  const batches = packEmbeddingBatches(args.chunks, batchSize, registeredRoute || isNativePerplexity ? 120_000 : undefined);
  const batchCount = batches.length;
  const batchEmbeddings: number[][][] = new Array(batchCount);
  const usageBatches: Record<string, unknown>[] = new Array(batchCount);
  let actualTokens = 0;
  // Usage persists in completion order, one callback at a time, so the ledger
  // and the cost-cap check see a consistent running total.
  const serialUsage = createSerialQueue();

  const embedBatch = async (batchIndex: number): Promise<void> => {
    if (args.signal?.aborted) {
      throw args.signal.reason instanceof Error
        ? args.signal.reason
        : new Error("aborted");
    }
    await args.beforeBatch?.();

    const batch = batches[batchIndex]!;
    // Private routes authorize (and, under strict-privacy, audit) every request.
    const privateCall = isPrivate
      ? await authorizePrivateModelCall({ privacyMode: args.privacyMode, modelUri: args.profile.modelUri, capability: "embedding", operation: "worker.embedding" })
      : null;
    const model = privateCall
      ? createOpenAI({ apiKey: "private-endpoint", baseURL: privateCall.baseUrl, fetch: instrumentFetch("private", "embedding", privateCall.fetch) }).embedding(privateCall.model) as any
      : sharedModel;
    const batchStartedAt = Date.now();
    const result = await withObservation(
      {
        name: "worker.embedding.batch",
        type: "embedding",
        model: args.profile.model,
        input: batch,
        metadata: { chunks: batch.length, provider: args.profile.provider },
        result: aiResultDetails,
      },
      () =>
        // Reserve fleet-wide TPM first, then a process concurrency slot. Retries
        // live here (not in the AI SDK) so every 429 feeds the fleet's AIMD
        // factor and Retry-After pause; exhausted retries fail retryably.
        runWithProviderRateLimit({
          provider: args.profile.provider,
          model: args.profile.model,
          tokens: estimateEmbeddingTokens(batch),
          label: "embedding request",
          signal: args.signal,
          maxRetries: embeddingMaxRetries(),
          classify: (error) => classifyEmbeddingError(error, args.profile.provider),
          actualTokens: (result) => result.usage.tokens,
        }, () =>
          providerLimiter.run(`embeddings:${args.profile.provider}`, () =>
            isNativePerplexity ? embedPerplexity({
              fetch: instrumentFetch("perplexity", "embedding"),
              model: args.profile.model,
              dimensions: args.profile.dimensions,
              apiKey: args.config.perplexityApiKey ?? "",
              values: batch,
              normalize: args.profile.normalize,
              signal: withRequestTimeout(args.signal),
              onUsage: tokens => serialUsage(async () => args.onRemoteUsage?.({ inputTokens: tokens, chunks: batch.length })),
            }) : embedMany({
              model,
              values: batch,
              maxParallelCalls: 2,
              maxRetries: 0,
              // Bounded per request (WORKER_AI_REQUEST_TIMEOUT_MS).
              abortSignal: withRequestTimeout(args.signal),
              providerOptions,
            }), args.signal)),
    );
    noteWorkProgress("embeddings");
    const privateCost = privateCall
      ? privateCall.cost({ inputTokens: result.usage.tokens ?? 0, durationMs: Date.now() - batchStartedAt })
      : null;
    if (privateCost) privateCostCents += privateCost.costCents;
    if (args.profile.provider === "deepinfra" && (!Number.isSafeInteger(result.usage.tokens) || result.usage.tokens! < 0)) throw new Error("DeepInfra embeddings require actual provider token usage");
    // Persist actual paid usage before retaining vectors or starting another request.
    if (!isNativePerplexity && typeof result.usage.tokens === "number") {
      const tokens = result.usage.tokens;
      await serialUsage(async () => args.onRemoteUsage?.({ inputTokens: tokens, chunks: batch.length,
        ...(privateCost ? { costCents: privateCost.costCents, costMetadata: privateCost.metadata } : {}) }));
    }
    if (args.profile.provider === "openrouter") {
      if (!Number.isSafeInteger(result.usage.tokens) || !(result.usage.tokens! > 0)) throw new Error("OpenRouter embedding response omitted actual usage");
      if (result.embeddings.length !== batch.length) throw new Error("OpenRouter embedding response omitted vectors");
      const route = openRouterEmbeddingRoute(args.profile.model);
      batchEmbeddings[batchIndex] = result.embeddings.map(vector => validateHostedEmbeddingVector(vector, route.dimensions, args.profile.normalize));
    } else if (args.profile.provider === "deepinfra") {
      if (result.embeddings.length !== batch.length) throw new Error("DeepInfra embedding response count mismatch");
      batchEmbeddings[batchIndex] = result.embeddings.map((vector) => validateDeepInfraEmbedding(vector, args.profile.dimensions, args.profile.normalize));
    } else {
      // Longer Matryoshka vectors are still shortened below; anything that
      // cannot be fitted to the requested size is rejected after usage is journaled.
      if (args.profile.provider === "openai" && args.profile.supportsCustomDimensions && (result.embeddings.length !== batch.length
        || result.embeddings.some((vector) => vector.length < args.profile.dimensions || vector.some((value) => !Number.isFinite(value)) || !(Math.hypot(...vector) > 0) || !Number.isFinite(Math.hypot(...vector))))) {
        throw new Error("OpenAI embedding response must match requested dimensions with finite nonzero vectors");
      }
      batchEmbeddings[batchIndex] = result.embeddings;
    }

    const usage = serializeJson(result.usage);
    usageBatches[batchIndex] = {
      batchIndex: batchIndex + 1,
      chunks: batch.length,
      usage,
    };
    const tokens = typeof usage.tokens === "number" ? usage.tokens : undefined;
    if (tokens) {
      actualTokens += tokens;
    }
  };

  const limiter = args.batchLimiter;
  await runBounded(
    batchCount,
    Math.max(1, args.batchConcurrency ?? 1),
    (batchIndex) => limiter ? limiter.run(() => embedBatch(batchIndex)) : embedBatch(batchIndex),
  );
  const embeddings = batchEmbeddings.flat();

  return {
    vectors: args.profile.provider === "openrouter" || isNativePerplexity ? embeddings : embeddings.map((vector) =>
      fitEmbeddingDimensions(vector, args.profile.dimensions, args.profile.normalize),
    ),
    usage: {
      runtime: "remote",
      provider: args.profile.provider,
      model: args.profile.model,
      batchSize,
      batches: usageBatches,
      tokens: actualTokens || undefined,
    },
    totalTokens: actualTokens || undefined,
    ...(isPrivate ? { costCents: privateCostCents } : {}),
  };
}

/**
 * Cost of an embedding call recorded after the fact: private routes report
 * their operator-priced cost, other remote routes use the configured per-1K
 * rate, and local runtimes cost nothing.
 */
export function embeddingCallCostCents(
  profile: Pick<EmbeddingProfile, "runtime">,
  embedded: { costCents?: number },
  tokens: number,
  costPer1kInputTokens: number,
): number {
  if (embedded.costCents !== undefined) return embedded.costCents;
  return profile.runtime === "remote" ? (tokens / 1000) * costPer1kInputTokens : 0;
}

async function embedLocalChunks(args: {
  chunks: string[];
  profile: EmbeddingProfile;
  config: Config;
  signal?: AbortSignal;
  runner?: CommandRunner;
  onBatchComplete?: (progress: {
    completed: number;
    total: number;
    batchSize: number;
    durationMs: number;
    rssBytes: number;
  }) => Promise<void> | void;
}) {
  return withObservation(
    {
      name: "worker.embedding.local",
      type: "embedding",
      model: args.profile.model,
      input: args.chunks,
      metadata: { chunks: args.chunks.length, runtime: "local" },
    },
    async () => {
      if (args.signal?.aborted) {
        throw args.signal.reason instanceof Error
          ? args.signal.reason
          : new Error("aborted");
      }

      const runner = await localEmbeddingBatchRunner(args.profile.model, args.profile.normalize, args.signal, localEmbeddingPooling(args.profile.modelUri));
      let runMsTotal = 0;
      const inferenceStartedAt = Date.now();
      const minBatchSize = Math.max(
        1,
        Number(process.env.DOCSLURP_EMBED_MIN_BATCH_SIZE ?? 4),
      );
      const maxBatchSize = Math.max(
        minBatchSize,
        Number(process.env.DOCSLURP_EMBED_MAX_BATCH_SIZE ?? 96),
      );
      let batchSize = clampBatchSize(
        args.profile.batchSize ?? 32,
        minBatchSize,
        maxBatchSize,
      );
      const vectors: number[][] = new Array(args.chunks.length);
      // Batches are padded to their longest text, so mixing short and long chunks wastes
      // compute on padding. Embedding in length order (and restoring input order
      // below) packs similar lengths together; vectors are unchanged up to float noise.
      const order = args.chunks.map((_, i) => i);
      if (sortByLengthEnabled()) order.sort((a, b) => args.chunks[a]!.length - args.chunks[b]!.length);

      for (let index = 0; index < args.chunks.length;) {
        if (args.signal?.aborted) {
          throw args.signal.reason instanceof Error
            ? args.signal.reason
            : new Error("aborted");
        }

        const ids = order.slice(index, index + batchSize);
        const batch = ids.map((i) => args.chunks[i]!);
        const output = await runner.run(batch);
        runMsTotal += output.runMs;
        readEmbeddingVectors(output, batch.length).forEach((vector, k) => {
          vectors[ids[k]!] = fitEmbeddingDimensions(vector, args.profile.dimensions, args.profile.normalize);
        });
        index += batch.length;

        // The thread's own inference time: wall time here would also count queueing behind
        // other documents and model loads, and make the tuner shrink batches for no reason.
        const durationMs = output.runMs;
        const rssBytes = process.memoryUsage().rss;
        await args.onBatchComplete?.({
          completed: index,
          total: args.chunks.length,
          batchSize,
          durationMs,
          rssBytes,
        });

        batchSize = tuneLocalEmbeddingBatchSize({
          current: batchSize,
          min: minBatchSize,
          max: maxBatchSize,
          durationMs,
          rssBytes,
        });
      }

      const estimatedTokens = args.chunks.reduce(
        (sum, chunk) => sum + estimateTokens(chunk),
        0,
      );

      return {
        vectors,
        usage: {
          runtime: "local",
          provider: "transformers.js",
          model: args.profile.model,
          cache_hit: runner.cacheHit,
          model_load_ms: runner.stats.loadMs,
          inference_ms: Date.now() - inferenceStartedAt,
          inference_run_ms: runMsTotal,
          dtype: runner.dtype(),
          inference_thread: runner.thread,
          estimated_tokens: estimatedTokens,
        },
        totalTokens: estimatedTokens,
      };
    },
  );
}

/** DOCSLURP_EMBED_SORT_BY_LENGTH=on embeds local batches in length order (opt-in: q8 vectors shift up to ~1.4% cosine with batch composition, so enabling it needs a retrieval-quality check). */
function sortByLengthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["on", "true", "1", "yes"].includes((env.DOCSLURP_EMBED_SORT_BY_LENGTH ?? "off").trim().toLowerCase());
}

function clampBatchSize(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function tuneLocalEmbeddingBatchSize(args: {
  current: number;
  min: number;
  max: number;
  durationMs: number;
  rssBytes: number;
}): number {
  const rssLimitMb = Number(process.env.DOCSLURP_EMBED_RSS_LIMIT_MB ?? 4096);
  const rssLimitBytes = rssLimitMb * 1024 * 1024;
  const slowBatchMs = Number(process.env.DOCSLURP_EMBED_SLOW_BATCH_MS ?? 12_000);
  const fastBatchMs = Number(process.env.DOCSLURP_EMBED_FAST_BATCH_MS ?? 2_000);

  if (args.durationMs > slowBatchMs || args.rssBytes > rssLimitBytes) {
    return clampBatchSize(Math.ceil(args.current / 2), args.min, args.max);
  }

  if (args.durationMs < fastBatchMs && args.rssBytes < rssLimitBytes * 0.75) {
    return clampBatchSize(args.current + Math.max(1, Math.floor(args.current / 4)), args.min, args.max);
  }

  return clampBatchSize(args.current, args.min, args.max);
}

/**
 * Loads a local embedding model (downloading it on a fresh machine) so the
 * first embed stage on a just-started worker does not wait for it.
 */
export async function warmLocalEmbedding(model: string): Promise<void> {
  const pool = localEmbeddingThreadEnabled() ? sharedLocalEmbeddingPool() : null;
  if (pool && !pool.unusable) {
    // Every pool thread loads its own copy now, so no first batch pays for it.
    const { dtypes, cacheDir } = localEmbeddingThreadSettings();
    try {
      await pool.preload({ model, dtypes, cacheDir, normalize: true });
    } catch (error) {
      if (!pool.unusable) throw error;
    }
  }
  const runner = await localEmbeddingBatchRunner(model, true);
  await runner.run(["warm up"]);
}

function localEmbeddingThreadSettings(): { dtypes: string[]; cacheDir: string } {
  const preferred = resolveLocalTransformersJsDtype();
  return {
    dtypes: preferred === "fp32" ? ["fp32"] : [preferred, "fp32"],
    cacheDir: join(homedir(), ".cache", "docslurp", "transformers"),
  };
}

type EmbeddingOutput = { tolist?: () => unknown; data?: ArrayLike<number>; dims?: number[] };

/** A batch result plus the time spent computing it (not queued, not loading the model). */
type TimedEmbeddingOutput = EmbeddingOutput & { runMs: number };

interface LocalEmbeddingBatchRunner {
  run(batch: string[]): Promise<TimedEmbeddingOutput>;
  /** Model load time measured on the thread/in-process (queue wait excluded), including loads a batch triggered. */
  stats: { loadMs: number };
  dtype(): string;
  cacheHit: boolean;
  /** True when inference runs on the embedding thread, off the event loop. */
  thread: boolean;
}

let localEmbeddingThreadFallbackLogged = false;

/**
 * Runs local batches on the embedding thread pool (local-embedding-thread.ts)
 * so a CPU-bound batch never blocks the event loop and concurrent documents
 * queue for a bounded number of model copies; in-process when
 * DOCSLURP_LOCAL_EMBED_THREAD=off or no thread could start.
 */
async function localEmbeddingBatchRunner(
  model: string,
  normalize: boolean,
  signal?: AbortSignal,
  pooling: EmbeddingPooling = "mean",
): Promise<LocalEmbeddingBatchRunner> {
  const thread = localEmbeddingThreadEnabled() ? sharedLocalEmbeddingPool() : null;
  if (thread && !thread.unusable) {
    const { dtypes, cacheDir } = localEmbeddingThreadSettings();
    // Load first, so model load time stays out of the first batch's timing
    // (which drives batch-size tuning) and cache_hit is known up front.
    let loaded: { dtype: string; cacheHit: boolean; loadMs: number };
    try {
      loaded = await thread.embed({ model, dtypes, cacheDir, texts: [], normalize, pooling }, signal);
    } catch (error) {
      if (!thread.unusable) throw error;
      if (!localEmbeddingThreadFallbackLogged) {
        localEmbeddingThreadFallbackLogged = true;
        console.warn(
          `[embed] local embedding thread unavailable, running in-process: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return await inProcessBatchRunner(model, normalize, pooling);
    }
    const stats = { loadMs: loaded.loadMs };
    return {
      thread: true,
      cacheHit: loaded.cacheHit,
      dtype: () => loaded.dtype,
      stats,
      run: async (batch) => {
        const result = await thread.embed({ model, dtypes, cacheDir, texts: batch, normalize, pooling }, signal);
        // A batch routed to a thread without the model loads it there; count that as load, not inference.
        stats.loadMs += result.loadMs;
        return { data: result.data, dims: result.dims, runMs: result.runMs };
      },
    };
  }
  return await inProcessBatchRunner(model, normalize, pooling);
}

async function inProcessBatchRunner(model: string, normalize: boolean, pooling: EmbeddingPooling): Promise<LocalEmbeddingBatchRunner> {
  const loadStartedAt = Date.now();
  const { pipeline, cacheHit, dtype } = await getLocalEmbeddingPipeline(model);
  return {
    thread: false,
    cacheHit,
    dtype: () => dtype,
    stats: { loadMs: Date.now() - loadStartedAt },
    run: async (batch) => {
      const startedAt = Date.now();
      const output = await pipeline(batch, { pooling, normalize });
      return Object.assign(output, { runMs: Date.now() - startedAt });
    },
  };
}

async function getLocalEmbeddingPipeline(
  model: string,
): Promise<LocalEmbeddingPipelineCacheEntry & { cacheHit: boolean }> {
  const cached = localEmbeddingPipelineCache.get(model);
  if (cached) {
    return { ...(await cached), cacheHit: true };
  }

  const created = createLocalEmbeddingPipeline(model);
  created.catch(() => {
    localEmbeddingPipelineCache.delete(model);
  });
  localEmbeddingPipelineCache.set(model, created);
  return { ...(await created), cacheHit: false };
}

async function createLocalEmbeddingPipeline(
  model: string,
): Promise<LocalEmbeddingPipelineCacheEntry> {
  const transformers = await import("@huggingface/transformers");
  // Auxiliary model files can be loaded without the pipeline cache_dir option.
  transformers.env.cacheDir = join(homedir(), ".cache", "docslurp", "transformers");
  const createPipeline =
    transformers.pipeline as unknown as LocalEmbeddingPipelineFactory;
  const preferredDtype = resolveLocalTransformersJsDtype();
  const triedDtypes: string[] = [];

  for (const dtype of [preferredDtype, "fp32"]) {
    if (triedDtypes.includes(dtype)) {
      continue;
    }
    triedDtypes.push(dtype);

    try {
      return {
        pipeline: await createPipeline("feature-extraction", model, {
          dtype,
          cache_dir: join(homedir(), ".cache", "docslurp", "transformers"),
        }),
        dtype,
      };
    } catch (error) {
      if (dtype === "fp32") {
        throw error;
      }
    }
  }

  throw new Error(`unable to load local transformers.js pipeline for ${model}`);
}

export function resolveLocalTransformersJsDtype(): string {
  const value = (
    process.env.DOCSLURP_LOCAL_TRANSFORMERSJS_DTYPE ??
    DEFAULT_LOCAL_TRANSFORMERSJS_DTYPE
  )
    .trim()
    .toLowerCase();
  const aliases: Record<string, string> = {
    auto: "auto",
    fp32: "fp32",
    float32: "fp32",
    fp16: "fp16",
    float16: "fp16",
    q8: "q8",
    int8: "q8",
    q4: "q4",
  };

  return aliases[value] ?? DEFAULT_LOCAL_TRANSFORMERSJS_DTYPE;
}

function readEmbeddingVectors(
  output: {
    tolist?: () => unknown;
    data?: ArrayLike<number>;
    dims?: number[];
  },
  expectedCount: number,
): number[][] {
  if (typeof output.tolist === "function") {
    return vectorsFromNestedValue(output.tolist(), expectedCount);
  }

  if (output.data) {
    const values = Array.from(output.data, (value) => Number(value));
    const dims = output.dims ?? [];
    const rowCount = dims.length >= 2 ? dims[0] : expectedCount;
    const width = rowCount > 0 ? Math.floor(values.length / rowCount) : 0;
    if (rowCount > 0 && width > 0) {
      return Array.from({ length: rowCount }, (_, index) =>
        values.slice(index * width, (index + 1) * width),
      );
    }
    return [values];
  }

  throw new Error("local embedding pipeline returned an unexpected payload");
}

function vectorsFromNestedValue(value: unknown, expectedCount: number): number[][] {
  if (!Array.isArray(value)) {
    throw new Error("local embedding pipeline returned a non-array payload");
  }

  if (isNumberArray(value)) {
    return [value.map((item) => Number(item))];
  }

  if (value.every(isNumberArray)) {
    return value.map((row) => row.map((item) => Number(item)));
  }

  if (value.every((row) => Array.isArray(row) && row.every(isNumberArray))) {
    return value.map((row) => meanPoolTokenVectors(row as number[][]));
  }

  if (expectedCount === 1 && Array.isArray(value[0]) && isNumberArray(value[0])) {
    return [(value[0] as number[]).map((item) => Number(item))];
  }

  throw new Error("local embedding pipeline returned an unsupported shape");
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function meanPoolTokenVectors(rows: number[][]): number[] {
  const width = rows[0]?.length ?? 0;
  if (width === 0) {
    return [];
  }

  const totals = Array.from({ length: width }, () => 0);
  for (const row of rows) {
    for (let index = 0; index < width; index += 1) {
      totals[index] += row[index] ?? 0;
    }
  }

  return totals.map((total) => total / rows.length);
}

/** Preserve every input in order while bounding request count and conservative token size. */
export function packEmbeddingBatches(chunks: readonly string[], maxInputs: number, maxTokenUpperBound = Infinity): string[][] {
  const batches: string[][] = [];
  const encoder = new TextEncoder();
  let batch: string[] = [];
  let bound = 0;
  for (const chunk of chunks) {
    const next = encoder.encode(chunk).byteLength + 8;
    if (next > maxTokenUpperBound) throw new Error("Embedding input exceeds the hosted request budget; reduce chunk size");
    if (batch.length && (batch.length >= maxInputs || bound + next > maxTokenUpperBound)) {
      batches.push(batch);
      batch = [];
      bound = 0;
    }
    batch.push(chunk);
    bound += next;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function createRemoteEmbeddingModel(profile: EmbeddingProfile, config: Config) {
  switch (profile.provider) {
    case "deepinfra":
      if (profile.model !== "BAAI/bge-m3" || profile.dimensions !== 1024) throw new Error("DeepInfra BGE-M3 requires its native 1024 dimensions");
      return createOpenAI({ apiKey: requiredKey(config.deepInfraApiKey ?? "", "DEEPINFRA_API_KEY"), baseURL: DEEPINFRA_EMBEDDING_BASE_URL, fetch: instrumentFetch("deepinfra", "embedding") }).embedding(profile.model) as any;
    case "openrouter": {
      const route = openRouterEmbeddingRoute(profile.model);
      if (profile.dimensions !== route.dimensions) throw new Error("OpenRouter embedding dimensions do not match the registered model");
      return createOpenAI({ apiKey: requiredKey(config.openRouterApiKey, "OPENROUTER_API_KEY"), baseURL: OPENROUTER_BASE_URL, fetch: instrumentFetch("openrouter", "embedding", createOpenRouterRoutingFetch()) }).embedding(profile.model) as any;
    }
    case "openai":
      return (
        config.openAiBaseUrl &&
        config.openAiBaseUrl !== "https://api.openai.com/v1"
          ? createOpenAI({
              apiKey: requiredKey(config.openAiApiKey, "OPENAI_API_KEY"),
              baseURL: config.openAiBaseUrl,
              fetch: instrumentFetch("openai", "embedding"),
            }).embedding(profile.model)
          : createOpenAI({ apiKey: config.openAiApiKey || undefined, fetch: instrumentFetch("openai", "embedding") }).embedding(profile.model)
      ) as any;
    case "ollama":
    case "vllm":
    case "lmstudio":
      if (!profile.baseUrl) {
        throw new Error(`${profile.provider} embedding route requires a base URL`);
      }
      return createOpenAI({
        apiKey: "local",
        baseURL: profile.baseUrl,
        fetch: instrumentFetch(profile.provider, "embedding"),
      }).embedding(profile.model) as any;
    case "jina":
    case "nomic":
    case "mixedbread":
      throw new Error(
        `remote embedding provider ${profile.provider} is not enabled in this worker`,
      );
    default:
      throw new Error(
        `unsupported remote embedding provider: ${profile.provider}`,
      );
  }
}

/**
 * OpenAI accepts `dimensions` for its custom-dimension models; vLLM accepts it
 * for Matryoshka models, but only when the workspace set it explicitly (an
 * unknown model's 1536 fallback must never be requested).
 */
export function remoteEmbeddingProviderOptions(profile: EmbeddingProfile) {
  if (profile.provider === "openai" && profile.supportsCustomDimensions) {
    return { openai: { dimensions: profile.dimensions } };
  }
  if (profile.provider === "vllm" && profile.requestedDimensions) {
    return { openai: { dimensions: profile.requestedDimensions } };
  }
  return undefined;
}

function serializeJson(value: unknown): Record<string, unknown> {
  if (value == null) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function requiredKey(value: string, envVar: string): string {
  if (!value) {
    throw new Error(`${envVar} is required`);
  }
  return value;
}

async function buildDocumentContextSummary(args: {
  textGeneration?: TextGenerationConfig;
  privacyMode: PrivacyMode;
  documentTitle: string;
  documentText: string;
  config: Config;
  signal?: AbortSignal;
}): Promise<{ summary: string; usage?: ContextualChunkUsage }> {
  const model = resolvePipelineTextModel(args, "contextual-chunk-preamble", args.config.textGenerationModel);
  const heuristicSummary = buildHeuristicDocumentSummary(
    args.documentTitle,
    args.documentText,
  );

  if (
    !textModelApiKey(args.config.openRouterApiKey, model) ||
    !isProviderCallAllowed(args.privacyMode, textModelCallDescriptor("worker.text.contextual-chunk-preamble", model))
  ) {
    return {
      summary: heuristicSummary,
      usage: {
        provider: "heuristic",
        model: "local-document-context",
        inputTokens: 0,
        outputTokens: 0,
        source: "heuristic",
      },
    };
  }

  try {
    const sourceExcerpt = truncateText(
      normalizeWhitespace(stripLeadingFrontmatter(args.documentText).markdown),
      CONTEXTUAL_SOURCE_LIMIT,
    );
    const task = buildTrustedDocumentTaskPrompt({
      instruction:
        "Write one plain-text sentence that helps search index chunks from this document.",
      outputContract: [
        "Mention the document's scope, main entities or topics, and purpose.",
        `Keep it under ${CONTEXTUAL_CHUNK_SUMMARY_LIMIT} characters.`,
        "Do not use markdown or bullet points.",
      ].join(" "),
      trustedContext: [{ label: "Title", value: args.documentTitle }],
      untrustedContent: sourceExcerpt,
      untrustedContentLabel: "document excerpt",
      maxContentChars: -1,
    });
    const result = await generateOpenRouterText({
      operation: "contextual-chunk-preamble",
      apiKey: textModelApiKey(args.config.openRouterApiKey, model),
      privacyMode: args.privacyMode,
      model,
      maxOutputTokens: 96,
      textGeneration: args.textGeneration,
      deploymentProfile: args.config.textGenerationProfile,
      system: task.system,
      prompt: task.prompt,
      signal: args.signal,
    });
    const inputTokens = result.usage.inputTokens;
    const outputTokens = result.usage.outputTokens;
    // The caller records `usage` through the pipeline ledger, which logs `[ai-usage]`.
    const summary = normalizeWhitespace(result.text);
    // Do not index a truncated analysis or an unfinished answer as document
    // context. Fall back to source text when the one-sentence contract fails.
    const validSummary = summary.length > 0 && summary.length <= CONTEXTUAL_CHUNK_SUMMARY_LIMIT
      && !/(?:<think>|thinking process:|^\s*(?:#{1,6}\s|\d+\.\s|[-*]\s))/im.test(result.text);
    return {
      summary: validSummary ? summary : heuristicSummary,
      usage: {
        ...textUsageLabels(model),
        costCents: result.usage.costCents,
        metadata: result.usage.metadata,
        inputTokens,
        outputTokens,
        source: textUsageLabels(model).provider === "private" ? "private" : "openrouter",
      },
    };
  } catch {
    return {
      summary: heuristicSummary,
      usage: {
        provider: "heuristic",
        model: "local-document-context",
        inputTokens: 0,
        outputTokens: 0,
        source: "heuristic",
      },
    };
  }
}

/**
 * Body text for a heuristic summary: no metadata block and no heading lines
 * (the preamble already names the document and section), so the first
 * sentence is prose rather than `--- ## title: … # Heading`.
 */
function summarySourceText(documentText: string): string {
  return stripLeadingFrontmatter(documentText).markdown
    .split("\n")
    .filter((line) => !/^#{1,6}\s/.test(line))
    .join("\n");
}

export function buildHeuristicDocumentSummary(
  documentTitle: string,
  documentText: string,
): string {
  const normalized = normalizeWhitespace(summarySourceText(documentText));
  if (!normalized) {
    return `Content from ${documentTitle}`;
  }

  const firstSentence =
    normalized.match(/.+?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
  return truncateText(firstSentence, CONTEXTUAL_CHUNK_SUMMARY_LIMIT);
}

function buildChunkContextPreamble(args: {
  documentTitle: string;
  documentContext: string;
  headingPath?: string[];
  pageNumber?: number | null;
  pageNumbers?: number[];
}): string {
  const lines = [`Document: ${args.documentTitle}`];
  if (args.documentContext) {
    lines.push(`Context: ${args.documentContext}`);
  }

  const section = args.headingPath?.filter(Boolean).join(" > ");
  if (section) {
    lines.push(`Section: ${section}`);
  }

  const pageLabel = formatPageLabel(args.pageNumber, args.pageNumbers);
  if (pageLabel) {
    lines.push(`Pages: ${pageLabel}`);
  }

  return lines.join("\n");
}

function formatPageLabel(
  pageNumber?: number | null,
  pageNumbers?: number[],
): string | null {
  const values = new Set<number>();
  if (typeof pageNumber === "number") {
    values.add(pageNumber);
  }
  for (const value of pageNumbers ?? []) {
    if (typeof value === "number") {
      values.add(value);
    }
  }

  if (values.size === 0) {
    return null;
  }

  return [...values].sort((a, b) => a - b).join(", ");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}
