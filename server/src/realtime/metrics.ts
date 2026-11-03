import { realtimeMetrics } from "./broker.js";
/** Fixed labels only: no user, resource, cookie or frame content. */
export function realtimeMetricLines(): string[] {
  const gauges = new Set(["connections", "subscriptions", "queuedBytes"]);
  return Object.entries(realtimeMetrics).flatMap(([key, value]) => {
    const name = `docslurp_realtime_${key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}`;
    return [`# TYPE ${name} ${gauges.has(key) ? "gauge" : "counter"}`, `${name} ${value}`];
  });
}
