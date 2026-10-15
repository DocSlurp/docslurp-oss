import { createHash } from "node:crypto";

import type { TextGenerationConfig } from "@docslurp/shared";

import type { EmbeddingProfile } from "../models.js";
import type { EmbeddingArtifact } from "../stages/embedding-runtime.js";
import { keyFromStorageUri } from "../tools/storage.js";

/**
 * Content-addressed embedding reuse.
 *
 * A vector is a pure function of the exact text sent to the embedding provider
 * plus every parameter that changes the vector (provider, model, endpoint,
 * dimensions, task, normalization, local dtype). The embed stage keys each
 * chunk's final input by that, looks the keys up before calling the provider
 * and only embeds misses.
 *
 * Lookup sources, cheapest first:
 * 1. Seed artifacts: the document's prior embedding artifact already in the run
 *    ledger (partial reprocess re-keys the source version's artifacts onto the
 *    new document), so a reindex needs no database read at all.
 * 2. `embedding_reuse_refs`: a per-org table of key -> (embedding artifact URI,
 *    chunk index). It stores pointers, not vectors; the vectors stay in the
 *    embedding artifacts already in object storage. Re-uploads, duplicates and
 *    near-duplicates (shared chunks) hit through it.
 *
 * Tenant isolation: database refs are always scoped to one organization and a
 * run without an org never consults them. A hit is only accepted when the
 * referenced artifact chunk carries the same key, so stale or purged pointers
 * degrade to misses.
 */
export const EMBEDDING_REUSE_KEY_VERSION = 1;

/** Prefix of document-context keys stored next to vector keys. */
const CONTEXT_KEY_PREFIX = "ctx:";
const DEFAULT_MAX_ARTIFACTS = 8;

export interface EmbeddingReuseRef {
  key: string;
  artifactUri: string;
  /** Chunk index in the artifact; -1 for a document-context entry. */
  chunkIndex: number;
}

export interface EmbeddingReuseStore {
  findEmbeddingReuseRefs(orgId: string, keys: readonly string[]): Promise<EmbeddingReuseRef[]>;
  recordEmbeddingReuseRefs(orgId: string, refs: readonly EmbeddingReuseRef[]): Promise<void>;
  forgetEmbeddingReuseRefs(orgId: string, artifactUri: string, keys: readonly string[]): Promise<void>;
}

export function asEmbeddingReuseStore(value: unknown): EmbeddingReuseStore | undefined {
  if (
    value
    && typeof value === "object"
    && typeof (value as EmbeddingReuseStore).findEmbeddingReuseRefs === "function"
    && typeof (value as EmbeddingReuseStore).recordEmbeddingReuseRefs === "function"
    && typeof (value as EmbeddingReuseStore).forgetEmbeddingReuseRefs === "function"
  ) {
    return value as EmbeddingReuseStore;
  }
  return undefined;
}

export type EmbeddingVectorParams = Pick<
  EmbeddingProfile,
  "runtime" | "provider" | "model" | "baseUrl" | "dimensions" | "task" | "normalize"
> & {
  supportsCustomDimensions?: boolean;
  /** transformers.js weight dtype (q8, fp32, ...); local runtime only. */
  localDtype?: string;
};

/** Stable description of everything besides the input text that shapes a vector. */
export function embeddingVectorFingerprint(params: EmbeddingVectorParams): string {
  return JSON.stringify({
    v: EMBEDDING_REUSE_KEY_VERSION,
    runtime: params.runtime,
    provider: params.provider,
    model: params.model,
    baseUrl: params.baseUrl ?? null,
    dimensions: params.dimensions,
    customDimensions: params.supportsCustomDimensions === true,
    task: params.task ?? null,
    normalize: params.normalize,
    dtype: params.runtime === "local" ? params.localDtype ?? null : null,
  });
}

/**
 * Key for one provider input. The text is hashed exactly as sent (contextual
 * preamble and late-chunking context included): whitespace or Unicode
 * normalization can change tokenization, so equal keys mean identical requests.
 */
export function embeddingInputKey(input: string, fingerprint: string): string {
  return createHash("sha256").update(fingerprint).update("\u0000").update(input, "utf8").digest("hex");
}

/** Key for the LLM-written document context that prefixes every chunk preamble. */
export function documentContextKey(args: {
  model: string;
  textGeneration?: TextGenerationConfig;
  documentTitle: string;
  documentText: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ v: EMBEDDING_REUSE_KEY_VERSION, model: args.model, textGeneration: args.textGeneration ?? null }))
    .update("\u0000")
    .update(args.documentTitle, "utf8")
    .update("\u0000")
    .update(args.documentText, "utf8")
    .digest("hex");
  return `${CONTEXT_KEY_PREFIX}${digest}`;
}

/** Fields the embed stage adds to its artifact so later runs can reuse it. */
export interface EmbeddingReuseArtifactFields {
  reuse?: {
    keyVersion: number;
    fingerprint: string;
    hits: number;
    misses: number;
    documentContextReused: boolean;
  };
  documentContext?: {
    key: string;
    summary: string;
    source: string;
  };
}

export type ReusableEmbeddingArtifact = EmbeddingArtifact & EmbeddingReuseArtifactFields;

type ArtifactReader = {
  readonly bucket: string;
  getJson<T>(key: string): Promise<T>;
};

export interface EmbeddingReuseLookupStats {
  artifactsLoaded: number;
  artifactsMissing: number;
  refRows: number;
  lookupMs: number;
}

/**
 * Per-document lookup over seed artifacts and the org's ref table. Artifacts
 * are loaded at most once. Lookup failures never fail the stage: they are
 * logged and the affected keys are embedded normally.
 */
export class EmbeddingReuseLookup {
  private readonly artifacts = new Map<string, Promise<ReusableEmbeddingArtifact | null>>();
  readonly stats: EmbeddingReuseLookupStats = { artifactsLoaded: 0, artifactsMissing: 0, refRows: 0, lookupMs: 0 };

  constructor(private readonly args: {
    storage: ArtifactReader;
    store?: EmbeddingReuseStore;
    orgId: string | null | undefined;
    seedArtifactUris?: Array<string | undefined>;
    maxArtifacts?: number;
  }) {}

  /** Reuse a hosted-model document context written for the same title, text and model. */
  async findDocumentContext(key: string): Promise<string | undefined> {
    const startedAt = Date.now();
    try {
      for (const uri of this.seedUris()) {
        const summary = readDocumentContext(await this.load(uri), key);
        if (summary !== undefined) return summary;
      }
      const refs = await this.findRefs([key]);
      for (const ref of refs.slice(0, 2)) {
        const summary = readDocumentContext(await this.load(ref.artifactUri), key);
        if (summary !== undefined) return summary;
        await this.forget(ref.artifactUri, [key]);
      }
      return undefined;
    } catch (error) {
      warn("document context lookup failed", error);
      return undefined;
    } finally {
      this.stats.lookupMs += Date.now() - startedAt;
    }
  }

  /** Vectors for the keys that have a verified prior embedding. */
  async findVectors(keys: readonly string[]): Promise<Map<string, number[]>> {
    const startedAt = Date.now();
    const found = new Map<string, number[]>();
    const wanted = new Set(keys);
    try {
      for (const uri of this.seedUris()) {
        if (wanted.size === 0) break;
        collectVectors(await this.load(uri), wanted, found);
      }
      if (wanted.size === 0) return found;

      const refs = await this.findRefs([...wanted]);
      const byArtifact = new Map<string, string[]>();
      for (const ref of refs) {
        if (ref.chunkIndex < 0 || !wanted.has(ref.key)) continue;
        byArtifact.set(ref.artifactUri, [...(byArtifact.get(ref.artifactUri) ?? []), ref.key]);
      }
      // Fetch the artifacts that cover the most keys first and bound the reads.
      const ranked = [...byArtifact.entries()].sort((a, b) => b[1].length - a[1].length);
      for (const [uri, refKeys] of ranked.slice(0, this.args.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS)) {
        if (wanted.size === 0) break;
        const before = found.size;
        collectVectors(await this.load(uri), wanted, found);
        if (found.size === before) await this.forget(uri, refKeys);
      }
      return found;
    } catch (error) {
      warn("vector lookup failed", error);
      return found;
    } finally {
      this.stats.lookupMs += Date.now() - startedAt;
    }
  }

  private seedUris(): string[] {
    return [...new Set((this.args.seedArtifactUris ?? []).filter((uri): uri is string => Boolean(uri)))];
  }

  private async findRefs(keys: string[]): Promise<EmbeddingReuseRef[]> {
    if (!this.args.orgId || !this.args.store || keys.length === 0) return [];
    const refs = await this.args.store.findEmbeddingReuseRefs(this.args.orgId, keys);
    this.stats.refRows += refs.length;
    return refs;
  }

  private async forget(uri: string, keys: string[]): Promise<void> {
    if (!this.args.orgId || !this.args.store || keys.length === 0) return;
    try {
      await this.args.store.forgetEmbeddingReuseRefs(this.args.orgId, uri, keys);
    } catch (error) {
      warn("stale ref cleanup failed", error);
    }
  }

  private load(uri: string): Promise<ReusableEmbeddingArtifact | null> {
    let pending = this.artifacts.get(uri);
    if (!pending) {
      pending = this.read(uri);
      this.artifacts.set(uri, pending);
    }
    return pending;
  }

  private async read(uri: string): Promise<ReusableEmbeddingArtifact | null> {
    const key = keyFromStorageUri(uri, this.args.storage.bucket);
    if (!key) return null;
    try {
      const artifact = await this.args.storage.getJson<ReusableEmbeddingArtifact>(key);
      this.stats.artifactsLoaded += 1;
      return artifact && Array.isArray(artifact.chunks) ? artifact : null;
    } catch {
      // Purged or never written: the pointer is stale.
      this.stats.artifactsMissing += 1;
      return null;
    }
  }
}

function readDocumentContext(artifact: ReusableEmbeddingArtifact | null, key: string): string | undefined {
  const context = artifact?.documentContext;
  return context && context.key === key && typeof context.summary === "string" && context.summary.length > 0
    ? context.summary
    : undefined;
}

function collectVectors(
  artifact: ReusableEmbeddingArtifact | null,
  wanted: Set<string>,
  found: Map<string, number[]>,
): void {
  if (!artifact) return;
  for (const chunk of artifact.chunks) {
    const key = chunk.metadata?.embeddingInputKey;
    if (typeof key !== "string" || !wanted.has(key) || !isUsableVector(chunk.vector)) continue;
    found.set(key, chunk.vector);
    wanted.delete(key);
  }
}

function isUsableVector(vector: unknown): vector is number[] {
  return Array.isArray(vector) && vector.length > 0 && vector.every((value) => typeof value === "number" && Number.isFinite(value));
}

function warn(message: string, error: unknown): void {
  console.warn(`[embed-reuse] ${message}: ${error instanceof Error ? error.message : String(error)}`);
}
