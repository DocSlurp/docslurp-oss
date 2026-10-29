import type { Sql } from "postgres";

/**
 * Reserves up to `wanted` of a run's Fast page-image render budget (`perRun`) for one document and returns how many
 * were granted. The budget is one row per run shared by every worker process, and a reservation holds its row lock,
 * so concurrent workers never grant more than `perRun` in total. A document's grant is stored the first time: its
 * page-range shards, a retried stage and a restarted worker get the same grant back (capped at `wanted`) without
 * spending the budget again.
 */
export async function reserveFastPageImageRenders(
  sql: Sql<Record<string, unknown>>,
  args: { runId: string; documentId: string; wanted: number; perRun: number },
): Promise<number> {
  const wanted = Math.max(0, Math.trunc(args.wanted));
  const perRun = Math.max(0, Math.trunc(args.perRun));
  return await sql.begin(async (tx) => {
    const client = tx as unknown as Sql<Record<string, unknown>>;
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
