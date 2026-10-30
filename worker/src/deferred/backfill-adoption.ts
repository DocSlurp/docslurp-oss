import { deferredProfilesEnabled } from "@docslurp/shared";
import type { Sql } from "postgres";

/**
 * Mode-switch backfills (map <-> visual) run a partial reprocess that creates a temporary new
 * document version of every source document. Spec 1.1: pages the source already indexed
 * (chunks, vectors, ledger rows keyed to the source id) must never be thrown away, and the
 * source stays the live document. So instead of letting the temporary version supersede the
 * source, completion re-keys the locator artifacts the backfill built (document map, page
 * vectors, ledger label/mapped/embedded flags, coarse text rows) onto the source id, copies the
 * new indexing mode over, and retires the temporary version without superseding anything:
 * `canonical_id` is cleared first, which keeps the supersede trigger from firing.
 *
 * Re-keying (rather than copying chunks, ledger and LanceDB rows forward to the new id) moves
 * only small Postgres rows and leaves every materialized page where search already finds it.
 * A source that was deleted, superseded or purged while the backfill ran is skipped, not failed: its
 * temporary version is retired without adopting anything (a deleted source nulls `reused_from_document_id`,
 * so the temp is found by run and mode, and must not resurface as a live document).
 * Source pages the source has `indexed` are never deleted. With the deferred-profiles flag off this is a no-op.
 *
 * Runs inside the caller's completion transaction. Returns the retired temporary document ids.
 */
export async function adoptBackfillDocuments(
  client: Sql<Record<string, unknown>>,
  runId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const rows = await client<{ temp_id: string; source_id: string | null; mode: string; source_run_id: string | null; adoptable: boolean }[]>`
    select t.id as temp_id, s.id as source_id, t.indexing_mode as mode, s.run_id as source_run_id,
      (s.id is not null and s.superseded_at is null and s.purged_at is null and s.status = 'completed'
        and t.status not in ('failed', 'cancelled', 'pii_blocked')
        and not exists (
          select 1 from document_run_stage_states st
          where st.document_id = t.id and st.run_id = t.run_id and st.status = 'failed'
        )) as adoptable
    from documents t
    join workspace_runs r on r.id = t.run_id and r.kind = 'full-index'
    left join documents s on s.id = t.reused_from_document_id
    where t.run_id = ${runId}
      and t.indexing_mode <> 'full'
      and t.superseded_at is null
  `;
  // Every temporary version is retired (never left to supersede its source or hold a canonical id); only
  // healthy temps with a live source are adopted, and only while the flag is on.
  const adopting = deferredProfilesEnabled(env);
  const pairs = adopting ? rows.filter((row) => row.adoptable) : [];
  for (const other of rows.filter((row) => !pairs.includes(row))) {
    await retire(client, other.temp_id, other.adoptable ? "completed" : null);
  }
  for (const { temp_id: temp, source_id: source, mode, source_run_id: sourceRun } of pairs as Array<{ temp_id: string; source_id: string; mode: string; source_run_id: string | null }>) {
    await client`delete from document_maps where document_id = ${source} and exists (select 1 from document_maps where document_id = ${temp})`;
    await client`update document_maps set document_id = ${source} where document_id = ${temp}`;

    await client`
      delete from document_page_vectors v using document_page_vectors n
      where v.document_id = ${source} and n.document_id = ${temp} and v.page_number = n.page_number and v.model = n.model
    `;
    await client`update document_page_vectors set document_id = ${source} where document_id = ${temp}`;

    // Coarse text-layer rows for pages the source never parsed move over under the source's run.
    await client`
      update document_pages p
      set id = ${source}::text || '-page-' || lpad(p.page_number::text, 4, '0'), document_id = ${source}, run_id = ${sourceRun}
      where p.document_id = ${temp}
        and not exists (select 1 from document_pages x where x.document_id = ${source} and x.page_number = p.page_number)
        and exists (select 1 from document_page_states s where s.document_id = ${source} and s.page_number = p.page_number
                    and s.state in ('unseen', 'failed', 'parsed'))
    `;
    // A PII block found on the temporary pass wins over a raw coarse row.
    await client`
      delete from document_pages p
      where p.document_id = ${source}
        and not exists (select 1 from document_page_states s where s.document_id = ${source} and s.page_number = p.page_number and s.state = 'indexed')
        and exists (
        select 1 from document_page_states t where t.document_id = ${temp} and t.page_number = p.page_number and t.state = 'blocked-pii')
    `;
    await client`
      update document_page_states src
      set page_label = coalesce(tmp.page_label, src.page_label),
          label_source = case when tmp.label_source <> 'none' then tmp.label_source else src.label_source end,
          mapped = src.mapped or tmp.mapped,
          embedded_at = coalesce(tmp.embedded_at, src.embedded_at),
          embedding_model = case when tmp.embedded_at is not null then tmp.embedding_model else src.embedding_model end,
          state = case
            when tmp.state = 'blocked-pii' and src.state in ('unseen', 'failed', 'parsed') then 'blocked-pii'
            when tmp.state = 'parsed' and src.state in ('unseen', 'failed') then 'parsed'
            else src.state end,
          -- A PII block found on the temporary pass also drops a kept model read of the page.
          read_text = case when tmp.state = 'blocked-pii' then null else src.read_text end,
          updated_at = now()
      from document_page_states tmp
      where src.document_id = ${source} and tmp.document_id = ${temp} and tmp.page_number = src.page_number
    `;

    await client`
      update documents
      set indexing_mode = ${mode},
          metadata = metadata || coalesce((select jsonb_strip_nulls(jsonb_build_object('mapTitle', t.metadata -> 'mapTitle')) from documents t where t.id = ${temp}), '{}'::jsonb),
          updated_at = now()
      where id = ${source}
    `;
    await retire(client, temp, "completed");
  }
  return rows.map((row) => row.temp_id);
}

/** Hides a temporary backfill version without superseding anything: clearing canonical_id keeps the trigger quiet. */
async function retire(client: Sql<Record<string, unknown>>, tempId: string, status: string | null): Promise<void> {
  // A failed or cancelled temp keeps its status (history); a healthy one is marked completed.
  await client`
    update documents
    set status = coalesce(${status}, status), canonical_id = null, superseded_at = now(), updated_at = now()
    where id = ${tempId}
  `;
}
