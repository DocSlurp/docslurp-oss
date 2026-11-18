import type postgres from "postgres";
import { computeCalibrationColumns, computePriceColumns, decodeComputeObservation, type ComputeCalibrationObservation, type ComputeCohortGrant, type ComputeExecutionScope, type ComputeObservations, type ComputePriceObservation } from "@docslurp/shared";
import type { ComputeAllocationAdmission, ComputeAllocationPending, ComputeAllocationReservation, ComputeAllocationReleaseReason } from "@docslurp/shared";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function validate(fleetId: string, reservationId: string): void {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(fleetId) || !uuid.test(reservationId)) throw new Error("Invalid compute reservation identity");
}

/** The SQL trigger serializes admissions and enforces the operator cap even for direct runtime inserts. */
export function computeAllocationAdmission(sql: postgres.Sql): ComputeAllocationAdmission {
  return {
    async reserve(fleetId, reservationId): Promise<ComputeAllocationReservation | null> {
      validate(fleetId, reservationId);
      try {
        await sql`insert into compute_allocation_reservations(id,fleet_id) values(${reservationId},${fleetId}) on conflict(id) do nothing`;
      } catch (error) {
        if ((error as { code?: string }).code === "P0001" && (error as Error).message === "compute_fleet_capacity") return null;
        throw error;
      }
      const [row] = await sql`select fleet_id,released_at from compute_allocation_reservations where id=${reservationId}`;
      if (!row || row.fleet_id !== fleetId || row.released_at !== null) throw new Error("Compute reservation ID cannot be reused");
      return { fleetId, reservationId, clientToken: reservationId };
    },
    async allocated(fleetId, reservationId, providerId) {
      validate(fleetId, reservationId);
      if (!providerId || providerId.length > 200) throw new Error("Invalid compute provider allocation ID");
      const rows = await sql`update compute_allocation_reservations set provider_id=${providerId}
        where id=${reservationId} and fleet_id=${fleetId} and released_at is null
          and (provider_id is null or provider_id=${providerId}) returning id`;
      if (!rows.length) throw new Error("Compute reservation allocation refused");
    },
    async release(fleetId, reservationId, reason: ComputeAllocationReleaseReason) {
      validate(fleetId, reservationId);
      if (reason !== "not-created" && reason !== "provider-deleted") throw new Error("Invalid compute release reason");
      const rows = await sql`update compute_allocation_reservations set released_at=now(),release_reason=${reason}
        where id=${reservationId} and fleet_id=${fleetId} and released_at is null returning id`;
      if (rows.length) return;
      const [row] = await sql`select released_at,release_reason from compute_allocation_reservations where id=${reservationId} and fleet_id=${fleetId}`;
      if (!row?.released_at || row.release_reason !== reason) throw new Error("Compute reservation release refused");
    },
    async unreleased(fleetId, minAgeSeconds): Promise<ComputeAllocationPending[]> {
      if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(fleetId) || !Number.isFinite(minAgeSeconds) || minAgeSeconds < 0 || minAgeSeconds > 30 * 86_400) {
        throw new Error("Invalid compute reservation query");
      }
      const rows = await sql<{ id: string; provider_id: string | null; created_at: Date }[]>`
        select id, provider_id, created_at from compute_allocation_reservations
        where fleet_id=${fleetId} and released_at is null and created_at < now() - (${minAgeSeconds} * interval '1 second')
        order by created_at limit 200`;
      return rows.map((row) => ({ reservationId: row.id, providerId: row.provider_id, reservedAt: new Date(row.created_at).toISOString() }));
    },
  };
}

/** The cohort grant for one execution scope; null unless the run belongs to scope.orgId (authorize_compute_cohort). */
export async function authorizeComputeCohort(sql: postgres.Sql<Record<string, unknown>>, scope: ComputeExecutionScope): Promise<ComputeCohortGrant | null> {
  for (const value of [scope.orgId, scope.projectId, scope.runId, scope.documentId]) {
    if (!value || value.length > 200) throw new Error("Invalid compute execution scope");
  }
  const [row] = await sql<{ cohort_id: string | null; valid_until: Date }[]>`
    select * from public.authorize_compute_cohort(${scope.orgId}, ${scope.projectId}, ${scope.runId}, ${scope.documentId}, ${scope.executionGeneration})`;
  // A row exists only when the run belongs to scope.orgId (authorize_compute_cohort's `r.org_id = p_org`).
  return row ? { cohortId: row.cohort_id, validUntil: new Date(row.valid_until).toISOString(), orgId: scope.orgId } : null;
}

/** The newest valid calibration of each profile, with the price observation of its offer. */
export async function loadComputeObservations(sql: postgres.Sql<Record<string, unknown>>, profileIds: readonly string[]): Promise<ComputeObservations> {
  if (profileIds.length > 100 || profileIds.some((id) => !id || id.length > 200)) throw new Error("Invalid compute profile selection");
  if (!profileIds.length) return { prices: [], calibrations: [] };
  const calibrations = await sql`
    select distinct on (profile_id) * from compute_calibration_observations
    where profile_id = any(${[...profileIds]}) and observed_at <= now() and valid_until > now()
      and observed_at > now() - interval '7 days'
    order by profile_id, observed_at desc, id desc`;
  const offers = calibrations.map((row) => String(row.offer_id));
  const prices = offers.length ? await sql`
    select distinct on (offer_id) * from compute_price_observations
    where offer_id = any(${offers}) and observed_at <= now() and valid_until > now()
    order by offer_id, observed_at desc, id desc` : [];
  const valid = new Set(prices.map((row) => row.offer_id));
  return {
    prices: prices.map((row) => decodeComputeObservation<ComputePriceObservation>(row, computePriceColumns)),
    calibrations: calibrations.filter((row) => valid.has(row.offer_id)).map((row) => decodeComputeObservation<ComputeCalibrationObservation>(row, computeCalibrationColumns)),
  };
}

const SPEND_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/**
 * Recorded `sandbox_compute` spend (cents) of one provider and model across every organization in the window, read
 * through usage_attribution (the one spend reader; migration 0194's partial index serves the window).
 */
export async function computeSpendCents(sql: postgres.Sql<Record<string, unknown>>, query: { provider: string; model: string; sinceSeconds: number }): Promise<number> {
  if (!SPEND_LABEL.test(query.provider) || !SPEND_LABEL.test(query.model) || !Number.isSafeInteger(query.sinceSeconds) || query.sinceSeconds < 1 || query.sinceSeconds > 86_400) {
    throw new Error("Invalid compute spend query");
  }
  const [row] = await sql<{ cents: string | number | null }[]>`
    select coalesce(sum(cost_cents), 0) as cents from usage_attribution
    where metric = 'sandbox_compute' and provider = ${query.provider} and model = ${query.model}
      and created_at > now() - (${query.sinceSeconds} * interval '1 second')`;
  const cents = Number(row?.cents ?? 0);
  if (!Number.isFinite(cents) || cents < 0) throw new Error("Invalid compute spend total");
  return cents;
}
