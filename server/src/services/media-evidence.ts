import { mediaSummarySchema, searchResultSchema, type SearchResult } from "@docslurp/shared";
import { sql } from "../db.js";
import { getArtifactText } from "../lib/artifacts.js";
import { withheldArtifactUrisFromMetadata } from "./pii-artifact-guard.js";

/** The caller authorizes workspaceId first. Read only indexed, current media in that workspace.
 * Indexed page text already contains timestamped transcript and sampled frame descriptions,
 * with the ingestion PII policy applied. Never return the raw pre-policy sidecar.
 */
export async function loadMediaEvidence(workspaceId: string, documentId: string, offset = 0) {
  const [row] = await sql<{
    filename: string; metadata: unknown; artifacts: Record<string, string> | null;
    text: string; total_chars: number;
  }[]>`
    select d.filename, d.metadata, r.artifacts,
      substring(p.text from ${offset + 1} for 16000) as text, length(p.text)::int as total_chars
    from documents d
    join workspace_runs r on r.id = d.run_id
    join document_pages p on p.document_id = d.id and p.page_number = 1
    where d.id = ${documentId} and d.workspace_id = ${workspaceId}
      and d.status = 'completed' and d.superseded_at is null
      and (d.mime_type like 'video/%' or d.mime_type like 'audio/%')
    limit 1
  `;
  if (!row) return null;
  const summaryUri = row.artifacts?.[`${documentId}:media-summary`];
  let summary = null;
  if (summaryUri && !withheldArtifactUrisFromMetadata(row.metadata).has(summaryUri)) {
    try {
      const parsed = mediaSummarySchema.safeParse(JSON.parse(await getArtifactText(summaryUri, 1024 * 1024)));
      if (parsed.success) summary = parsed.data;
    } catch {
      console.warn(`[media-evidence] summary_unavailable document_id=${documentId}`);
    }
  }
  const results: SearchResult[] = row.text ? [searchResultSchema.parse({ text: row.text, score: 1, citation: {
    documentId, filename: row.filename, pageNumber: 1, chunkIndex: 0, headingPath: [],
  } })] : [];
  return {
    documentId, filename: row.filename, summary, results,
    nextOffset: offset + row.text.length < row.total_chars ? offset + row.text.length : null,
    totalCharacters: row.total_chars,
    evidenceNote: "Video is represented by timestamped transcript and sampled frame descriptions. One logical page is not one frame. Only describe visuals present in the retrieved evidence; sampled frames do not establish every transition or continuous motion.",
  };
}
