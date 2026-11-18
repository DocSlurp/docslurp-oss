import { emitTelemetryLog, recordUploadTelemetry } from "@docslurp/shared/observability";

/**
 * Direct-upload telemetry: bounded metrics for dashboards and one structured log per event (ids on the log only).
 * Event names (SigNoz `event.name`) and metric names are listed in the waves PR and docs/self-host/operations.md.
 */
export type UploadEvent =
  | "wave"              // a wave ended: outcome committed | adopted | refused | rejected | failed | fenced
  | "webhook_finalize"  // a webhook-driven finalize: outcome completed | not_ready | failed | busy | retry | skipped
  | "webhook_key"       // a webhook key: outcome queued | duplicate | refused_key | unknown_key | dropped
  | "fallback_finalize" // a reconciler fallback finalize: same outcomes as webhook_finalize
  | "lease_contention"  // a finalizer found a file leased by another: path client | webhook | fallback | recovery
  | "expiry"            // an expired session: outcome flushed | refused | aborted | confirmed | retry
  | "session_closed";   // a session ended: outcome confirmed | partial | failed | aborted

const counterNames: Record<UploadEvent, string> = {
  wave: "waves",
  webhook_finalize: "webhook_finalizes",
  webhook_key: "webhook_keys",
  fallback_finalize: "fallback_finalizes",
  lease_contention: "lease_contentions",
  expiry: "expiries",
  session_closed: "sessions_closed",
};

/** Counts one event; `log` adds a structured log line (with ids) for events worth reading one by one. */
export function uploadEvent(event: UploadEvent, labels: Record<string, string>, log?: { severity?: "info" | "warn" | "error"; body: string; attributes?: Record<string, string | number | boolean> }): void {
  recordUploadTelemetry(counterNames[event], 1, labels);
  if (!log) return;
  emitTelemetryLog({
    severityText: log.severity ?? "info",
    eventName: `docslurp.upload.${event}`,
    body: log.body,
    attributes: { ...Object.fromEntries(Object.entries(labels).map(([key, value]) => [`docslurp.upload.${key}`, value])), ...(log.attributes ?? {}) },
  });
}

/** Files per committed wave (histogram). */
export function recordWaveFiles(files: number, labels: Record<string, string>): void {
  recordUploadTelemetry("wave_files", files, labels, "histogram");
}

/** How long a caller waited for a session lock, by lock class and outcome (histogram, seconds). */
export function recordLockWait(seconds: number, lockClass: string, outcome: "acquired" | "busy"): void {
  recordUploadTelemetry("lock_wait", seconds, { lock_class: lockClass, outcome }, "histogram", "s");
}

/**
 * A bounded, secret-free class for an error: `intake:<status>:<code>`, `billing:<code>`, `postgres:<sqlstate>`,
 * `storage:<name>`, `abort`, else the error's constructor name. Never the message (provider text can carry secrets).
 */
export function errorClass(error: unknown): string {
  if (!error || typeof error !== "object") return typeof error;
  const e = error as { name?: unknown; code?: unknown; statusCode?: unknown; $metadata?: unknown };
  const name = typeof e.name === "string" ? e.name : (error as object).constructor?.name ?? "Error";
  if (name === "ProjectIntakeError") return `intake:${String(e.statusCode)}:${typeof e.code === "string" ? e.code : "none"}`;
  if (name === "RunCreationBlockedError" || name === "SpendBlockedError") return `billing:${typeof e.code === "string" ? e.code : "blocked"}`;
  if (name === "PostgresError" || (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code))) return `postgres:${typeof e.code === "string" ? e.code : "unknown"}`;
  if (name === "AbortError" || name === "TimeoutError") return "abort";
  if (e.$metadata) return `storage:${name}`;
  return name.slice(0, 64);
}
