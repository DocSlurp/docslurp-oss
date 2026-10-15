/**
 * In-process HTTP response counters for this app instance: lifetime totals
 * (exported on /metrics as docslurp_http_responses_total) and a sliding
 * window that the alert evaluator reads for the 5xx-rate alert.
 *
 * Counts are per process. With several app machines each instance evaluates
 * its own window (see services/alerts/alert-evaluator.ts); Prometheus sums
 * the lifetime counters across instances.
 */

const BUCKET_MS = 10_000;
/** Longest window anyone may ask for; older buckets are dropped. */
const MAX_WINDOW_MS = 60 * 60_000;

export type StatusClass = "2xx" | "3xx" | "4xx" | "5xx" | "other";

type Bucket = { start: number; total: number; errors5xx: number };

export class HttpResponseStats {
  private buckets: Bucket[] = [];
  readonly totals: Record<StatusClass, number> = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 };

  record(status: number, now = Date.now()): void {
    const cls = statusClass(status);
    this.totals[cls] += 1;
    const start = now - (now % BUCKET_MS);
    let bucket = this.buckets[this.buckets.length - 1];
    if (!bucket || bucket.start !== start) {
      bucket = { start, total: 0, errors5xx: 0 };
      this.buckets.push(bucket);
      this.prune(now);
    }
    bucket.total += 1;
    if (cls === "5xx") bucket.errors5xx += 1;
  }

  /** Requests and 5xx responses in the last `windowMs` (bucket-granular). */
  window(windowMs: number, now = Date.now()): { total: number; errors5xx: number } {
    this.prune(now);
    const since = now - Math.min(windowMs, MAX_WINDOW_MS);
    let total = 0;
    let errors5xx = 0;
    for (const bucket of this.buckets) {
      if (bucket.start + BUCKET_MS <= since) continue;
      total += bucket.total;
      errors5xx += bucket.errors5xx;
    }
    return { total, errors5xx };
  }

  private prune(now: number): void {
    const cutoff = now - MAX_WINDOW_MS - BUCKET_MS;
    while (this.buckets.length > 0 && this.buckets[0]!.start < cutoff) this.buckets.shift();
  }
}

export function statusClass(status: number): StatusClass {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

export const httpResponseStats = new HttpResponseStats();
