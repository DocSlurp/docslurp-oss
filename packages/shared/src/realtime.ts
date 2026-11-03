import { z } from "zod";

export const REALTIME_VERSION = 1 as const;
export const REALTIME_LIMITS = Object.freeze({
  frameBytes: 8_192, subscriptions: 32, queuedBytes: 1_048_576,
  snapshotBytes: 524_288, messagesPerMinute: 120,
  heartbeatMs: 15_000, authorizationRecheckMs: 5_000,
});
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const realtimeResourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("activity"), orgId: z.uuid() }).strict(),
  z.object({ kind: z.literal("run"), runId: z.uuid() }).strict(),
  z.object({ kind: z.literal("workspace"), workspaceId: z.uuid() }).strict(),
  z.object({ kind: z.literal("documents"), workspaceId: z.uuid(), page: z.number().int().min(0).max(1000).default(0) }).strict(),
  z.object({ kind: z.literal("billing"), orgId: z.uuid() }).strict(),
  z.object({ kind: z.literal("economics"), orgId: z.uuid(), page: z.number().int().min(0).max(1000).default(0) }).strict(),
  z.object({ kind: z.literal("operation"), operationId: z.uuid(), after: sequence.default(0) }).strict(),
]);
const envelope = { v: z.literal(REALTIME_VERSION), subscriptionId: id, generation: sequence };
export const realtimeClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("subscribe"), resource: realtimeResourceSchema }).strict(),
  z.object({ ...envelope, type: z.literal("unsubscribe") }).strict(),
  z.object({ v: z.literal(REALTIME_VERSION), type: z.literal("heartbeat") }).strict(),
]);
export type RealtimeResource = z.infer<typeof realtimeResourceSchema>;
export type RealtimeClientFrame = z.infer<typeof realtimeClientFrameSchema>;
export type RealtimeServerFrame =
  | { v: 1; type: "heartbeat"; epoch: string }
  | { v: 1; type: "ack" | "snapshot" | "upsert" | "remove" | "resync-required" | "error";
      subscriptionId: string; generation: number; epoch: string; revision: number;
      resource: RealtimeResource; data?: unknown; code?: string };

/** Reject oversized input before parsing; binary frames are rejected by the host. */
export function parseRealtimeClientFrame(text: string): RealtimeClientFrame {
  if (new TextEncoder().encode(text).byteLength > REALTIME_LIMITS.frameBytes) throw new Error("frame_too_large");
  return realtimeClientFrameSchema.parse(JSON.parse(text));
}
