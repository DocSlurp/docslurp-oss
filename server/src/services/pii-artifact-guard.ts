import {
  filterPiiWithheldHits,
  isPageWithheld,
  piiWithholding,
  withheldPageOfSlot,
  type PiiWithholding,
  type WithholdableHit,
} from "@docslurp/shared";

import { sql } from "../db.js";

/**
 * Artifacts withheld by the PII policy. When a document matched under
 * `redact_artifacts` or `block_indexing`, the worker records in
 * `documents.metadata.pii.withheldArtifactUris` every artifact written before
 * the PII stage that it did not rewrite (parser candidates, raw vision output,
 * page images, parser JSON, the source file). The API never serves or signs
 * those URIs. `flag_for_review` withholds nothing. Under page-scoped withholding
 * (`block_indexing`) the per-page artifacts of clean pages are left off the list
 * and served; see {@link artifactOnWithheldPage} for per-page artifacts written later.
 */
export function withheldArtifactUrisFromMetadata(metadata: unknown): Set<string> {
  const pii = metadata && typeof metadata === "object" ? (metadata as { pii?: unknown }).pii : null;
  const list = pii && typeof pii === "object" ? (pii as { withheldArtifactUris?: unknown }).withheldArtifactUris : null;
  return new Set(Array.isArray(list) ? list.filter((uri): uri is string => typeof uri === "string") : []);
}

/** Withheld URIs for every document in a run (for run-level artifact lists and exports). */
export async function loadWithheldArtifactUrisForRun(runId: string): Promise<Set<string>> {
  const rows = await sql<{ uri: string }[]>`
    select jsonb_array_elements_text(d.metadata->'pii'->'withheldArtifactUris') as uri
    from documents d
    where d.run_id = ${runId}
      and jsonb_typeof(d.metadata->'pii'->'withheldArtifactUris') = 'array'
  `;
  return new Set(rows.map((row) => row.uri));
}

/** SQL predicate: does document `d` withhold any of these URIs? */
export function documentWithholdsUri(uris: string[]) {
  return sql`exists (
    select 1
    from jsonb_array_elements_text(
      case when jsonb_typeof(d.metadata->'pii'->'withheldArtifactUris') = 'array'
        then d.metadata->'pii'->'withheldArtifactUris' else '[]'::jsonb end
    ) as withheld(uri)
    where withheld.uri = any(${sql.array(uris)})
  )`;
}

/**
 * Page-scoped withholding of each document (packages/shared/src/pii-withholding.ts), read from the live rows. A
 * document the query does not return is absent from the map, which the filters treat as withheld whole.
 */
export async function loadPiiWithholdings(documentIds: readonly string[]): Promise<Map<string, PiiWithholding>> {
  const ids = [...new Set(documentIds)].filter((id) => typeof id === "string" && id.length > 0);
  const out = new Map<string, PiiWithholding>();
  if (ids.length === 0) return out;
  const rows = await sql<{ id: string; status: string | null; pii: unknown }[]>`
    select d.id, d.status, d.metadata->'pii' as pii from documents d where d.id = any(${sql.array(ids)})
  `;
  for (const row of rows) out.set(row.id, piiWithholding({ status: row.status, metadata: row.pii === null || row.pii === undefined ? {} : { pii: row.pii } }));
  return out;
}

/**
 * Search and chat retrieval enforce page withholding on what they return, whatever index served it: hits on a
 * withheld page, hits without a page on a document that withholds pages, and every hit of a blocked document are
 * dropped. The worker already replaced those pages' text before indexing; this is the serving-side check.
 */
export async function filterPiiWithheldResults<T extends WithholdableHit>(results: readonly T[]): Promise<T[]> {
  const documentIds = results
    .filter((result) => (result.citation.source ?? "document") === "document")
    .map((result) => result.citation.documentId);
  if (documentIds.length === 0) return [...results];
  const { kept, dropped } = filterPiiWithheldHits(results, await loadPiiWithholdings(documentIds));
  if (dropped > 0) console.info(`[pii] withheld-hits-dropped count=${dropped}`);
  return kept;
}

/**
 * Whether an artifact URI is a per-page artifact (page image, page render, Doppler figure) of a page the PII policy
 * withholds, or any artifact of a wholly withheld document. Per-page artifacts written after the scan (on-demand page
 * renders) are not in `withheldArtifactUris`; this check covers them by slot and, for figures, by storage key.
 */
export async function artifactOnWithheldPage(uri: string, projectIds: readonly string[], orgId?: string | null): Promise<boolean> {
  if (projectIds.length === 0) return false;
  const rows = await sql<{ document_id: string; slot: string | null; status: string | null; pii: unknown }[]>`
    select d.id as document_id, artifact.slot, d.status, d.metadata->'pii' as pii
    from project_runs runs
    cross join lateral jsonb_each_text(coalesce(runs.artifacts, '{}'::jsonb)) as artifact(slot, value)
    join documents d on d.run_id = runs.id and starts_with(artifact.slot, d.id || ':')
    where runs.project_id = any(${sql.array([...projectIds])})
      and (${orgId === undefined} or runs.org_id = ${orgId ?? null})
      and artifact.value = ${uri}
  `;
  for (const row of rows) {
    const withholding = piiWithholding({ status: row.status, metadata: row.pii === null || row.pii === undefined ? {} : { pii: row.pii } });
    if (withholding.scope === "none" || withholding.scope === "sections") continue;
    if (withholding.scope === "document") return true;
    const page = withheldPageOfSlot((row.slot ?? "").slice(row.document_id.length + 1));
    if (page !== null && isPageWithheld(withholding, page)) return true;
  }
  const figure = DOPPLER_FIGURE_KEY_PAGE.exec(uri);
  if (figure) {
    const [, documentId, page] = figure;
    const [doc] = await sql<{ status: string | null; pii: unknown }[]>`
      select d.status, d.metadata->'pii' as pii from documents d
      where d.id = ${documentId!} and d.project_id = any(${sql.array([...projectIds])})
    `;
    if (doc && isPageWithheld(piiWithholding({ status: doc.status, metadata: doc.pii === null || doc.pii === undefined ? {} : { pii: doc.pii } }), Number(page))) return true;
  }
  return false;
}

/** `<root>/doppler-figures/<document>/p<page>.<n>.<ext>`: a figure's key names its document and page. */
const DOPPLER_FIGURE_KEY_PAGE = /\/doppler-figures\/([A-Za-z0-9-]{1,64})\/p([1-9][0-9]{0,8})\.g?(?:0|[1-9][0-9]{0,5})\.[a-z]+$/;
