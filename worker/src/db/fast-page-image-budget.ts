import type { Sql } from "postgres";

/** The document is not one of the run's own documents (same run, workspace and organization); nothing is reserved. */
export class FastPageImageBudgetRefused extends Error {
  constructor(runId: string, documentId: string) {
    super(`fast page-image budget refused: document ${documentId} does not belong to run ${runId}`);
    this.name = "FastPageImageBudgetRefused";
  }
}

/**
 * Reserves up to `wanted` of a run's Fast page-image render budget (`perRun`) for one document and returns how many
 * were granted. The budget is one row per run shared by every worker process, and a reservation holds its row lock,
 * so concurrent workers never grant more than `perRun` in total. A document's grant is stored the first time: its
 * page-range shards, a retried stage and a restarted worker get the same grant back (capped at `wanted`) without
 * spending the budget again.
 *
 * The document must be one of the run's own documents (`documents.run_id`, in the run's workspace and organization),
 * checked in the reservation transaction before the budget is touched; any other pair throws
 * FastPageImageBudgetRefused and reserves nothing. Migration 0101's grant trigger enforces the same rule.
 */
export async function reserveFastPageImageRenders(
  sql: Sql<Record<string, unknown>>,
  args: { runId: string; documentId: string; wanted: number; perRun: number },
): Promise<number> {
  const wanted = Math.max(0, Math.trunc(args.wanted));
  const perRun = Math.max(0, Math.trunc(args.perRun));
  return await sql.begin(async (tx) => {
    const client = tx as unknown as Sql<Record<string, unknown>>;
    const [owned] = await client<{ id: string }[]>`
      select d.id from documents d
      join workspace_runs r on r.id = d.run_id
      where d.id = ${args.documentId} and r.id = ${args.runId}
        and d.workspace_id is not distinct from r.workspace_id
        and d.org_id is not distinct from r.org_id
      for share of d
    `;
    if (!owned) {
      console.error(`[render-images] refused fast page-image reservation run=${args.runId} document=${args.documentId}: document is not the run's`);
      throw new FastPageImageBudgetRefused(args.runId, args.documentId);
    }
    await client`
      insert into run_fast_page_image_budgets (run_id) values (${args.runId})
      on conflict (run_id) do nothing
    `;
    const [budget] = await client<{ used: number }[]>`
      select used from run_fast_page_image_budgets where run_id = ${args.runId} for update
    `;
    const [previous] = await client<{ granted: number }[]>`
      select granted from run_fast_page_image_grants where run_id = ${args.runId} and document_id = ${args.documentId}
    `;
    if (previous) return Math.min(Number(previous.granted), wanted);
    const granted = Math.max(0, Math.min(wanted, perRun - Number(budget?.used ?? 0)));
    await client`
      update run_fast_page_image_budgets set used = used + ${granted}, updated_at = now() where run_id = ${args.runId}
    `;
    await client`
      insert into run_fast_page_image_grants (run_id, document_id, granted) values (${args.runId}, ${args.documentId}, ${granted})
    `;
    return granted;
  });
}
