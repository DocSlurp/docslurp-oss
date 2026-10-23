import { chatCreditReserve, isBillingExemptOrg, isBillingEnforced } from "@docslurp/shared";
import { sql } from "../../db.js";
import type { AlertCheck } from "./alert-rules.js";

export interface CreditSnapshot {
  orgId: string;
  funded: boolean;
  available: number;
  leased: number;
  pausedRuns: number;
  oldestPauseSeconds?: number;
}

/** Bounded to recently active organizations; inactive/deleted orgs are not assumed recovered. */
export async function readCreditSnapshots(): Promise<CreditSnapshot[]> {
  if (!isBillingEnforced()) return [];
  const rows = await sql<{ id: string; funded: boolean; available: number; leased: number; paused: number; oldest_pause_seconds: number | null }[]>`
    select o.id, o.funded_at is not null as funded,
      (s.balance - s.pending)::float8 as available,
      org_outstanding_credit_leases(o.id)::float8 as leased,
      (select count(*)::int from workspace_runs r where r.org_id = o.id
        and r.status = 'processing' and r.control_state = 'paused' and r.pause_reason = 'credit_exhausted') as paused
      , (select extract(epoch from (now() - min(r.updated_at)))::float8 from workspace_runs r where r.org_id = o.id
        and r.status = 'processing' and r.control_state = 'paused' and r.pause_reason = 'credit_exhausted') as oldest_pause_seconds
    from organizations o cross join lateral org_available_credits(o.id) s
    where org_has_credit_grants(o.id) and (
      exists (select 1 from workspaces w where w.org_id = o.id and w.updated_at > now() - interval '30 days')
      or exists (select 1 from workspace_runs r where r.org_id = o.id and r.control_state = 'paused' and r.pause_reason = 'credit_exhausted')
    )
  `;
  return rows.filter(row => !isBillingExemptOrg(row.id)).map(row => ({ orgId: row.id, funded: row.funded, available: Number(row.available), leased: Number(row.leased), pausedRuns: Number(row.paused), oldestPauseSeconds: Number(row.oldest_pause_seconds ?? 0) }));
}

export function creditAlertChecks(rows: CreditSnapshot[], extraCredits = 100): AlertCheck[] {
  return rows.flatMap(row => {
    const reserve = chatCreditReserve(row.funded);
    const processingAvailable = row.available - row.leased - reserve;
    const exhausted = processingAvailable <= 0;
    const funding: AlertCheck = {
      id: `credits-running-low:${row.orgId}`,
      state: processingAvailable <= extraCredits ? "firing" : "ok",
      severity: exhausted ? "critical" : "warning",
      summary: exhausted
        ? "Processing credits exhausted; add credits to resume paused runs. Chat/search have a separate reserve and limits."
        : "Organization credits are running low; add credits or enable auto top-up.",
      details: { orgId: row.orgId, account: row.funded ? "funded" : "starter", availableCredits: row.available,
        leasedCredits: row.leased, chatReserveCredits: reserve, processingAvailableCredits: processingAvailable,
        pausedRuns: row.pausedRuns, billingPath: "/app/billing", autoResume: true },
    };
    const resume: AlertCheck = {
      id: `credit-resume-delayed:${row.orgId}`,
      state: !exhausted && row.pausedRuns > 0 && (row.oldestPauseSeconds ?? 0) >= 120 ? "firing" : "ok",
      severity: "warning",
      summary: "Credits are available but processing remains paused. Automatic resume is retrying; check Temporal signal delivery and run state.",
      details: { orgId: row.orgId, processingAvailableCredits: processingAvailable, pausedRuns: row.pausedRuns, oldestPauseSeconds: row.oldestPauseSeconds ?? 0 },
    };
    return [funding, resume];
  });
}
