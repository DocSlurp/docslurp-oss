/**
 * Wall-time benchmark for the embed stage with a fake remote embedder and a
 * fake preamble LLM that both have realistic latency. No network calls.
 *
 * Skipped by default; run with:
 *   EMBED_BENCH=1 pnpm --filter worker exec vitest run src/__tests__/embed-stage.bench.test.ts
 * Knobs under test (EMBED_BATCH_CONCURRENCY, EMBED_PREAMBLE_MODE, ...) are read
 * from the environment, so the same file measures before and after.
 */
import { normalizePipelineFeatures } from "@docslurp/shared";
import { describe, expect, it, vi } from "vitest";

const latency = vi.hoisted(() => ({
  // Remote embedding: fixed request overhead plus per-input time (256 inputs ≈ 790 ms).
  embedBaseMs: 300,
  embedPerInputMs: 1.9,
  preambleMs: 1_200,
  progressWriteMs: 25,
  reuseLookupMs: 10,
  pageWriteMs: 5,
  calls: { embed: 0, preamble: 0, progress: 0, maxInFlight: 0, inFlight: 0, preambleAtMs: -1, firstEmbedAtMs: -1 },
  startedAt: 0,
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    embedMany: vi.fn(async (args: { values: string[] }) => {
      latency.calls.embed += 1;
      if (latency.calls.firstEmbedAtMs < 0) latency.calls.firstEmbedAtMs = Math.round(performance.now() - latency.startedAt);
      latency.calls.inFlight += 1;
      latency.calls.maxInFlight = Math.max(latency.calls.maxInFlight, latency.calls.inFlight);
      await sleep(latency.embedBaseMs + latency.embedPerInputMs * args.values.length);
      latency.calls.inFlight -= 1;
      if (process.env.EMBED_BENCH_TRACE) console.log(`[embed-bench-trace] embed n=${args.values.length} end=${Math.round(performance.now() - latency.startedAt)}`);
      return {
        embeddings: args.values.map((value) => Array.from({ length: 8 }, (_, index) => (value.length + index) / 1000)),
        usage: { tokens: args.values.reduce((sum, value) => sum + Math.ceil(value.length / 4), 0) },
      };
    }),
  };
});
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ embedding: (model: string) => ({ model }) }),
  openai: { embedding: (model: string) => ({ model }) },
}));
vi.mock("../lib/ai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ai.js")>();
  return {
    ...actual,
    generateOpenRouterText: vi.fn(async () => {
      latency.calls.preamble += 1;
      latency.calls.preambleAtMs = Math.round(performance.now() - latency.startedAt);
      await sleep(latency.preambleMs);
      return { text: "A synthetic operations manual covering procedures.", usage: { inputTokens: 3_000, outputTokens: 30, costCents: 0.05, metadata: {} } };
    }),
  };
});

import { fromEnv } from "../config.js";
import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { MemoryProviderRateStore, ProviderRateLimiter, readProviderRateLimitConfig, setProviderRateLimiterForTests } from "../lib/provider-rate-limit.js";
import { EmbedStage } from "../stages/embed.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

class MemoryStorage {
  readonly bucket = "bench";
  readonly objects = new Map<string, string>();
  uri(key: string) { return `s3://bench/${key}`; }
  async getBytes(key: string) { return Buffer.from(this.objects.get(key) ?? "", "utf8"); }
  async getJson<T>(key: string): Promise<T> { return JSON.parse(this.objects.get(key)!) as T; }
  async putJson(key: string, value: unknown) { this.objects.set(key, JSON.stringify(value)); }
}

function benchStore() {
  return {
    updateProgress: async () => { latency.calls.progress += 1; await sleep(latency.progressWriteMs); },
    startRunStage: async () => {},
    completeRunStage: async () => {},
    failRunStage: async () => {},
    startDocumentStage: async () => {},
    completeDocumentStage: async () => {},
    failDocumentStage: async () => {},
    appendEvent: async () => { await sleep(latency.pageWriteMs); },
    setPageStageComplete: async () => {},
    setPagesStageComplete: async () => { await sleep(latency.pageWriteMs); },
    getCompletedPages: async () => new Set<number>(),
    insertChunks: async () => { await sleep(latency.progressWriteMs); },
    findEmbeddingReuseRefs: async () => { await sleep(latency.reuseLookupMs); return []; },
    recordEmbeddingReuseRefs: async () => {},
    forgetEmbeddingReuseRefs: async () => {},
  };
}

/** About five ~1,500-character chunks per page. */
function syntheticMarkdown(pages: number): string {
  const out: string[] = [];
  for (let page = 1; page <= pages; page++) {
    const sections: string[] = [];
    for (let section = 1; section <= 5; section++) {
      const sentence = `Page ${page} section ${section} describes procedure ${page * 10 + section} with tolerances, owners and review steps. `;
      sections.push(`## Procedure ${page}.${section}\n\n${sentence.repeat(13)}`);
    }
    out.push(`# Chapter ${page}\n\n${sections.join("\n\n")}`);
  }
  return out.join("\n\f");
}

async function runBench(pages: number) {
  latency.calls = { embed: 0, preamble: 0, progress: 0, maxInFlight: 0, inFlight: 0, preambleAtMs: -1, firstEmbedAtMs: -1 };
  const storage = new MemoryStorage();
  const documentId = `bench-${pages}`;
  const canonical = buildCanonicalDocumentFromMarkdown({ documentId, text: syntheticMarkdown(pages), pageCount: pages, extractor: "bench" });
  const canonicalKey = `u1/run/canonical/${documentId}.json`;
  await storage.putJson(canonicalKey, canonical);
  const document: Document = {
    id: documentId, userId: "u1", runId: "run", filename: "manual.pdf", mimeType: "application/pdf",
    sourceKey: "unused", status: "processing", extractionMode: "hybrid", pageCount: pages,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const pipeline = normalizePipelineFeatures({ embedding: { profile: "cheapest-hosted" } as never });
  const run = {
    id: "run", userId: "u1", orgId: "o1", workspaceId: "w1", stage: "embed", status: "processing", pipeline,
    stats: {}, artifacts: { [`${documentId}:canonical-document`]: storage.uri(canonicalKey) }, spentCents: 0,
  } as unknown as WorkspaceRun;
  const state = WorkflowState.create(run, [document]);
  state.store = benchStore() as unknown as WorkflowState["store"];
  const config = { ...fromEnv(), openRouterApiKey: "bench-key", openAiApiKey: "bench-key" };

  // Fresh fleet TPM bucket per document (AI_RATE_LIMITS, default openai:text-embedding-*=tpm:2500000).
  setProviderRateLimiterForTests(new ProviderRateLimiter(new MemoryProviderRateStore(), readProviderRateLimitConfig(process.env)));
  const startedAt = performance.now();
  latency.startedAt = startedAt;
  await new EmbedStage({} as CommandRunner, storage as unknown as ArtifactStore, config).run(state);
  const wallMs = performance.now() - startedAt;
  const stage = state.documentStage(documentId, "embed");
  expect(stage?.status, stage?.error ?? "").toBe("completed");
  const artifactUri = state.artifactLedger.readDocument(documentId, "embeddings")!;
  const artifact = await storage.getJson<{ chunks: Array<{ id: string; vector: number[] }> }>(artifactUri.replace("s3://bench/", ""));
  return { pages, chunks: artifact.chunks.length, wallMs: Math.round(wallMs), ...latency.calls };
}

describe.skipIf(!process.env.EMBED_BENCH)("embed stage wall time (fake latency)", () => {
  it("reports wall time for 100- and 500-page documents", async () => {
    const results = [];
    for (const pages of [100, 500]) results.push(await runBench(pages));
    setProviderRateLimiterForTests(null);
    console.log(`[embed-bench] env EMBED_BATCH_CONCURRENCY=${process.env.EMBED_BATCH_CONCURRENCY ?? "(unset)"} EMBED_PREAMBLE_MODE=${process.env.EMBED_PREAMBLE_MODE ?? "(unset)"} EMBED_PROGRESS_INTERVAL_MS=${process.env.EMBED_PROGRESS_INTERVAL_MS ?? "(unset)"} AI_RATE_LIMITS=${process.env.AI_RATE_LIMITS ?? "(default)"}`);
    for (const result of results) console.log(`[embed-bench] ${JSON.stringify(result)}`);
  }, 120_000);
});
