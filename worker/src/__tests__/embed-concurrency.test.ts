import { createHash } from "node:crypto";

import { normalizePipelineFeatures } from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ embed: 0, inFlight: 0, peak: 0, preamble: 0, progress: 0, pages: [] as number[][] }));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  embedMany: vi.fn(async (args: { values: string[] }) => {
    calls.embed++;
    calls.inFlight++;
    calls.peak = Math.max(calls.peak, calls.inFlight);
    // Input-dependent latency: windows finish out of order.
    const digest = createHash("sha256").update(args.values.join("|")).digest();
    await sleep(5 + (digest[0]! % 25));
    calls.inFlight--;
    return {
      embeddings: args.values.map((value) => Array.from(createHash("sha256").update(value).digest().subarray(0, 8), (byte) => byte / 255)),
      usage: { tokens: args.values.length * 7 },
    };
  }),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ embedding: (model: string) => ({ model }) }),
  openai: { embedding: (model: string) => ({ model }) },
}));
vi.mock("../lib/ai.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ai.js")>()),
  generateOpenRouterText: vi.fn(async () => {
    calls.preamble++;
    await sleep(20);
    return { text: "A test manual about procedures.", usage: { inputTokens: 100, outputTokens: 10, costCents: 0.01, metadata: {} } };
  }),
}));

import { fromEnv } from "../config.js";
import { buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { EmbedStage } from "../stages/embed.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

class MemoryStorage {
  readonly bucket = "t";
  readonly objects = new Map<string, string>();
  uri(key: string) { return `s3://t/${key}`; }
  async getBytes(key: string) { return Buffer.from(this.objects.get(key) ?? "", "utf8"); }
  async getJson<T>(key: string): Promise<T> { return JSON.parse(this.objects.get(key)!) as T; }
  async putJson(key: string, value: unknown) { this.objects.set(key, JSON.stringify(value)); }
}

function store() {
  return {
    updateProgress: async () => { calls.progress++; await sleep(1); },
    startRunStage: async () => {}, completeRunStage: async () => {}, failRunStage: async () => {},
    startDocumentStage: async () => {}, completeDocumentStage: async () => {}, failDocumentStage: async () => {},
    appendEvent: async () => {},
    setPageStageComplete: async () => {},
    setPagesStageComplete: async (_run: string, _doc: string, _stage: string, pages: number[]) => { calls.pages.push([...pages]); },
    getCompletedPages: async () => new Set<number>(),
    findEmbeddingReuseRefs: async () => [],
    recordEmbeddingReuseRefs: async () => {},
    forgetEmbeddingReuseRefs: async () => {},
  };
}

const PAGES = 24;
const markdown = Array.from({ length: PAGES }, (_, page) =>
  `# Chapter ${page + 1}\n\n${[1, 2, 3].map((section) =>
    `## Part ${page + 1}.${section}\n\n${`Page ${page + 1} part ${section} lists step ${section} of the procedure. `.repeat(20)}`).join("\n\n")}`,
).join("\n\f");

async function embedOnce(env: Record<string, string>, documents = ["doc"], pipelineOverrides: Record<string, unknown> = {}, allowFailure = false) {
  Object.assign(process.env, env);
  Object.assign(calls, { embed: 0, inFlight: 0, peak: 0, preamble: 0, progress: 0, pages: [] });
  const storage = new MemoryStorage();
  const docs: Document[] = [];
  const artifacts: Record<string, string> = {};
  for (const id of documents) {
    const key = `u1/run/canonical/${id}.json`;
    await storage.putJson(key, buildCanonicalDocumentFromMarkdown({ documentId: "same", text: markdown, pageCount: PAGES, extractor: "test" }));
    artifacts[`${id}:canonical-document`] = storage.uri(key);
    docs.push({ id, userId: "u1", runId: "run", filename: "manual.pdf", mimeType: "application/pdf", sourceKey: "unused",
      status: "processing", extractionMode: "hybrid", pageCount: PAGES, createdAt: new Date(), updatedAt: new Date() });
  }
  const run = {
    id: "run", userId: "u1", orgId: "o1", workspaceId: "w1", stage: "embed", status: "processing",
    pipeline: { ...normalizePipelineFeatures({ embedding: { profile: "cheapest-hosted", modelUri: "llm://openai/text-embedding-3-small", target: "hosted" } as never }), ...pipelineOverrides },
    stats: {}, artifacts, spentCents: 0,
  } as unknown as WorkspaceRun;
  const state = WorkflowState.create(run, docs);
  state.docConcurrency = 1;
  state.store = store() as unknown as WorkflowState["store"];
  let error: unknown;
  await new EmbedStage({} as CommandRunner, storage as unknown as ArtifactStore, { ...fromEnv(), openRouterApiKey: "k", openAiApiKey: "k" })
    .run(state).catch((caught: unknown) => { error = caught; });
  if (error && !allowFailure) throw error;
  const artifactUri = state.artifactLedger.readDocument(documents[0]!, "embeddings");
  const artifact = artifactUri
    ? await storage.getJson<{ chunks: Array<{ id: string; text: string; vector: number[]; metadata: Record<string, unknown> }> }>(
      artifactUri.replace("s3://t/", ""))
    : { chunks: [] };
  return { state, artifact, error, calls: { ...calls, pages: calls.pages.map((pages) => [...pages]) } };
}

const ENV_KEYS = ["EMBED_BATCH_CONCURRENCY", "EMBED_PREAMBLE_MODE", "EMBED_PROGRESS_INTERVAL_MS", "DOCSLURP_EMBED_MAX_WINDOW_CHUNKS"];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("EmbedStage concurrency", () => {
  it("produces the same chunks, ids and vectors at any concurrency, completing pages in order", async () => {
    const serial = await embedOnce({ EMBED_BATCH_CONCURRENCY: "1", EMBED_PREAMBLE_MODE: "inline", EMBED_PROGRESS_INTERVAL_MS: "0", DOCSLURP_EMBED_MAX_WINDOW_CHUNKS: "5" });
    const parallel = await embedOnce({ EMBED_BATCH_CONCURRENCY: "4", EMBED_PREAMBLE_MODE: "concurrent", EMBED_PROGRESS_INTERVAL_MS: "10000", DOCSLURP_EMBED_MAX_WINDOW_CHUNKS: "5" });

    expect(serial.calls.peak).toBe(1);
    expect(parallel.calls.peak).toBeGreaterThan(1);
    expect(parallel.calls.peak).toBeLessThanOrEqual(4);
    expect(parallel.calls.embed).toBe(serial.calls.embed);
    expect(parallel.artifact.chunks.map((chunk) => [chunk.id, chunk.text, chunk.vector]))
      .toEqual(serial.artifact.chunks.map((chunk) => [chunk.id, chunk.text, chunk.vector]));
    expect(parallel.artifact.chunks.map((chunk) => chunk.metadata.embeddingInputKey))
      .toEqual(serial.artifact.chunks.map((chunk) => chunk.metadata.embeddingInputKey));
    // Pages are marked complete in ascending order, each exactly once.
    const completed = parallel.calls.pages.flat();
    expect(completed).toEqual(Array.from({ length: PAGES }, (_, index) => index + 1));
    expect(serial.calls.pages.flat()).toEqual(completed);

    // One preamble call, recorded once; every batch's usage is in the ledger.
    for (const result of [serial, parallel]) {
      const events = result.state.usageLedger.snapshot();
      expect(result.calls.preamble).toBe(1);
      expect(events.filter((event) => event.metric === "contextual-chunk-preamble")).toHaveLength(1);
      expect(events.filter((event) => event.metric === "embedding-tokens")).toHaveLength(result.calls.embed);
    }
    // Progress checkpoints: one per batch when unthrottled, coalesced (plus a final write) when throttled.
    // (Both also carry the stage's own checkpoints and the embed loop's final flush.)
    const stageCheckpoints = serial.calls.progress - serial.calls.embed - 1;
    expect(stageCheckpoints).toBeGreaterThanOrEqual(0);
    expect(parallel.calls.progress - stageCheckpoints).toBeLessThanOrEqual(2);
  });

  it("bills a concurrent preamble call even when the document is an in-run duplicate", async () => {
    const result = await embedOnce({ EMBED_BATCH_CONCURRENCY: "4", EMBED_PREAMBLE_MODE: "concurrent" }, ["first", "second"]);
    const preambles = result.state.usageLedger.snapshot().filter((event) => event.metric === "contextual-chunk-preamble");
    expect(result.calls.preamble).toBe(2);
    expect(preambles).toHaveLength(2);
    expect(preambles.map((event) => event.metadata?.discarded ?? null)).toEqual([null, "deduplicated"]);
    expect(result.state.documentStage("second", "embed")?.stats).toMatchObject({ deduplicated: true });
  });

  it("inline mode skips the preamble call for an in-run duplicate", async () => {
    const result = await embedOnce({ EMBED_PREAMBLE_MODE: "inline" }, ["first", "second"]);
    expect(result.calls.preamble).toBe(1);
  });

  it("stops sending batches once the run cost cap is reached, billing every batch that was sent", async () => {
    const result = await embedOnce(
      { EMBED_BATCH_CONCURRENCY: "4", EMBED_PROGRESS_INTERVAL_MS: "0", DOCSLURP_EMBED_MAX_WINDOW_CHUNKS: "5" },
      ["doc"],
      { contextualChunkPreambles: false, maxCostCents: 1e-9 },
      true,
    );
    expect(String(result.error)).toMatch(/cost cap/);
    const embedEvents = result.state.usageLedger.snapshot().filter((event) => event.metric === "embedding-tokens");
    expect(result.calls.embed).toBeGreaterThanOrEqual(1);
    // Overshoot is bounded by the requests already in flight when the cap was crossed.
    expect(result.calls.embed).toBeLessThanOrEqual(4);
    expect(embedEvents).toHaveLength(result.calls.embed);
    // The failure path still checkpoints, so sent batches reach usage_events even
    // when the activity is cancelled and rethrows without its own checkpoint.
    expect(result.calls.progress).toBeGreaterThanOrEqual(1);
  });
});
