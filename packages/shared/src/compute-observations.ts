/** Content-free operational observations. Provider implementations belong to deployment adapters. */
export interface ComputePriceObservation {
  id: string;
  offerId: string;
  provider: string;
  sku: string;
  region: string;
  market: string;
  observedAt: string;
  validUntil: string;
  sourceUrl: string;
  sourceHash: string;
  nativeCurrency: string;
  nativePerHour: number;
  usdPerNative: number;
  fxObservedAt: string;
  fxSourceUrl: string;
  usdPerHour: number;
  egressUsdPerGiB: number;
  billingMinimumSeconds: number;
  billingQuantumSeconds: number;
}

export interface ComputeCalibrationObservation {
  id: string;
  profileId: string;
  priceId: string;
  offerId: string;
  imageHash: string;
  isolationPolicy: string;
  engine: string;
  workload: string;
  observedAt: string;
  validUntil: string;
  attempted: number;
  succeeded: number;
  failed: number;
  slots: number;
  startupP95Ms: number;
  serviceP95MsPerPage: number;
  transferMsPerMiB: number;
  idleTailMs: number;
  allocatedMs: number;
  sourceHash: string;
}

export interface ComputeObservations {
  prices: ComputePriceObservation[];
  calibrations: ComputeCalibrationObservation[];
}

export interface ComputeExecutionScope {
  orgId: string;
  projectId: string;
  runId: string;
  documentId: string;
  executionGeneration: string | null;
}

/**
 * A live execution grant. Its existence proves, in SQL, that the run is live and belongs to `orgId` (with the document in
 * that run). `orgId` is the only scope a compute unit may be reused across (organization isolation, AGENTS.md); a caller
 * without a grant whose `orgId` equals the job's organization runs on a fresh, single-use unit. `cohortId` is the
 * narrower run/principal/input cohort, or null.
 */
export interface ComputeCohortGrant {
  cohortId: string | null;
  validUntil: string;
  /** The organization the SQL predicate verified the run belongs to. */
  orgId: string;
}

export const computePriceColumns = {
  id: "id", offerId: "offer_id", provider: "provider", sku: "sku", region: "region", market: "market",
  observedAt: "observed_at", validUntil: "valid_until", sourceUrl: "source_url", sourceHash: "source_hash",
  nativeCurrency: "native_currency", nativePerHour: "native_per_hour", usdPerNative: "usd_per_native",
  fxObservedAt: "fx_observed_at", fxSourceUrl: "fx_source_url", usdPerHour: "usd_per_hour",
  egressUsdPerGiB: "egress_usd_per_gib", billingMinimumSeconds: "billing_minimum_seconds", billingQuantumSeconds: "billing_quantum_seconds",
} as const;
export const computeCalibrationColumns = {
  id: "id", profileId: "profile_id", priceId: "price_id", offerId: "offer_id", imageHash: "image_hash", isolationPolicy: "isolation_policy",
  engine: "engine", workload: "workload", observedAt: "observed_at", validUntil: "valid_until", attempted: "attempted",
  succeeded: "succeeded", failed: "failed", slots: "slots", startupP95Ms: "startup_p95_ms",
  serviceP95MsPerPage: "service_p95_ms_per_page", transferMsPerMiB: "transfer_ms_per_mib", idleTailMs: "idle_tail_ms",
  allocatedMs: "allocated_ms", sourceHash: "source_hash",
} as const;

const numericFields = new Set(["nativePerHour", "usdPerNative", "usdPerHour", "egressUsdPerGiB", "billingMinimumSeconds", "billingQuantumSeconds", "attempted", "succeeded", "failed", "slots", "startupP95Ms", "serviceP95MsPerPage", "transferMsPerMiB", "idleTailMs", "allocatedMs"]);
const dateFields = new Set(["observedAt", "validUntil", "fxObservedAt"]);

export function decodeComputeObservation<T>(row: Record<string, unknown>, columns: Record<string, string>): T {
  return Object.fromEntries(Object.entries(columns).map(([key, column]) => [key,
    dateFields.has(key) ? new Date(row[column] as string | Date).toISOString()
      : numericFields.has(key) ? Number(row[column]) : row[column],
  ])) as T;
}

/** Platform-only allocation admission. It contains no customer content or tenant identity and does not authorize file access. */
export interface ComputeAllocationReservation { fleetId: string; reservationId: string; clientToken: string }
export type ComputeAllocationReleaseReason = "not-created" | "provider-deleted";
export interface ComputeAllocationAdmission {
  /** Operator must preconfigure the enabled fleet and cap. Repeated IDs are idempotent; released IDs cannot be reused. */
  reserve(fleetId: string, reservationId: string): Promise<ComputeAllocationReservation | null>;
  allocated(fleetId: string, reservationId: string, providerId: string): Promise<void>;
  /** Only after definite non-creation or provider-confirmed deletion. Timeouts and uncertain responses MUST retain the reservation. */
  release(fleetId: string, reservationId: string, reason: ComputeAllocationReleaseReason): Promise<void>;
  /**
   * Unreleased reservations of the fleet older than `minAgeSeconds`, oldest first (at most 200): what a reconciler checks
   * against the provider after a restart, a lost launch response or a missed release. Content-free ids only.
   */
  unreleased(fleetId: string, minAgeSeconds: number): Promise<ComputeAllocationPending[]>;
}

export interface ComputeAllocationPending { reservationId: string; providerId: string | null; reservedAt: string }
