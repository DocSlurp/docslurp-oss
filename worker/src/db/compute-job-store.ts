import type postgres from "postgres";
import type { ComputeJobAdmission, ComputeJobAdmitResult, ComputeJobDemand, ComputeJobDemandCounts, ComputeJobTicketState } from "@docslurp/shared";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fleetPattern = /^[A-Za-z0-9_.:-]{1,200}$/;
const STATES: readonly ComputeJobTicketState[] = ["routing", "waiting", "admitted"];

function identity(fleetId: string, ticketId: string): void {
  if (!fleetPattern.test(fleetId) || !uuid.test(ticketId)) throw new Error("Invalid compute job ticket identity");
}
function lease(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 3600) throw new Error("Invalid compute job lease");
  return seconds;
}
function orgKey(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid compute job organization key");
  return value;
}

/**
 * Fleet-wide fair job admission (migration 0186). `compute_job_admit` serializes each fleet, drops expired tickets and
 * hands free slots to the organization holding the fewest; caps come only from the operator's compute_job_fleets row.
 */
export function computeJobAdmission(sql: postgres.Sql): ComputeJobAdmission {
  return {
    async register(ticket, state, leaseSeconds) {
      identity(ticket.fleetId, ticket.ticketId);
      orgKey(ticket.orgKey);
      if (!Number.isSafeInteger(ticket.pages) || ticket.pages < 1 || ticket.pages > 100_000) throw new Error("Invalid compute job pages");
      if (state !== "routing" && state !== "waiting") throw new Error("Invalid compute job ticket state");
      const seconds = lease(leaseSeconds);
      const [fleet] = await sql`select 1 from compute_job_fleets where id=${ticket.fleetId} and enabled`;
      if (!fleet) return false;
      await sql`insert into compute_job_tickets(id,fleet_id,org_key,pages,state,queued_at,expires_at)
        values(${ticket.ticketId},${ticket.fleetId},${ticket.orgKey},${ticket.pages},${state},
          ${state === "waiting" ? sql`clock_timestamp()` : null}, clock_timestamp() + ${seconds} * interval '1 second')
        on conflict(id) do nothing`;
      // A ticket id is never reused for another fleet, organization or size.
      const [row] = await sql`select fleet_id,org_key,pages from compute_job_tickets where id=${ticket.ticketId}`;
      if (!row || row.fleet_id !== ticket.fleetId || row.org_key !== ticket.orgKey || row.pages !== ticket.pages) {
        throw new Error("Compute job ticket ID cannot be reused");
      }
      return true;
    },
    async admit(fleetId, ticketId, leaseSeconds): Promise<ComputeJobAdmitResult> {
      identity(fleetId, ticketId);
      const [row] = await sql<{ state: string | null }[]>`select public.compute_job_admit(${fleetId}, ${ticketId}::uuid, ${lease(leaseSeconds)}::integer) as state`;
      const state = row?.state ?? "unknown";
      if (state !== "routing" && state !== "waiting" && state !== "admitted" && state !== "unknown" && state !== "unavailable") {
        throw new Error("Unexpected compute job admission state");
      }
      return state;
    },
    async renew(fleetId, ticketId, leaseSeconds) {
      identity(fleetId, ticketId);
      const rows = await sql`update compute_job_tickets set expires_at = clock_timestamp() + ${lease(leaseSeconds)} * interval '1 second'
        where id=${ticketId} and fleet_id=${fleetId} and expires_at >= clock_timestamp() returning id`;
      return rows.length > 0;
    },
    async release(fleetId, ticketId) {
      identity(fleetId, ticketId);
      await sql`delete from compute_job_tickets where id=${ticketId} and fleet_id=${fleetId}`;
    },
    async demand(fleetId, key): Promise<ComputeJobDemand | null> {
      if (!fleetPattern.test(fleetId)) throw new Error("Invalid compute job fleet");
      orgKey(key);
      const [fleet] = await sql<{ max_jobs: number; max_jobs_per_org: number }[]>`
        select max_jobs,max_jobs_per_org from compute_job_fleets where id=${fleetId} and enabled`;
      if (!fleet) return null;
      const rows = await sql<{ state: ComputeJobTicketState; own: boolean; jobs: number; pages: number }[]>`
        select state, own, count(*)::int as jobs, coalesce(sum(pages),0)::int as pages
        from (select state, pages, org_key=${key} as own from compute_job_tickets
              where fleet_id=${fleetId} and expires_at >= clock_timestamp()) live
        group by state, own`;
      const empty = (): Record<ComputeJobTicketState, ComputeJobDemandCounts> =>
        Object.fromEntries(STATES.map((state) => [state, { jobs: 0, pages: 0 }])) as Record<ComputeJobTicketState, ComputeJobDemandCounts>;
      const org = empty(), all = empty();
      for (const row of rows) {
        if (!STATES.includes(row.state)) continue;
        all[row.state].jobs += row.jobs; all[row.state].pages += row.pages;
        if (row.own) { org[row.state].jobs += row.jobs; org[row.state].pages += row.pages; }
      }
      return { maxJobs: fleet.max_jobs, maxJobsPerOrg: fleet.max_jobs_per_org, org, fleet: all };
    },
  };
}
