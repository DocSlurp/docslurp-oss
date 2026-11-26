import { deferredProfilesEnabled, piiWithholding } from "@docslurp/shared";

import { scrubTitlesAndMapForPii } from "../lib/pii-document-map.js";
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
  const raw = await client<{ temp_id: string; source_id: string | null; mode: string; source_run_id: string | null; healthy: boolean; temp_status: string | null; temp_pii: unknown; temp_policy: unknown; source_policy: unknown }[]>`
    select t.id as temp_id, s.id as source_id, t.indexing_mode as mode, s.run_id as source_run_id,
      (select tr.pipeline->'piiPolicy' from project_runs tr where tr.id = t.run_id) as temp_policy,
      (select sr.pipeline->'piiPolicy' from project_runs sr where sr.id = s.run_id) as source_policy,
      t.status as temp_status, t.metadata->'pii' as temp_pii,
      (s.id is not null and s.superseded_at is null and s.purged_at is null and s.status = 'completed'
        and t.status not in ('failed', 'cancelled', 'pii_blocked')
        and not exists (
          select 1 from document_run_stage_states st
          where st.document_id = t.id and st.run_id = t.run_id and st.status = 'failed'
        )) as healthy
    from documents t
    join project_runs r on r.id = t.run_id and r.kind = 'full-index'
    left join documents s on s.id = t.reused_from_document_id
    where t.run_id = ${runId}
      and t.indexing_mode <> 'full'
      and t.superseded_at is null
  `;
  // The PII outcome must travel with what is adopted. A temporary version with no outcome, or one that withheld and
  // redacted nothing (scan progress only: the map stage always records it under a withholding policy), is adopted and
  // its scan progress is carried onto the source. One that withheld or redacted something is retired (fail closed).
  const rows = raw.map((row) => {
    return { ...row, adoptable: row.healthy && piiCarry(row.temp_pii) !== "refuse" };
  });
  // Every temporary version is retired (never left to supersede its source or hold a canonical id); only
  // healthy temps with a live source are adopted, and only while the flag is on.
  const adopting = deferredProfilesEnabled(env);
  // Sorted by source id: concurrent adoptions take the source row locks in one order.
  const pairs = adopting ? rows.filter((row) => row.adoptable).sort((a, b) => (a.source_id! < b.source_id! ? -1 : a.source_id! > b.source_id! ? 1 : 0)) : [];
  for (const other of rows.filter((row) => !pairs.includes(row))) {
    await retire(client, other.temp_id, other.adoptable ? "completed" : null);
  }
  for (const { temp_id: temp, source_id: source, mode, source_run_id: sourceRun, temp_policy: tempPolicy, source_policy: sourcePolicy } of pairs as Array<{ temp_id: string; source_id: string; mode: string; source_run_id: string | null; temp_policy: unknown; source_policy: unknown }>) {
    // Lock order: the source document's row, then the temp's, before their page rows (as a query-time materialization
    // takes them). The temp's outcome is read again under its lock, so a match recorded on it after the first read is
    // never lost: a temp that now withheld or redacted something is retired instead of adopted.
    const [sourceRow] = await client<{ pii: unknown }[]>`select metadata->'pii' as pii from documents where id = ${source} for no key update`;
    const [tempRow] = await client<{ pii: unknown }[]>`select metadata->'pii' as pii from documents where id = ${temp} for no key update`;
    if (piiCarry(tempRow?.pii) === "refuse") {
      // Retired as it is (its status kept), like any temp that is not adopted.
      await retire(client, temp, null);
      continue;
    }
    // Scan progress is carried only between runs with the same PII policy: a scan under another policy says nothing
    // about this one.
    const carriedPii = samePolicy(tempPolicy, sourcePolicy) ? carriedScan(sourceRow?.pii, tempRow?.pii) : null;
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
          embedding_model_uri = case when tmp.embedded_at is not null then tmp.embedding_model_uri else src.embedding_model_uri end,
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
          metadata = metadata || coalesce((select jsonb_strip_nulls(jsonb_build_object('mapTitle', t.metadata -> 'mapTitle')) from documents t where t.id = ${temp}), '{}'::jsonb)
            || ${carriedPii ? client`jsonb_build_object('pii', ${client.json(carriedPii as never)}::jsonb)` : client`'{}'::jsonb`},
          updated_at = now()
      where id = ${source}
    `;
    // Titles and the map moved onto the source were built from the temp's pass: drop what came from a page the source
    // itself withholds (the source's own outcome governs it).
    const withheld = piiWithholding({ metadata: { pii: sourceRow?.pii ?? null } });
    if (withheld.scope === "document" || withheld.scope === "pages") {
      await scrubTitlesAndMapForPii(client as never, source, withheld.scope === "document" ? "all" : new Set(withheld.pages), () => false);
    }
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

/**
 * What adoption does with the temporary version's PII outcome: "none" (it has none), "carry" (it withheld and redacted
 * nothing: its scan progress goes onto the source), or "refuse" (it withheld or redacted something, or cannot be read:
 * the temp is retired, fail closed).
 */
export function piiCarry(tempPii: unknown): "none" | "carry" | "refuse" {
  if (tempPii === null || tempPii === undefined) return "none";
  const temp = piiWithholding({ metadata: { pii: tempPii } });
  return temp.scope === "none" && (tempPii as { redacted?: unknown }).redacted !== true && (temp.redactedPages?.size ?? 0) === 0 ? "carry" : "refuse";
}

/**
 * The source's outcome with the temp's scan progress, or null to leave the source's outcome untouched. Scan fields are
 * carried only when the source already tracks a deferred scan (`scanPending` or `scanComplete`): scanned pages are
 * unioned, a source `scanComplete` stays, and the source's withheld pages, redaction and block are never touched. A source
 * with no outcome (ingested before the policy, whose own runs record no scan) is adopted with no outcome, as before.
 */
export function carriedScan(sourcePii: unknown, tempPii: unknown): Record<string, unknown> | null {
  if (!sourcePii || typeof sourcePii !== "object" || Array.isArray(sourcePii)) return null;
  const source = sourcePii as Record<string, unknown>;
  if (source.scanComplete === true) return null;
  if (source.scanPending !== true) return null;
  const temp = tempPii && typeof tempPii === "object" ? tempPii as Record<string, unknown> : {};
  const pages = (value: unknown) => (Array.isArray(value) ? value.filter((page): page is number => Number.isSafeInteger(page) && page >= 1) : []);
  const pageCount = Number(source.pageCount);
  const inRange = (page: number) => !Number.isSafeInteger(pageCount) || pageCount < 1 || page <= pageCount;
  const scanned = [...new Set([...pages(source.scannedPages), ...pages(temp.scannedPages)])].filter(inRange).sort((a, b) => a - b);
  if (temp.scanComplete === true || (Number.isSafeInteger(pageCount) && pageCount > 0 && scanned.length >= pageCount)) {
    const { scanPending: _pending, scannedPages: _scanned, ...rest } = source;
    return { ...rest, scanComplete: true };
  }
  return { ...source, scanPending: true, scannedPages: scanned };
}

/** Whether two stored PII policies are the same (key order ignored). */
function samePolicy(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, inner) => inner && typeof inner === "object" && !Array.isArray(inner)
    ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
    : inner) ?? "null";
  return canonical(a ?? null) === canonical(b ?? null);
}
