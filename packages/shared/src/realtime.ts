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
  z.object({ kind: z.literal("suggestions"), workspaceId: z.uuid() }).strict(),
  z.object({ kind: z.literal("viewer"), documentId: z.uuid() }).strict(),
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

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().nonnegative();
const stamp = z.string().min(1).max(64);
export const realtimeSuggestionsSnapshotSchema = z.object({
  suggestions: z.array(z.string().max(1024)).max(8),
  contextualSuggestions: z.array(z.string().max(1024)).max(8),
  contextualPending: z.boolean().optional(),
  semantic: z.object({ status: z.enum(["none", "partial", "ready"]), indexedChunkCount: count,
    completedDocuments: count, totalDocuments: count }).strict(),
}).strict();
const usage = z.object({ inputTokens: count, outputTokens: count, costCents: amount, events: count }).strict();
export const realtimeViewerSnapshotSchema = z.object({
  document: z.object({
    id: z.string().max(128), workspaceId: z.string().max(128), runId: z.string().max(128).nullable(),
    status: z.string().max(64), title: z.string().max(1024).nullable(), statusReason: z.string().max(2048).nullable(),
    pageCount: count, versionNumber: count, previousVersionId: z.string().max(128).nullable(),
    supersededAt: stamp.nullable(), supersededByDocumentId: z.string().max(128).nullable(), updatedAt: stamp,
  }).strict(),
  tags: z.array(z.string().max(128)).max(64),
  stages: z.array(z.object({ stage_name: z.string().max(128), status: z.string().max(64), attempts: count,
    error: z.string().max(2048).nullable(), updated_at: stamp }).strict()).max(64),
  pageStats: z.object({ pageCount: count, chunkCount: count, pageTextCount: count }).strict(),
  run: z.object({ id: z.string().max(128), workspaceId: z.string().max(128), stage: z.string().max(128),
    status: z.string().max(64), updatedAt: stamp }).strict().nullable(),
  usage: z.object({ document: usage, run: usage.extend({ computeEstimated: z.boolean(), totalDocuments: count }).nullable(),
    estimatedDocument: usage.omit({ events: true }).extend({ basis: z.enum(["document-events", "run-average", "none"]) }) }).strict(),
}).strict();
export type RealtimeSuggestionsSnapshot = z.infer<typeof realtimeSuggestionsSnapshotSchema>;
export type RealtimeViewerSnapshot = z.infer<typeof realtimeViewerSnapshotSchema>;
