import { CREDIT_RATE_CARD, priceResources } from "@docslurp/shared";

import { resolveActivityConcurrency } from "../concurrency.js";
import type { JsonMap, PerformanceEvent, UsageEvent } from "../models.js";

const BYTES_PER_GB = 1024 ** 3;
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;

export type DeploymentLane = "lean" | "heavy" | "development";

export interface LocalComputeRates {
  cpuCentsPerSecond: number;
  memoryCentsPerGbSecond: number;
  gpuCentsPerSecond: number;
  storageCentsPerGbMonth: number;
  networkIngressCentsPerGb: number;
  networkEgressCentsPerGb: number;
}

export interface WorkerDeploymentProfile {
  id: string;
  lane: DeploymentLane;
  workerClass: string;
  region: string;
  image: string;
  allocatedVcpu: number;
  allocatedMemoryGb: number;
  rates: LocalComputeRates;
}

export interface LocalResourceObservation {
  cpuSeconds?: number;
  memoryGbSeconds?: number;
  gpuSeconds?: number;
  storageBytes?: number;
  storageDurationSeconds?: number;
  networkIngressBytes?: number;
  networkEgressBytes?: number;
  wallTimeMs?: number;
  pages?: number;
  cold?: boolean;
}

export interface LocalComputeCost {
  totalCents: number;
  breakdown: {
    cpuCents: number;
    memoryCents: number;
    gpuCents: number;
    storageCents: number;
    networkIngressCents: number;
    networkEgressCents: number;
  };
}

export function buildAllocatedResourceObservation(args: {
  profile: WorkerDeploymentProfile;
  wallTimeMs: number;
  pages?: number;
  cold?: boolean;
}): LocalResourceObservation {
  const wallTimeMs = finiteNonNegative(args.wallTimeMs);
  const wallSeconds = wallTimeMs / 1000;
  return {
    cpuSeconds: wallSeconds * args.profile.allocatedVcpu,
    memoryGbSeconds: wallSeconds * args.profile.allocatedMemoryGb,
    wallTimeMs,
    pages: finiteNonNegative(args.pages),
    cold: args.cold ?? false,
  };
}

const DEFAULT_RATES: LocalComputeRates = {
  // Provider-neutral defaults. Production should override these with the
  // marginal rates for the deployed worker class.
  cpuCentsPerSecond: 0.001,
  memoryCentsPerGbSecond: 0.0001,
  gpuCentsPerSecond: 0.05,
  storageCentsPerGbMonth: 2,
  networkIngressCentsPerGb: 0,
  networkEgressCentsPerGb: 2,
};

/** Published Fly shared-machine list rates; configurable overrides still win. */
export function flySharedComputeRates(at = new Date()): Pick<LocalComputeRates, "cpuCentsPerSecond" | "memoryCentsPerGbSecond"> {
  const updated = at.getTime() >= Date.parse("2026-10-01T00:00:00Z");
  const memoryDollarsPerGbMonth = updated ? 6 : 5;
  const twoCpuBaseDollarsPerHour = updated ? 0.0061 : 0.0054;
  // The base preset already includes 0.5 GB. Remove that allowance from
  // the CPU component before pricing the full configured memory capacity.
  return {
    cpuCentsPerSecond: ((twoCpuBaseDollarsPerHour - 0.5 * memoryDollarsPerGbMonth / 720) / 2) * 100 / 3600,
    memoryCentsPerGbSecond: memoryDollarsPerGbMonth * 100 / SECONDS_PER_MONTH,
  };
}

/** Machine capacity divided by concurrent activity slots, when both are configured. */
export function perSlotShare(machineTotal: string | undefined, slots: string | number | undefined): number | null {
  const total = Number.parseFloat(machineTotal ?? "");
  const count = typeof slots === "number" ? slots : Number.parseInt(slots ?? "", 10);
  if (!Number.isFinite(total) || total <= 0) return null;
  return total / (Number.isFinite(count) && count > 0 ? count : 1);
}

export function resolveWorkerDeploymentProfile(
  env: NodeJS.ProcessEnv = process.env,
  /** The worker's real slot count; defaults to the same resolution `config.workerActivityConcurrency` uses. */
  activitySlots: number = resolveActivityConcurrency(env),
): WorkerDeploymentProfile {
  const lane = resolveDeploymentLane(env.DOCSLURP_DEPLOYMENT_PROFILE, env.NODE_ENV);
  const workerClass = readText(env.DOCSLURP_WORKER_CLASS)
    ?? readText(env.FLY_VM_SIZE)
    ?? "unknown";
  const region = readText(env.DOCSLURP_WORKER_REGION)
    ?? readText(env.FLY_REGION)
    ?? "local";
  const image = readText(env.DOCSLURP_WORKER_IMAGE)
    ?? (lane === "heavy" ? "worker-full" : lane === "lean" ? "worker-lean" : "development");

  const defaults = env.DOCSLURP_COMPUTE_RATE_CARD === "fly-shared"
    ? { ...DEFAULT_RATES, ...flySharedComputeRates(), gpuCentsPerSecond: 0, storageCentsPerGbMonth: 15 }
    : DEFAULT_RATES;

  return {
    id: `${lane}:${workerClass}:${region}`,
    lane,
    workerClass,
    region,
    image,
    // Allocation is per activity (one worker slot), not per machine: a task on
    // an 8-slot shared-cpu-8x/16 GB machine is billed 1 vCPU and 2 GB.
    allocatedVcpu: readPositiveNumber(
      env.DOCSLURP_ALLOCATED_VCPU,
      perSlotShare(env.DOCSLURP_MACHINE_VCPU, activitySlots) ?? (lane === "heavy" ? 2 : 1),
    ),
    allocatedMemoryGb: readPositiveNumber(
      env.DOCSLURP_ALLOCATED_MEMORY_GB,
      perSlotShare(env.DOCSLURP_MACHINE_MEMORY_GB, activitySlots) ?? (lane === "heavy" ? 4 : 1),
    ),
    rates: {
      cpuCentsPerSecond: readNonNegativeNumber(env.DOCSLURP_CPU_CENTS_PER_SECOND, defaults.cpuCentsPerSecond),
      memoryCentsPerGbSecond: readNonNegativeNumber(
        env.DOCSLURP_MEMORY_CENTS_PER_GB_SECOND,
        defaults.memoryCentsPerGbSecond,
      ),
      gpuCentsPerSecond: readNonNegativeNumber(env.DOCSLURP_GPU_CENTS_PER_SECOND, defaults.gpuCentsPerSecond),
      storageCentsPerGbMonth: readNonNegativeNumber(
        env.DOCSLURP_STORAGE_CENTS_PER_GB_MONTH,
        defaults.storageCentsPerGbMonth,
      ),
      networkIngressCentsPerGb: readNonNegativeNumber(
        env.DOCSLURP_NETWORK_INGRESS_CENTS_PER_GB,
        DEFAULT_RATES.networkIngressCentsPerGb,
      ),
      networkEgressCentsPerGb: readNonNegativeNumber(
        env.DOCSLURP_NETWORK_EGRESS_CENTS_PER_GB,
        DEFAULT_RATES.networkEgressCentsPerGb,
      ),
    },
  };
}

export function calculateLocalComputeCost(
  observation: LocalResourceObservation,
  rates: LocalComputeRates,
): LocalComputeCost {
  const cpuCents = finiteNonNegative(observation.cpuSeconds) * rates.cpuCentsPerSecond;
  const memoryCents = finiteNonNegative(observation.memoryGbSeconds) * rates.memoryCentsPerGbSecond;
  const gpuCents = finiteNonNegative(observation.gpuSeconds) * rates.gpuCentsPerSecond;
  const storageCents =
    (finiteNonNegative(observation.storageBytes) / BYTES_PER_GB)
    * (finiteNonNegative(observation.storageDurationSeconds) / SECONDS_PER_MONTH)
    * rates.storageCentsPerGbMonth;
  const networkIngressCents =
    (finiteNonNegative(observation.networkIngressBytes) / BYTES_PER_GB)
    * rates.networkIngressCentsPerGb;
  const networkEgressCents =
    (finiteNonNegative(observation.networkEgressBytes) / BYTES_PER_GB)
    * rates.networkEgressCentsPerGb;

  const breakdown = {
    cpuCents,
    memoryCents,
    gpuCents,
    storageCents,
    networkIngressCents,
    networkEgressCents,
  };

  return {
    totalCents: Object.values(breakdown).reduce((total, value) => total + value, 0),
    breakdown,
  };
}

// Published by the app in billing_runtime when Stripe is configured; refreshed
// by the worker (see refreshMeteringEnforcement in temporal/worker.ts).
let meteringEnforced = false;
let warnedOverride = false;

export function setMeteringEnforced(value: boolean): void {
  if (value !== meteringEnforced) console.log(`[billing] worker metering_enforced=${value}`);
  meteringEnforced = value;
}

/**
 * Worker CPU/RAM/GPU is billed at list (rate card) prices when the app has
 * enforced metering (Stripe configured), or when `DOCSLURP_BILL_COMPUTE=true`
 * turns it on without Stripe. An explicit `false` cannot disable enforcement.
 */
export function isComputeBillingEnabled(
  env: NodeJS.ProcessEnv = process.env,
  enforced: boolean = meteringEnforced,
): boolean {
  const flag = env.DOCSLURP_BILL_COMPUTE?.trim().toLowerCase();
  if (enforced) {
    if (flag === "false" && !warnedOverride) {
      warnedOverride = true;
      console.warn("[billing] DOCSLURP_BILL_COMPUTE=false ignored: metering is enforced while Stripe is configured");
    }
    return true;
  }
  return flag === "true";
}

/**
 * Local compute as a Usage Event. By default it records raw infrastructure
 * cost for telemetry only (`billable: false`, persisted at 0). With
 * DOCSLURP_BILL_COMPUTE=true the same observation is priced in credits by the
 * shared rate card, billed, and the infrastructure cost is kept in
 * `metadata.infraCostCents` for margin reporting. GPU seconds are priced at
 * the standard (24 GB class) rate. `costRollup: "included"` events stay at 0
 * either way: their compute is already counted by an authoritative event.
 */
export function buildLocalComputeUsageEvent(args: {
  metric: string;
  observation: LocalResourceObservation;
  profile?: WorkerDeploymentProfile;
  metadata?: JsonMap;
  costRollup?: "authoritative" | "included";
  env?: NodeJS.ProcessEnv;
}): UsageEvent {
  const profile = args.profile ?? resolveWorkerDeploymentProfile();
  const cost = calculateLocalComputeCost(args.observation, profile.rates);
  const billed = isComputeBillingEnabled(args.env);
  const listCharge = billed
    ? priceResources({
        cpuSeconds: args.observation.cpuSeconds,
        memoryGbSeconds: args.observation.memoryGbSeconds,
        gpuStandardSeconds: args.observation.gpuSeconds,
      })
    : null;
  const chargedCents = listCharge ? listCharge.totalCredits : cost.totalCents;

  return {
    provider: "local-compute",
    model: profile.id,
    metric: args.metric,
    amount: chargedCents,
    unit: "cent",
    costCents: args.costRollup === "included" ? 0 : chargedCents,
    metadata: {
      deploymentProfile: profile.id,
      deploymentLane: profile.lane,
      workerClass: profile.workerClass,
      region: profile.region,
      image: profile.image,
      allocatedVcpu: profile.allocatedVcpu,
      allocatedMemoryGb: profile.allocatedMemoryGb,
      rates: profile.rates,
      resources: normalizeObservation(args.observation),
      costBreakdownCents: cost.breakdown,
      effectiveCostCents: cost.totalCents,
      costRollup: args.costRollup ?? "authoritative",
      billable: billed,
      costSource: "estimate",
      rateCard: process.env.DOCSLURP_COMPUTE_RATE_CARD ?? "configured-or-generic",
      rateObservedAt: new Date().toISOString(),
      ...(listCharge
        ? {
            infraCostCents: cost.totalCents,
            rateCardVersion: CREDIT_RATE_CARD.version,
            listCreditBreakdown: listCharge.breakdown,
          }
        : {}),
      ...args.metadata,
    },
  };
}

export function buildLocalComputePerformanceEvents(args: {
  scope: string;
  stageName: string;
  documentId?: string;
  observation: LocalResourceObservation;
  profile?: WorkerDeploymentProfile;
  metadata?: JsonMap;
}): PerformanceEvent[] {
  const profile = args.profile ?? resolveWorkerDeploymentProfile();
  const observation = normalizeObservation(args.observation);
  const cost = calculateLocalComputeCost(observation, profile.rates);
  const pages = Math.max(0, observation.pages ?? 0);
  const wallMinutes = finiteNonNegative(observation.wallTimeMs) / 60_000;
  const costDollars = cost.totalCents / 100;
  const common = {
    documentId: args.documentId,
    scope: args.scope,
    stageName: args.stageName,
    tags: ["local-compute", profile.lane, observation.cold ? "cold" : "warm"],
    metadata: {
      deploymentProfile: profile.id,
      workerClass: profile.workerClass,
      region: profile.region,
      image: profile.image,
      allocatedVcpu: profile.allocatedVcpu,
      allocatedMemoryGb: profile.allocatedMemoryGb,
      ...args.metadata,
    },
  };
  const events: PerformanceEvent[] = [
    { ...common, metric: "local-compute-cost", value: cost.totalCents, unit: "cent" },
    { ...common, metric: "local-cpu-time", value: observation.cpuSeconds ?? 0, unit: "second" },
    { ...common, metric: "local-memory-time", value: observation.memoryGbSeconds ?? 0, unit: "gb-second" },
  ];

  if (pages > 0 && wallMinutes > 0) {
    const pagesPerMinute = pages / wallMinutes;
    events.push(
      { ...common, metric: "pages-per-minute", value: pagesPerMinute, unit: "page/minute" },
      { ...common, metric: "time-to-ingest-100-pages", value: 100 / pagesPerMinute, unit: "minute" },
    );
  }
  if (pages > 0 && costDollars > 0) {
    events.push(
      { ...common, metric: "pages-per-dollar", value: pages / costDollars, unit: "page/dollar" },
      { ...common, metric: "cost-per-1000-pages", value: (cost.totalCents / pages) * 1000, unit: "cent" },
    );
  }

  return events;
}

function resolveDeploymentLane(value: string | undefined, nodeEnv: string | undefined): DeploymentLane {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "lean" || normalized === "heavy" || normalized === "development") {
    return normalized;
  }
  return nodeEnv === "production" ? "lean" : "development";
}

function normalizeObservation(observation: LocalResourceObservation): LocalResourceObservation {
  return {
    cpuSeconds: finiteNonNegative(observation.cpuSeconds),
    memoryGbSeconds: finiteNonNegative(observation.memoryGbSeconds),
    gpuSeconds: finiteNonNegative(observation.gpuSeconds),
    storageBytes: finiteNonNegative(observation.storageBytes),
    storageDurationSeconds: finiteNonNegative(observation.storageDurationSeconds),
    networkIngressBytes: finiteNonNegative(observation.networkIngressBytes),
    networkEgressBytes: finiteNonNegative(observation.networkEgressBytes),
    wallTimeMs: finiteNonNegative(observation.wallTimeMs),
    pages: finiteNonNegative(observation.pages),
    cold: observation.cold ?? false,
  };
}

function readText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function readNonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}
