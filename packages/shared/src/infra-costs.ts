import { CREDIT_RATE_CARD, creditsToDollars, type CreditRateCard } from "./billing.js";

// ---------------------------------------------------------------------------
// Infrastructure cost observations and the margin policy for the rate card.
//
// The rate card (billing.ts) is what customers pay. This module records what
// the infrastructure behind each billable lane actually costs, where the
// number came from and when, and the policy every list price must satisfy.
// the internal pricing validation re-checks these numbers against live provider APIs
// and pricing pages; the tests check the current card against the policy.
// ---------------------------------------------------------------------------

export type InfraProvider = "fly" | "vast" | "modal" | "tigris" | "neon" | "openrouter";

/**
 * `hour`: USD per running hour of the SKU. `gb-month`: USD per GB stored for
 * a month. `gb`: USD per GB transferred. `usd`: USD paid per USD of provider
 * list price (pass-through fees).
 */
export type InfraUnit = "hour" | "gb-month" | "gb" | "usd";

export type InfraObservationMethod = "pricing-page" | "api-median" | "derived";

export type InfraCostObservation = {
  /** `provider:sku[:region]`, stable across re-observations. */
  id: string;
  provider: InfraProvider;
  sku: string;
  region?: string;
  unit: InfraUnit;
  usd: number;
  /** Resources one unit of the SKU provides (compute SKUs). */
  capacity?: { vcpu?: number; memoryGb?: number; gpus?: number; gpuMemoryGb?: number };
  sourceUrl: string;
  observedAt: string;
  method: InfraObservationMethod;
  notes: string;
};

/** Fly bills a "month" as 30 days of continuous runtime. */
export const FLY_HOURS_PER_MONTH = 720;
/** Fly regional price multipliers (fly.io/docs/about/pricing, RegionPricingSelector). */
export const FLY_REGION_MARKUP: Readonly<Record<string, number>> = { iad: 1, ewr: 1, lax: 1.199519231 };
/** Fly list prices (iad), USD per 30-day month. */
export const FLY_LIST_MONTHLY = {
  /** shared-cpu-1x with its included 256 MB. Shared presets scale linearly per vCPU. */
  sharedVcpuWith256Mb: 2.19,
  /** performance-1x with its included 2 GB. */
  performanceVcpuWith2Gb: 33,
  extraRamGb: 6,
  stoppedRootfsGb: 0.15,
} as const;

function flyHourly(monthlyUsd: number, region: string): number {
  return (monthlyUsd / FLY_HOURS_PER_MONTH) * (FLY_REGION_MARKUP[region] ?? 1);
}

/** Monthly USD of a Fly shared-cpu machine: N vCPU presets plus RAM above the included 256 MB/vCPU. */
export function flySharedMonthlyUsd(vcpu: number, memoryGb: number): number {
  const includedGb = vcpu * 0.25;
  return vcpu * FLY_LIST_MONTHLY.sharedVcpuWith256Mb + Math.max(0, memoryGb - includedGb) * FLY_LIST_MONTHLY.extraRamGb;
}

/** Monthly USD of a Fly performance machine: N vCPU presets plus RAM above the included 2 GB/vCPU. */
export function flyPerformanceMonthlyUsd(vcpu: number, memoryGb: number): number {
  const includedGb = vcpu * 2;
  return vcpu * FLY_LIST_MONTHLY.performanceVcpuWith2Gb + Math.max(0, memoryGb - includedGb) * FLY_LIST_MONTHLY.extraRamGb;
}

const OBSERVED_AT = "2026-10-09";
const FLY_PRICING = "https://fly.io/docs/about/pricing/";
const VAST_BUNDLES = "https://console.vast.ai/api/v0/bundles/";
const MODAL_PRICING = "https://modal.com/pricing";
const VAST_NOTE = "Median dph_total of verified, rentable, on-demand single-GPU offers.";

function flyShared(vcpu: number, memoryGb: number, region: string, notes: string): InfraCostObservation {
  return {
    id: `fly:shared-cpu-${vcpu}x-${memoryGb}gb:${region}`,
    provider: "fly",
    sku: `shared-cpu-${vcpu}x-${memoryGb}gb`,
    region,
    unit: "hour",
    usd: flyHourly(flySharedMonthlyUsd(vcpu, memoryGb), region),
    capacity: { vcpu, memoryGb },
    sourceUrl: FLY_PRICING,
    observedAt: OBSERVED_AT,
    method: "derived",
    notes,
  };
}

function modalGpu(sku: string, usdPerSecond: number, gpuMemoryGb: number, notes = "Base (preemptible) price."): InfraCostObservation {
  return {
    id: `modal:${sku}`,
    provider: "modal",
    sku,
    unit: "hour",
    usd: usdPerSecond * 3_600,
    capacity: { gpus: 1, gpuMemoryGb },
    sourceUrl: MODAL_PRICING,
    observedAt: OBSERVED_AT,
    method: "pricing-page",
    notes,
  };
}

function vastGpu(sku: string, usd: number, gpuMemoryGb: number, samples: number): InfraCostObservation {
  return {
    id: `vast:${sku}`,
    provider: "vast",
    sku,
    unit: "hour",
    usd,
    capacity: { gpus: 1, gpuMemoryGb },
    sourceUrl: VAST_BUNDLES,
    observedAt: OBSERVED_AT,
    method: "api-median",
    notes: `${VAST_NOTE} n=${samples} on ${OBSERVED_AT}. Spot-market price; expect ±20% day to day.`,
  };
}

/**
 * What the infrastructure behind each billable lane costs. Re-verify with
 * the internal pricing validation; update `usd` and `observedAt` together.
 */
export const INFRA_COST_OBSERVATIONS: readonly InfraCostObservation[] = [
  // Fly compute. Pricing page lists iad/ewr; lax (our worker region) is ×1.1995.
  {
    id: "fly:shared-cpu-1x-256mb:iad",
    provider: "fly",
    sku: "shared-cpu-1x-256mb",
    region: "iad",
    unit: "hour",
    usd: flyHourly(FLY_LIST_MONTHLY.sharedVcpuWith256Mb, "iad"),
    capacity: { vcpu: 1, memoryGb: 0.25 },
    sourceUrl: FLY_PRICING,
    observedAt: OBSERVED_AT,
    method: "pricing-page",
    notes: "$2.19/month. Anchor for all shared presets (2x 512 MB $0.0061/h, 8x 2 GB $0.0244/h).",
  },
  {
    id: "fly:shared-vcpu:lax",
    provider: "fly",
    sku: "shared-vcpu",
    region: "lax",
    unit: "hour",
    usd: flyHourly(FLY_LIST_MONTHLY.sharedVcpuWith256Mb - 0.25 * FLY_LIST_MONTHLY.extraRamGb, "lax"),
    capacity: { vcpu: 1 },
    sourceUrl: FLY_PRICING,
    observedAt: OBSERVED_AT,
    method: "derived",
    notes: "One shared vCPU net of its included 256 MB. Shared vCPUs have a 6.25% baseline quota plus burst balance (fly.io/docs/machines/cpu-performance); sustained CPU-bound work is throttled.",
  },
  {
    id: "fly:extra-ram:lax",
    provider: "fly",
    sku: "extra-ram",
    region: "lax",
    unit: "hour",
    usd: flyHourly(FLY_LIST_MONTHLY.extraRamGb, "lax"),
    capacity: { memoryGb: 1 },
    sourceUrl: FLY_PRICING,
    observedAt: OBSERVED_AT,
    method: "derived",
    notes: "$6/GB-month above the preset allowance. RAM, not CPU, dominates Fly worker cost.",
  },
  flyShared(8, 16, "lax", "Production worker host: 8 slots of 1 vCPU + 2 GB."),
  flyShared(8, 16, "iad", "Same host in the cheapest region, for comparison."),
  flyShared(2, 3, "lax", "Current docslurp-worker fleet size (one task host per machine)."),
  {
    id: "fly:performance-1x-2gb:lax",
    provider: "fly",
    sku: "performance-1x-2gb",
    region: "lax",
    unit: "hour",
    usd: flyHourly(flyPerformanceMonthlyUsd(1, 2), "lax"),
    capacity: { vcpu: 1, memoryGb: 2 },
    sourceUrl: FLY_PRICING,
    observedAt: OBSERVED_AT,
    method: "derived",
    notes: "$33/month in iad. Dedicated vCPU, no throttling.",
  },
  {
    id: "fly:stopped-rootfs",
    provider: "fly",
    sku: "stopped-rootfs",
    unit: "gb-month",
    usd: FLY_LIST_MONTHLY.stoppedRootfsGb,
    sourceUrl: FLY_PRICING,
    observedAt: OBSERVED_AT,
    method: "pricing-page",
    notes: "Idle cost of a stopped machine, per GB of root filesystem.",
  },
  {
    id: "fly:egress:na-eu",
    provider: "fly",
    sku: "egress-na-eu",
    unit: "gb",
    usd: 0.02,
    sourceUrl: FLY_PRICING,
    observedAt: OBSERVED_AT,
    method: "pricing-page",
    notes: "Billed by the sending region; app machines run in North America. APAC $0.04, Africa/India $0.12.",
  },
  // Vast.ai, verified on-demand single-GPU medians.
  vastGpu("rtx-4090", 0.471, 24, 28),
  vastGpu("l4", 0.33, 24, 4),
  vastGpu("rtx-3090", 0.269, 24, 25),
  vastGpu("a100-80gb", 1.15, 80, 7),
  vastGpu("h100-sxm", 2.227, 80, 4),
  // Modal, per-second list prices.
  modalGpu("l4", 0.000222, 24),
  modalGpu("a10", 0.000306, 24),
  modalGpu("a100-80gb", 0.000694, 80),
  modalGpu("h100", 0.001097, 80),
  modalGpu("l4-nonpreemptible", 0.000222 * 3, 24, "Non-preemptible execution is 3× base. Regional pinning adds 1.15–1.75×."),
  {
    id: "modal:cpu-core",
    provider: "modal",
    sku: "cpu-core",
    unit: "hour",
    usd: 0.0000131 * 3_600,
    capacity: { vcpu: 2 },
    sourceUrl: MODAL_PRICING,
    observedAt: OBSERVED_AT,
    method: "pricing-page",
    notes: "One physical core (2 vCPU equivalent). Memory is $0.00000222/GiB-s on top.",
  },
  // Storage.
  {
    id: "tigris:standard",
    provider: "tigris",
    sku: "standard-storage",
    unit: "gb-month",
    usd: 0.02,
    sourceUrl: "https://www.tigrisdata.com/pricing/",
    observedAt: OBSERVED_AT,
    method: "pricing-page",
    notes: "Object storage for sources and artifacts. Egress free; Class A requests $0.005/1k.",
  },
  {
    id: "neon:storage",
    provider: "neon",
    sku: "storage",
    unit: "gb-month",
    usd: 0.35,
    sourceUrl: "https://neon.com/pricing",
    observedAt: OBSERVED_AT,
    method: "pricing-page",
    notes: "Postgres storage for pgvector, full-text and graph indexes. Instant restore $0.20/GB-month and compute ($0.106/CU-hour) are extra.",
  },
  // AI pass-through.
  {
    id: "openrouter:pass-through",
    provider: "openrouter",
    sku: "pass-through",
    unit: "usd",
    usd: 1.055,
    sourceUrl: "https://openrouter.ai/docs/faq",
    observedAt: OBSERVED_AT,
    method: "pricing-page",
    notes: "Provider list price plus OpenRouter's 5.5% fee on credit purchases.",
  },
];

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type RateCardResourceKey = Exclude<keyof CreditRateCard, "version" | "effectiveDate" | "aiMarkupPercent">;
/** Rate-card quantities supplied by one unit of an infra SKU. `aiProviderUsd` is priced at list + markup. */
export type ResourceBundle = Partial<Record<RateCardResourceKey | "aiProviderUsd", number>>;

export type PolicySku = {
  observationId: string;
  /** Rate-card resources one unit of the SKU delivers (e.g. 8 vCPU-hours + 16 GB-hours per machine-hour). */
  bundle: ResourceBundle;
  /** Set for SKUs that must not back a billable lane under the current card. */
  disallowedReason?: string;
};

export type ResourceClassPolicy = {
  id: string;
  label: string;
  /** Highest acceptable infra cost ÷ list price, i.e. the fleet utilization needed to break even. */
  maxBreakEvenUtilization: number;
  rationale: string;
  skus: readonly PolicySku[];
};

/**
 * Every billable rate-card resource, the infra SKUs allowed to back it, and
 * the break-even ceiling each must meet. A SKU marked `disallowedReason` is
 * reported, not failed: it is simply not allowed for billable lanes.
 */
export const RESOURCE_CLASS_POLICY: readonly ResourceClassPolicy[] = [
  {
    id: "cpu-worker-host",
    label: "CPU worker hosts (vCPU + memory)",
    maxBreakEvenUtilization: 0.4,
    rationale:
      "Autoscaled shared fleet: machines idle between tasks, during cold starts (~0.8 GB image), autoscaler lag and fan-out tails, so fleet utilization of 60–70% is realistic. At 40% break-even and 70% utilization infra is 57% of revenue, leaving ~40% for the control plane (Neon compute, Temporal, app machines), card fees and support. Shared vCPUs also throttle to a 6.25% baseline under sustained load, which lowers pages per billed hour.",
    skus: [
      { observationId: "fly:shared-cpu-8x-16gb:lax", bundle: { cpuVcpuHour: 8, memoryGbHour: 16 } },
      { observationId: "fly:shared-cpu-8x-16gb:iad", bundle: { cpuVcpuHour: 8, memoryGbHour: 16 } },
      { observationId: "fly:shared-cpu-2x-3gb:lax", bundle: { cpuVcpuHour: 2, memoryGbHour: 3 } },
      {
        observationId: "fly:performance-1x-2gb:lax",
        bundle: { cpuVcpuHour: 1, memoryGbHour: 2 },
        disallowedReason: "Dedicated vCPUs cost ~30× a shared vCPU (net of RAM); a performance lane needs its own CPU rate.",
      },
      {
        observationId: "modal:cpu-core",
        bundle: { cpuVcpuHour: 2 },
        disallowedReason: "Modal CPU is ~20× Fly's shared vCPU price; not used for billable CPU work.",
      },
    ],
  },
  {
    id: "cpu",
    label: "CPU line, alone",
    maxBreakEvenUtilization: 0.4,
    rationale: "Each line must cover its own resource, so a CPU-heavy configuration cannot be subsidised by memory.",
    skus: [{ observationId: "fly:shared-vcpu:lax", bundle: { cpuVcpuHour: 1 } }],
  },
  {
    id: "memory",
    label: "Memory line, alone",
    maxBreakEvenUtilization: 0.4,
    rationale: "Fly RAM ($6/GB-month) is the largest worker cost; a memory-heavy configuration must not lose money.",
    skus: [{ observationId: "fly:extra-ram:lax", bundle: { memoryGbHour: 1 } }],
  },
  {
    id: "gpu-standard",
    label: "GPU · standard (24 GB class)",
    maxBreakEvenUtilization: 0.6,
    rationale:
      "GPU hosts start only for queued GPU work and are billed per GPU-second of task time; the loss is boot and model-load time plus Vast's ±20% spot volatility. A tighter target would price OCR out of reach, so 60% leaves headroom for a 1.5× price swing at full utilization.",
    skus: [
      { observationId: "vast:rtx-4090", bundle: { gpuStandardHour: 1 } },
      { observationId: "vast:l4", bundle: { gpuStandardHour: 1 } },
      { observationId: "vast:rtx-3090", bundle: { gpuStandardHour: 1 } },
      { observationId: "modal:l4", bundle: { gpuStandardHour: 1 }, disallowedReason: "Modal L4 base price breaks even at ~89%." },
      { observationId: "modal:a10", bundle: { gpuStandardHour: 1 }, disallowedReason: "Modal A10 costs more than list." },
      { observationId: "modal:l4-nonpreemptible", bundle: { gpuStandardHour: 1 }, disallowedReason: "Non-preemptible Modal runs at a loss (3× base)." },
    ],
  },
  {
    id: "gpu-large",
    label: "GPU · large (80 GB class)",
    maxBreakEvenUtilization: 0.6,
    rationale: "Same as standard GPU. The large lane is restricted to A100 80 GB; H100 would need a separate rate.",
    skus: [
      { observationId: "vast:a100-80gb", bundle: { gpuLargeHour: 1 } },
      { observationId: "vast:h100-sxm", bundle: { gpuLargeHour: 1 }, disallowedReason: "H100 breaks even at ~74%; the large lane is A100-only at this rate." },
      { observationId: "modal:a100-80gb", bundle: { gpuLargeHour: 1 }, disallowedReason: "Modal A100 80 GB breaks even at ~83%." },
      { observationId: "modal:h100", bundle: { gpuLargeHour: 1 }, disallowedReason: "Modal H100 costs more than list." },
    ],
  },
  {
    id: "object-storage",
    label: "Object storage",
    maxBreakEvenUtilization: 0.5,
    rationale:
      "Storage is billed for exactly what is stored, so there is no idle loss, but list must also cover request fees, the plan's included GB, and the daily meter's estimate error.",
    skus: [{ observationId: "tigris:standard", bundle: { objectStorageGbMonth: 1 } }],
  },
  {
    id: "index-storage",
    label: "Index storage",
    maxBreakEvenUtilization: 0.5,
    rationale: "As object storage, plus Neon history (instant restore) and the query compute that serves the index, which is not metered separately.",
    skus: [{ observationId: "neon:storage", bundle: { indexStorageGbMonth: 1 } }],
  },
  {
    id: "egress",
    label: "Egress",
    maxBreakEvenUtilization: 0.5,
    rationale: "Pass-through bandwidth; 50% keeps regional variance and request overhead covered.",
    skus: [{ observationId: "fly:egress:na-eu", bundle: { egressGb: 1 } }],
  },
  {
    id: "ai",
    label: "AI models",
    maxBreakEvenUtilization: 0.9,
    rationale: "Pure pass-through with no utilization risk; the markup only has to cover gateway fees, card fees and estimate error.",
    skus: [{ observationId: "openrouter:pass-through", bundle: { aiProviderUsd: 1 } }],
  },
];

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/** List price in USD of a resource bundle at the given card. */
export function listUsdForBundle(bundle: ResourceBundle, card: CreditRateCard = CREDIT_RATE_CARD): number {
  let credits = 0;
  for (const [key, quantity] of Object.entries(bundle) as Array<[keyof ResourceBundle, number]>) {
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    credits += key === "aiProviderUsd"
      ? quantity * 100 * (1 + card.aiMarkupPercent / 100)
      : quantity * card[key];
  }
  return creditsToDollars(credits);
}

/** Fleet utilization at which revenue equals infra cost: infra ÷ list per provisioned unit. */
export function breakEvenUtilization(infraUsd: number, listUsd: number): number {
  if (!(listUsd > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(0, infraUsd) / listUsd;
}

/** Gross margin when a share `utilization` of provisioned capacity is billed. */
export function marginAtUtilization(breakEven: number, utilization: number): number {
  if (!(utilization > 0)) return Number.NEGATIVE_INFINITY;
  return 1 - breakEven / utilization;
}

export type RateCardFindingSeverity = "ok" | "violation" | "disallowed" | "missing";

export type RateCardFinding = {
  policyId: string;
  observationId: string;
  severity: RateCardFindingSeverity;
  infraUsd: number | null;
  listUsd: number;
  breakEven: number | null;
  maxBreakEven: number;
  /**
   * Gross margin at a typical operating point: 70% fleet utilization for
   * compute (`hour` SKUs); the plain cost ratio for storage, egress and AI,
   * which have no idle capacity.
   */
  typicalMargin: number | null;
  message: string;
};

export function assessRateCard(
  card: CreditRateCard = CREDIT_RATE_CARD,
  observations: readonly InfraCostObservation[] = INFRA_COST_OBSERVATIONS,
  policy: readonly ResourceClassPolicy[] = RESOURCE_CLASS_POLICY,
): RateCardFinding[] {
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const findings: RateCardFinding[] = [];
  for (const lane of policy) {
    for (const sku of lane.skus) {
      const listUsd = listUsdForBundle(sku.bundle, card);
      const observation = byId.get(sku.observationId);
      if (!observation) {
        findings.push({
          policyId: lane.id, observationId: sku.observationId, severity: "missing", infraUsd: null, listUsd,
          breakEven: null, maxBreakEven: lane.maxBreakEvenUtilization, typicalMargin: null,
          message: `No cost observation for ${sku.observationId}`,
        });
        continue;
      }
      const breakEven = breakEvenUtilization(observation.usd, listUsd);
      const passes = breakEven <= lane.maxBreakEvenUtilization;
      const severity: RateCardFindingSeverity = sku.disallowedReason ? "disallowed" : passes ? "ok" : "violation";
      const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
      findings.push({
        policyId: lane.id,
        observationId: sku.observationId,
        severity,
        infraUsd: observation.usd,
        listUsd,
        breakEven,
        maxBreakEven: lane.maxBreakEvenUtilization,
        typicalMargin: marginAtUtilization(breakEven, observation.unit === "hour" ? 0.7 : 1),
        message: sku.disallowedReason
          ? `Not allowed for billable lanes: ${sku.disallowedReason} (break-even ${pct(breakEven)})`
          : `${lane.label}: break-even ${pct(breakEven)} vs ≤ ${pct(lane.maxBreakEvenUtilization)}`,
      });
    }
  }
  return findings;
}

export function rateCardViolations(findings: readonly RateCardFinding[]): RateCardFinding[] {
  return findings.filter((finding) => finding.severity === "violation" || finding.severity === "missing");
}

/** Observations older than `maxAgeDays` (default 45): re-verify with the internal pricing validation. */
export function staleObservations(
  observations: readonly InfraCostObservation[] = INFRA_COST_OBSERVATIONS,
  now: Date = new Date(),
  maxAgeDays = 45,
): InfraCostObservation[] {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  return observations.filter((observation) => {
    const observed = Date.parse(`${observation.observedAt}T00:00:00Z`);
    return !Number.isFinite(observed) || observed < cutoff;
  });
}

// ---------------------------------------------------------------------------
// Worker slots and burn
// ---------------------------------------------------------------------------

/** One billable worker slot on the production host: 1 vCPU + 2 GB, 8 per shared-cpu-8x 16 GB machine. */
export const WORKER_SLOT = {
  vcpu: 1,
  memoryGb: 2,
  hostObservationId: "fly:shared-cpu-8x-16gb:lax",
  slotsPerHost: 8,
} as const;

/** List credits for one fully busy worker slot-hour. */
export function slotCreditsPerHour(card: CreditRateCard = CREDIT_RATE_CARD): number {
  return WORKER_SLOT.vcpu * card.cpuVcpuHour + WORKER_SLOT.memoryGb * card.memoryGbHour;
}

/** Infra USD for one provisioned worker slot-hour on the production host. */
export function slotInfraUsdPerHour(observations: readonly InfraCostObservation[] = INFRA_COST_OBSERVATIONS): number {
  const host = observations.find((observation) => observation.id === WORKER_SLOT.hostObservationId);
  if (!host) throw new Error(`Missing infra observation ${WORKER_SLOT.hostObservationId}`);
  return host.usd / WORKER_SLOT.slotsPerHost;
}
