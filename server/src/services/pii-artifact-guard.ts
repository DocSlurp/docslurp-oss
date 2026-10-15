import { sql } from "../db.js";

/**
 * Artifacts withheld by the PII policy. When a document matched under
 * `redact_artifacts` or `block_indexing`, the worker records in
 * `documents.metadata.pii.withheldArtifactUris` every artifact written before
 * the PII stage that it did not rewrite (parser candidates, raw vision output,
 * page images, parser JSON, the source file). The API never serves or signs
 * those URIs. `flag_for_review` withholds nothing.
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
