import { realtimeMetrics, realtimeCloseReasons, realtimeProjectionBuckets } from "./broker.js";
/** Fixed labels only: no user, resource, cookie or frame content. */
export function realtimeMetricLines(): string[] {
  const gauges = new Set(["connections", "subscriptions", "queuedBytes"]);
  const lines = Object.entries(realtimeMetrics).flatMap(([key, value]) => {
    const name = `docslurp_realtime_${key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}`;
    return [`# TYPE ${name} ${gauges.has(key) ? "gauge" : "counter"}`, `${name} ${value}`];
  });
  lines.push("# TYPE docslurp_realtime_disconnects counter");
  for (const [reason, count] of Object.entries(realtimeCloseReasons)) lines.push(`docslurp_realtime_disconnects{reason="${reason}"} ${count}`);
  lines.push("# TYPE docslurp_realtime_projection_duration_ms histogram");
  for (const bucket of realtimeProjectionBuckets) lines.push(`docslurp_realtime_projection_duration_ms_bucket{le="${Number.isFinite(bucket.le) ? bucket.le : "+Inf"}"} ${bucket.count}`);
  lines.push(`docslurp_realtime_projection_duration_ms_sum ${realtimeMetrics.projectionMs}`,
    `docslurp_realtime_projection_duration_ms_count ${realtimeMetrics.snapshots}`);
  return lines;
}
