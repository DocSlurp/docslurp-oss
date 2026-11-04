import { describe, expect, it } from "vitest";
import { parseRealtimeClientFrame, realtimeSuggestionsSnapshotSchema, realtimeViewerSnapshotSchema, REALTIME_LIMITS } from "./realtime.js";

const subscribe = { v: 1, type: "subscribe", subscriptionId: "run", generation: 1,
  resource: { kind: "run", runId: "00000000-0000-4000-8000-000000000001" } };
describe("realtime wire input", () => {
  it("accepts bounded versioned subscriptions", () => {
    expect(parseRealtimeClientFrame(JSON.stringify(subscribe))).toEqual(subscribe);
  });
  it.each([
    { ...subscribe, v: 2 }, { ...subscribe, generation: -1 },
    { ...subscribe, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...subscribe, authorization: "secret" },
    { ...subscribe, resource: { kind: "run", runId: "../other" } },
    { ...subscribe, resource: { ...subscribe.resource, userId: "other" } },
    { ...subscribe, type: "cancel" },
  ])("rejects malformed or authority-bearing fields", frame => {
    expect(() => parseRealtimeClientFrame(JSON.stringify(frame))).toThrow();
  });
  it("rejects malformed JSON and oversized UTF-8 before parsing", () => {
    expect(() => parseRealtimeClientFrame("{")).toThrow();
    expect(() => parseRealtimeClientFrame("é".repeat(REALTIME_LIMITS.frameBytes / 2 + 1))).toThrow("frame_too_large");
  });
  it("allows detach without introducing a cancellation command", () => {
    expect(parseRealtimeClientFrame(JSON.stringify({ v: 1, type: "unsubscribe", subscriptionId: "run", generation: 1 })).type).toBe("unsubscribe");
  });
});

it("strictly bounds suggestions and rejects viewer artifact fields", () => {
  const suggestions = {suggestions:["Question"],contextualSuggestions:[],semantic:{status:"ready",indexedChunkCount:1,completedDocuments:1,totalDocuments:1}};
  expect(realtimeSuggestionsSnapshotSchema.safeParse(suggestions).success).toBe(true);
  expect(realtimeSuggestionsSnapshotSchema.safeParse({...suggestions,suggestions:Array(9).fill("Question")}).success).toBe(false);
  expect(realtimeSuggestionsSnapshotSchema.safeParse({...suggestions,suggestions:["x".repeat(1025)]}).success).toBe(false);
  expect(realtimeSuggestionsSnapshotSchema.safeParse({...suggestions,secret:"unexpected"}).success).toBe(false);
  const viewer = {
    document: { id: "doc", workspaceId: "workspace", runId: null, status: "processing", title: null,
      statusReason: null, pageCount: 0, versionNumber: 1, previousVersionId: null, supersededAt: null,
      supersededByDocumentId: null, updatedAt: "2026-11-03T00:00:00Z" },
    tags: [], stages: [], pageStats: { pageCount: 0, chunkCount: 0, pageTextCount: 0 }, run: null,
    usage: { document: { inputTokens: 0, outputTokens: 0, costCents: 0, events: 0 }, run: null,
      estimatedDocument: { inputTokens: 0, outputTokens: 0, costCents: 0, basis: "none" } },
  };
  expect(realtimeViewerSnapshotSchema.safeParse(viewer).success).toBe(true);
  expect(realtimeViewerSnapshotSchema.safeParse({...viewer,artifacts:[{url:"private"}]}).success).toBe(false);
  expect(realtimeViewerSnapshotSchema.safeParse({...viewer,document:{...viewer.document,sourceKey:"private"}}).success).toBe(false);
  expect(realtimeViewerSnapshotSchema.safeParse({...viewer,tags:Array(65).fill("tag")}).success).toBe(false);
});
