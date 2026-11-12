import { hasCurrentParseDecision, type ParseSourceDecisionColumns } from "@docslurp/shared";
import type postgres from "postgres";

/**
 * Cutover for PR #339 (scan what we parse): documents with no parse decision from the current scan are refused by every
 * parser, the page renderer and materialization until a reprocess re-quarantines them. These are the live documents an
 * operator reprocesses (server/scripts/reprocess-unscanned-documents.ts, docs/self-host/operations.md).
 */
export interface RescanCandidate {
  id: string;
  orgId: string;
  projectId: string;
  mimeType: string;
}

export interface RescanCandidateOptions {
  /** Only these organizations (omit for every organization). */
  orgIds?: string[];
  /** Only these MIME types (omit for every type). Page renders and materialization read PDFs. */
  mimeTypes?: string[];
  /** At most this many candidates, oldest first. */
  limit: number;
}

/**
 * Live (not superseded, archived or purged) completed documents without a current decision, excluding extract documents
 * (never reprocessed) and documents whose newer version is already queued or processing (a re-run resumes, never doubles).
 */
export async function selectRescanCandidates(sql: postgres.Sql, options: RescanCandidateOptions): Promise<RescanCandidate[]> {
  const orgIds = options.orgIds ?? [];
  const mimeTypes = options.mimeTypes ?? [];
  const candidates: RescanCandidate[] = [];
  type Row = ParseSourceDecisionColumns & { id: string; org_id: string; project_id: string; mime_type: string; created_cursor: string };
  // Keyset pages: a large database is never held in memory at once; the decision rule is the shared one.
  // The cursor is created_at as Postgres prints it: a JS Date would drop its microseconds and repeat rows.
  let after: { createdAt: string; id: string } | null = null;
  for (;;) {
    const rows: Row[] = await sql<Row[]>`
      select d.id, d.org_id, d.project_id, d.mime_type, d.created_at::text as created_cursor,
        d.source_sha256, d.parse_source_key, d.parse_source_sha256, d.parse_source_scan_version
      from documents d
      where d.status = 'completed'
        and d.superseded_at is null and d.archived_at is null and d.purged_at is null
        and d.org_id is not null
        and (${orgIds.length === 0} or d.org_id = any(${sql.array(orgIds)}))
        and (${mimeTypes.length === 0} or d.mime_type = any(${sql.array(mimeTypes)}))
        and (${after === null} or (d.created_at, d.id) > (${after?.createdAt ?? "epoch"}::text::timestamptz, ${after?.id ?? ""}::text))
        and not exists (select 1 from project_runs r where r.id = d.run_id and r.extract_id is not null)
        and not exists (
          select 1 from documents n
          where n.previous_version_id = d.id and n.superseded_at is null and n.status in ('queued', 'processing')
        )
      order by d.created_at, d.id
      limit 500
    `;
    for (const row of rows) {
      if (hasCurrentParseDecision(row)) continue;
      candidates.push({ id: row.id, orgId: row.org_id, projectId: row.project_id, mimeType: row.mime_type });
      if (candidates.length >= options.limit) return candidates;
    }
    if (rows.length < 500) return candidates;
    const last = rows[rows.length - 1]!;
    after = { createdAt: last.created_cursor, id: last.id };
  }
}

/** The organization's earliest owner: owners edit every project, so bulk reprocess reaches all of its documents. */
export async function organizationOwner(sql: postgres.Sql, orgId: string): Promise<string | null> {
  const [row] = await sql<{ user_id: string }[]>`
    select user_id from org_memberships where org_id = ${orgId} and role = 'owner' order by created_at, user_id limit 1`;
  return row?.user_id ?? null;
}
