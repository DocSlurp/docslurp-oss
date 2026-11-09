import type { RealtimeResource } from "@docslurp/shared";

/** A host detaches this observer on disconnect; close must never cancel work. */
export interface RealtimeOperationSubscription {
  close(): Promise<void>;
  /** Authorization-only sweep, independent of output/reconciliation progress. */
  revalidate(): Promise<void>;
}
export interface RealtimeOperationObserver {
  snapshot(data: unknown, sequence: number): Promise<void>;
  append(data: unknown, sequence: number): Promise<void>;
  resync(data: unknown, sequence: number, code: string): Promise<void>;
}
/** Implemented by the durable operation owner. References never confer authority.
 * Persist output before delivery, authorize every descendant, and atomically
 * capture replay/live boundary with a bounded concurrent-event buffer.
 */
export interface RealtimeOperationProvider {
  subscribe(input: {
    userId: string;
    resource: Extract<RealtimeResource, { kind: "operation" }>;
    signal: AbortSignal;
    observer: RealtimeOperationObserver;
  }): Promise<RealtimeOperationSubscription>;
}
