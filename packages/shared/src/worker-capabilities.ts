/**
 * Worker capability handshake (docs/releases.md#app-and-worker-skew,
 * migration 0055).
 *
 * Some features need both sides: the app records a choice into Temporal
 * workflow input (stage order, stage grouping) or acts on behalf of the worker
 * (the first credit lease, serving search from worker-stamped columns), and
 * only workers built with the matching code honour it. Turning such a flag on
 * while an older worker still polls the task queue breaks runs.
 *
 * Instead of ordering deploys by hand, every worker advertises what its build
 * supports (worker_capabilities: build id, capability keys, last heartbeat).
 * The app enables a gated feature only when it is configured on AND every
 * worker that can pick up the run supports it:
 *
 * - "Every worker" = the live pollers Temporal reports on the run's task
 *   queue(s). A poller with no fresh registry row (a build that predates the
 *   handshake, or a heartbeat that stopped) supports nothing, as does one
 *   whose Temporal build id differs from its row.
 * - With no live poller (fleet scaled to zero) the workers seen in the last
 *   `recentWindowMs` stand in, intersected, so a fleet that just scaled in
 *   keeps its features but an old build seen recently still holds them back.
 * - Anything unknown (Temporal or the registry unreachable, no workers ever
 *   seen) resolves to no capabilities: the old behaviour.
 *
 * Turning a flag on early is therefore harmless: it activates once the fleet
 * has rolled. An old worker reappearing (rollback) turns it back off for new
 * runs. Runs already started keep what their input recorded.
 */

/** Bump only for an incompatible change to the registry row format. */
export const WORKER_CAPABILITY_PROTOCOL = 1;

export const WORKER_CAPABILITIES = [
  /** Runs `index` right after `embed` and keeps indexed documents `completed` through enrichment. */
  "workflow.index-before-enrich",
  /** Groups arbitrary adjacent stages into one activity (stage-groups.ts), not only LIGHT_STAGES. */
  "workflow.group-adjacent-stages",
  /** Plans and runs page-range shards of long documents (pageRangeSharding in workflow input). */
  "workflow.page-range-shards",
  /** Consumes and renews org credit leases (schema 0052 + 0053 present and leases on in this worker). */
  "billing.credit-leases",
  /** Stamps documents.lexical_searchable_at at embed (schema 0051). */
  "search.early-lexical",
] as const;

export type WorkerCapability = (typeof WORKER_CAPABILITIES)[number];

export function isWorkerCapability(value: string): value is WorkerCapability {
  return (WORKER_CAPABILITIES as readonly string[]).includes(value);
}

export interface GatedFeature {
  /** Env flag that configures the feature (read by the app). */
  flag: string;
  capability: WorkerCapability;
  description: string;
}

/** Flags the app only honours once the whole fleet supports them. */
export const GATED_FEATURES: readonly GatedFeature[] = [
  {
    flag: "WORKER_INDEX_BEFORE_ENRICH",
    capability: "workflow.index-before-enrich",
    description: "stage order recorded in workflow input: index right after embed",
  },
  {
    flag: "WORKER_GROUP_ADJACENT_STAGES",
    capability: "workflow.group-adjacent-stages",
    description: "groupableStages recorded in workflow input",
  },
  {
    flag: "WORKER_PAGE_RANGE_SHARDS",
    capability: "workflow.page-range-shards",
    description: "pageRangeSharding recorded in workflow input: long documents split into page-range shards",
  },
  {
    flag: "WORKER_CREDIT_LEASES",
    capability: "billing.credit-leases",
    description: "first credit lease granted at run admission and spend resume",
  },
  {
    flag: "SEARCH_EARLY_LEXICAL",
    capability: "search.early-lexical",
    description: "keyword search serves documents before the index stage completes",
  },
];

/** One worker_capabilities row, times in epoch ms. */
export interface WorkerCapabilityRecord {
  instanceId: string;
  /** Temporal worker identity; matches the poller identity Temporal reports. */
  identity: string;
  taskQueue: string;
  buildId: string | null;
  protocol: number;
  capabilities: string[];
  lastSeenAt: number;
  stoppedAt: number | null;
}

export interface FleetPoller {
  identity: string;
  /** Epoch ms of the last poll, or null when the server omits it. */
  lastAccessMs: number | null;
  /** Build id the poller reported to Temporal, when known. */
  buildId?: string | null;
}

export interface FleetCapabilityOptions {
  /** A registry row this fresh vouches for a live poller. */
  liveWindowMs: number;
  /** With no live poller, workers seen this recently stand in for the fleet. */
  recentWindowMs: number;
  /** Pollers last seen longer ago than this are not live. */
  pollerStaleMs: number;
  /** "none": an idle fleet resolves to no capabilities. */
  idleFallback: "recent" | "none";
}

/** Polls this soon after a registry stop are the stopping process's last ones. */
const STOPPED_POLLER_GRACE_MS = 5_000;

export const DEFAULT_FLEET_CAPABILITY_OPTIONS: FleetCapabilityOptions = {
  liveWindowMs: 90_000,
  recentWindowMs: 6 * 60 * 60_000,
  pollerStaleMs: 180_000,
  idleFallback: "recent",
};

export interface FleetWorkerView {
  identity: string;
  buildId: string | null;
  registered: boolean;
  capabilities: WorkerCapability[];
  /** Why this worker contributes no capabilities, when it does not. */
  note?: string;
}

export interface FleetCapabilitySnapshot {
  capabilities: WorkerCapability[];
  /**
   * pollers:  intersection over live Temporal pollers
   * recent:   no live poller; intersection over recently seen workers
   * unknown:  nothing to go on (fail-safe: no capabilities)
   */
  basis: "pollers" | "recent" | "unknown";
  reason: string;
  workers: FleetWorkerView[];
}

function knownCapabilities(record: WorkerCapabilityRecord): WorkerCapability[] {
  if (record.protocol !== WORKER_CAPABILITY_PROTOCOL) return [];
  return [...new Set(record.capabilities.filter(isWorkerCapability))].sort();
}

function intersect(sets: WorkerCapability[][]): WorkerCapability[] {
  if (sets.length === 0) return [];
  let result = new Set(sets[0]);
  for (const set of sets.slice(1)) {
    const next = new Set(set);
    result = new Set([...result].filter((capability) => next.has(capability)));
  }
  return [...result].sort();
}

/**
 * Pure: the capabilities every worker that can pick up a run supports.
 * `pollers` null means Temporal could not be observed (fail-safe: unknown).
 */
export function intersectFleetCapabilities(input: {
  now: number;
  records: WorkerCapabilityRecord[];
  pollers: FleetPoller[] | null;
  options?: Partial<FleetCapabilityOptions>;
}): FleetCapabilitySnapshot {
  const options = { ...DEFAULT_FLEET_CAPABILITY_OPTIONS, ...input.options };
  if (input.pollers === null) {
    return { capabilities: [], basis: "unknown", reason: "Temporal pollers could not be observed", workers: [] };
  }
  const latestByIdentity = new Map<string, WorkerCapabilityRecord>();
  for (const record of input.records) {
    const previous = latestByIdentity.get(record.identity);
    if (!previous || record.lastSeenAt > previous.lastSeenAt) latestByIdentity.set(record.identity, record);
  }

  const live = new Map<string, FleetPoller>();
  for (const poller of input.pollers) {
    if (!poller.identity) continue;
    const fresh = poller.lastAccessMs === null || input.now - poller.lastAccessMs <= options.pollerStaleMs;
    if (!fresh || live.has(poller.identity)) continue;
    // Temporal keeps listing a poller for a few minutes after its process exits. A process
    // that marked its registry row stopped, and has not polled since, cannot pick up a run.
    const record = latestByIdentity.get(poller.identity);
    const stoppedCleanly =
      record?.stoppedAt != null &&
      poller.lastAccessMs !== null &&
      poller.lastAccessMs <= record.stoppedAt + STOPPED_POLLER_GRACE_MS;
    if (stoppedCleanly) continue;
    live.set(poller.identity, poller);
  }

  if (live.size > 0) {
    const workers: FleetWorkerView[] = [...live.values()].map((poller) => {
      const record = latestByIdentity.get(poller.identity);
      const buildId = poller.buildId || record?.buildId || null;
      if (!record) {
        return { identity: poller.identity, buildId, registered: false, capabilities: [], note: "not registered (older build?)" };
      }
      if (record.stoppedAt != null) {
        return { identity: poller.identity, buildId, registered: true, capabilities: [], note: "registry row stopped but the poller is still active" };
      }
      if (input.now - record.lastSeenAt > options.liveWindowMs) {
        return { identity: poller.identity, buildId, registered: true, capabilities: [], note: "registry heartbeat is stale" };
      }
      if (poller.buildId && record.buildId && poller.buildId !== record.buildId) {
        return { identity: poller.identity, buildId, registered: true, capabilities: [], note: `Temporal build ${poller.buildId} differs from registered ${record.buildId}` };
      }
      if (record.protocol !== WORKER_CAPABILITY_PROTOCOL) {
        return { identity: poller.identity, buildId, registered: true, capabilities: [], note: `registry protocol ${record.protocol} is not ${WORKER_CAPABILITY_PROTOCOL}` };
      }
      return { identity: poller.identity, buildId, registered: true, capabilities: knownCapabilities(record) };
    }).sort((a, b) => a.identity.localeCompare(b.identity));
    return {
      capabilities: intersect(workers.map((worker) => worker.capabilities)),
      basis: "pollers",
      reason: `${workers.length} live worker(s) on the task queue`,
      workers,
    };
  }

  if (options.idleFallback === "none") {
    return { capabilities: [], basis: "unknown", reason: "no live pollers (idle fallback disabled)", workers: [] };
  }
  const recent = [...latestByIdentity.values()]
    .filter((record) => input.now - record.lastSeenAt <= options.recentWindowMs)
    .sort((a, b) => a.identity.localeCompare(b.identity));
  if (recent.length === 0) {
    return { capabilities: [], basis: "unknown", reason: "no live pollers and no recently seen workers", workers: [] };
  }
  const workers = recent.map((record) => ({
    identity: record.identity,
    buildId: record.buildId,
    registered: true,
    capabilities: knownCapabilities(record),
  }));
  return {
    capabilities: intersect(workers.map((worker) => worker.capabilities)),
    basis: "recent",
    reason: `no live pollers; ${workers.length} worker(s) seen in the last ${Math.round(options.recentWindowMs / 60_000)} min`,
    workers,
  };
}

export interface GatedFeatureState {
  flag: string;
  capability: WorkerCapability;
  configured: boolean;
  supported: boolean;
  effective: boolean;
}

/** Pure: configured AND supported, per gated flag. `capabilities` null = gate off (configured wins). */
export function gatedFeatureStates(
  configured: Record<string, boolean>,
  capabilities: ReadonlySet<WorkerCapability> | null,
): GatedFeatureState[] {
  return GATED_FEATURES.map((feature) => {
    const isConfigured = configured[feature.flag] === true;
    const supported = capabilities === null || capabilities.has(feature.capability);
    return { flag: feature.flag, capability: feature.capability, configured: isConfigured, supported, effective: isConfigured && supported };
  });
}
