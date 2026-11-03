import { describe, expect, it } from "vitest";
import { parseRealtimeClientFrame, REALTIME_LIMITS } from "./realtime.js";

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
