import { afterEach, expect, it, vi } from "vitest";
import { normalizePipelineFeatures } from "@docslurp/shared";
import type { Config } from "../config.js";
import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { extractDocumentGraph, type DocumentGraph } from "../graph/extract.js";
import { GraphEnrichStage } from "./graph-enrich.js";
vi.mock("../graph/extract.js", () => ({ extractDocumentGraph: vi.fn() }));
vi.mock("../lib/privacy-guard.js", () => ({ allowHostedCall: vi.fn(async () => true), openRouterTextCall: vi.fn() }));
afterEach(() => vi.resetAllMocks());
function setup(concurrency: number) {
  const documents = Array.from({ length: 6 }, (_, i) => ({ id: `doc-${i}`, filename: `${i}.txt` }) as Document);
  const state = WorkflowState.create({ id: "run", userId: "user", workspaceId: "workspace", artifacts: {}, stats: {}, pipeline: normalizePipelineFeatures({ graphRag: true }) } as WorkspaceRun, documents);
  state.docConcurrency = concurrency;
  for (const doc of documents) state.artifactLedger.recordDocument(doc.id, "embeddings", `s3://bucket/${doc.id}`);
  const store = { replaceDocumentGraph: vi.fn(async () => ({ nodes: 1, edges: 0 })), refreshWorkspaceCommunities: vi.fn(async () => null), workspaceGraphScope: vi.fn(async () => "Workspace documents") };
  state.store = store as unknown as NonNullable<WorkflowState["store"]>;
  const storage = { bucket: "bucket", getJson: vi.fn(async (key: string) => ({ chunks: [{ id: key, text: key }] })), putJson: vi.fn(async (_key: string, _value: unknown) => {}), uri: (key: string) => `s3://bucket/${key}` };
  return { state, store, storage, stage: new GraphEnrichStage({} as CommandRunner, storage as unknown as ArtifactStore, { textGenerationModel: "test-model", openRouterApiKey: "mock" } as Config) };
}
function graph(): DocumentGraph { return { nodes: [], edges: [], chunkEntities: [], source: "llm", windows: 1, inputTokens: 10, outputTokens: 5, durationMs: 1 }; }
it.each([1, 2, 9])("caps configured concurrency at four (%s), preserves order and records each call", async (configured) => {
  const { state, stage, store, storage } = setup(configured);
  let active = 0, peak = 0, completed = 0;
  vi.mocked(extractDocumentGraph).mockImplementation(async ({ filename, context }) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 8 - Number(filename.split(".")[0])));
    context.onUsage?.({ inputTokens: 10, outputTokens: 5, costCents: 0.01 }, { window: 1, finishReason: "stop" });
    active--; completed++; return graph();
  });
  store.refreshWorkspaceCommunities.mockImplementation(async () => { expect(completed).toBe(6); expect(store.replaceDocumentGraph).toHaveBeenCalledTimes(6); return null; });
  await stage.run(state);
  expect(peak).toBe(Math.min(4, configured));
  expect(state.usageLedger.totals()).toMatchObject({ inputTokens: 60, outputTokens: 30 });
  expect(storage.putJson.mock.calls[0]?.[1]).toMatchObject({ documents: state.documents.map((doc) => ({ documentId: doc.id })) });
});
it("drains calls and retains usage after failure without scheduling more or refreshing communities", async () => {
  const { state, stage, store } = setup(2);
  let finished = false;
  vi.mocked(extractDocumentGraph).mockImplementation(async ({ filename, context }) => {
    if (filename === "0.txt") throw new Error("graph failed");
    await new Promise((resolve) => setTimeout(resolve, 5));
    context.onUsage?.({ inputTokens: 10, outputTokens: 5, costCents: 0.01 }, { window: 1, finishReason: "stop" });
    finished = true; return graph();
  });
  await expect(stage.run(state)).rejects.toThrow("graph failed");
  expect(finished).toBe(true);
  expect(extractDocumentGraph).toHaveBeenCalledTimes(2);
  expect(state.usageLedger.totals()).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  expect(store.refreshWorkspaceCommunities).not.toHaveBeenCalled();
});
it("does not read artifacts or call models when cancelled before scheduling", async () => {
  const { state, stage, storage } = setup(4);
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await expect(stage.run(state, controller.signal)).rejects.toThrow("cancelled");
  expect(storage.getJson).not.toHaveBeenCalled(); expect(extractDocumentGraph).not.toHaveBeenCalled();
});
