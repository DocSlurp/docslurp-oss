import type { ProjectRun, ProjectRunProgressSnapshot } from "@docslurp/shared";

/** Streaming progress carries measurements, not arbitrary worker diagnostics.
 * Full diagnostics and artifact references remain available through authorized
 * detail reads. Keep the transport frame limit unchanged. */
function measurements(stats: Record<string, unknown>): Record<string, number> {
  const keys = ["percentComplete", "completedStages", "totalStages", "failedStages", "failedDocuments",
    "documents", "pages", "completedPages", "totalPages", "durationMs", "latencyMs", "inputTokens", "outputTokens",
    "costCents", "cpuUserMs", "cpuSystemMs", "cpuTotalMs", "rssDeltaBytes", "peakRssBytes"];
  return Object.fromEntries(keys.flatMap(key => {
    const value = stats[key];
    return typeof value === "number" && Number.isFinite(value) ? [[key, value]] : [];
  }));
}

export function realtimeRunRecord(run: ProjectRun): ProjectRun {
  return { ...run, stats: measurements(run.stats), artifacts: {} };
}

export function realtimeRunProgress(snapshot: ProjectRunProgressSnapshot): ProjectRunProgressSnapshot {
  return {
    ...snapshot,
    run: realtimeRunRecord(snapshot.run),
    stats: measurements(snapshot.stats),
    artifacts: {},
    stages: snapshot.stages.map(stage => ({ ...stage, stats: measurements(stage.stats), artifactUri: null })),
    recentEvents: snapshot.recentEvents.map(event => ({
      ...event, stats: measurements(event.stats), progress: {}, payload: {},
    })),
  };
}
