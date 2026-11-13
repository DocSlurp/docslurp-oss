import type { Sql } from "postgres";

/** Free-tier chart-export parser-VM runs one organization may start per clock hour, across every worker. */
export const CHART_EXPORT_FREE_VM_CAP_ENV = "DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR";
export const DEFAULT_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR = 200;

/**
 * The cap from `DOCSLURP_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR`: a non-negative integer (0 stops free VM runs). Unset or
 * invalid: the default (200 per org-hour, about $0.023 of unbilled VM time at the measured $0.000114 per run).
 */
export function chartExportFreeVmCap(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env[CHART_EXPORT_FREE_VM_CAP_ENV]?.trim();
  if (!raw) return DEFAULT_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_CHART_EXPORT_FREE_VM_RUNS_PER_ORG_HOUR;
}

/** The document is not one of the run's own documents in that organization; nothing is reserved. */
export class ChartExportFreeVmCapRefused extends Error {
  constructor(runId: string, documentId: string) {
    super(`free chart-export VM reservation refused: document ${documentId} does not belong to run ${runId}`);
    this.name = "ChartExportFreeVmCapRefused";
  }
}

/**
 * Reserves one free-tier chart-export VM run for a document against its organization's hourly cap, and returns whether
 * it was granted. The org's hour row is locked for the reservation, so concurrent workers never grant more than
 * `perHour` in one hour. A document's answer is stored the first time: a retried stage or a restarted worker gets the
 * same answer back without spending the cap again. One grant covers every guest run of that document's pass.
 *
 * The document must be one of the run's own documents (same run, project and organization, and the run in `orgId`),
 * checked in the transaction before the cap is touched; any other combination throws and reserves nothing. Migration
 * 0145's grant trigger enforces the same rule.
 */
export async function reserveChartExportFreeVmRun(
  sql: Sql<Record<string, unknown>>,
  args: { orgId: string; runId: string; documentId: string; perHour: number; now?: Date },
): Promise<boolean> {
  const perHour = Math.max(0, Math.trunc(args.perHour));
  const hour = new Date(args.now ?? Date.now());
  hour.setUTCMinutes(0, 0, 0);
  return await sql.begin(async (tx) => {
    const client = tx as unknown as Sql<Record<string, unknown>>;
    const [owned] = await client<{ id: string }[]>`
      select d.id from documents d
      join project_runs r on r.id = d.run_id
      where d.id = ${args.documentId} and r.id = ${args.runId} and r.org_id = ${args.orgId}
        and d.project_id is not distinct from r.project_id
        and d.org_id is not distinct from r.org_id
      for share of d
    `;
    if (!owned) {
      console.error(`[chart-export] refused free VM reservation org=${args.orgId} run=${args.runId} document=${args.documentId}: document is not the run's`);
      throw new ChartExportFreeVmCapRefused(args.runId, args.documentId);
    }
    const [previous] = await client<{ granted: boolean }[]>`
      select granted from chart_export_free_vm_grants where run_id = ${args.runId} and document_id = ${args.documentId}
    `;
    if (previous) return previous.granted === true;
    await client`
      insert into chart_export_free_vm_hours (org_id, hour) values (${args.orgId}, ${hour})
      on conflict (org_id, hour) do nothing
    `;
    const [bucket] = await client<{ used: number }[]>`
      select used from chart_export_free_vm_hours where org_id = ${args.orgId} and hour = ${hour} for update
    `;
    const granted = Number(bucket?.used ?? 0) < perHour;
    if (granted) {
      await client`
        update chart_export_free_vm_hours set used = used + 1, updated_at = now() where org_id = ${args.orgId} and hour = ${hour}
      `;
    }
    await client`
      insert into chart_export_free_vm_grants (run_id, document_id, org_id, granted)
      values (${args.runId}, ${args.documentId}, ${args.orgId}, ${granted})
    `;
    return granted;
  });
}
