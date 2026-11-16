import type postgres from "postgres";
import type { ComputeAllocationAdmission, ComputeAllocationReservation, ComputeAllocationReleaseReason } from "@docslurp/shared";

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
  };
}
