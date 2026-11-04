import { geoProjectionFieldPointer } from "@docslurp/shared";
import { spatialPredicate } from "./geo-predicate.js";
import { sql } from "../db.js";
import { andSqlFragments, type SqlFragment } from "../lib/sql-fragments.js";
import { escapeLikePattern, type SearchFilters } from "./filters.js";

/** Shared filter semantics for evidence adapters; readiness remains adapter-specific.
 * Project access must already be authorized. Caller filters intersect that scope.
 * Dates describe evidence creation, not document creation.
 */
export function retrievalScope(args: { projectId?: string; filters?: SearchFilters; runId?: string }) {
  const filters = args.filters ?? {};
  const documentPredicate = (id: SqlFragment): SqlFragment => {
    const conditions: SqlFragment[] = [];
    if (args.projectId) conditions.push(sql`scope_document.project_id = ${args.projectId}`);
    if (filters.projectId) conditions.push(sql`scope_document.project_id = ${filters.projectId}`);
    if (filters.documentId) conditions.push(sql`scope_document.id = ${filters.documentId}`);
    if (filters.documentIds !== undefined) conditions.push(sql`scope_document.id in (select jsonb_array_elements_text(${sql.json(filters.documentIds)}::jsonb))`);
    if (filters.geo) {
      if (!filters.geoSchemaDigest || filters.documentIds === undefined) throw new Error("Unresolved spatial retrieval scope");
      conditions.push(sql`exists(select 1 from ready_geo_projection_generations geo_g
        join geo_projection_features geo_f on (geo_f.document_id,geo_f.project_id,geo_f.org_id,geo_f.source_revision)=
          (geo_g.document_id,geo_g.project_id,geo_g.org_id,geo_g.source_revision)
        where geo_g.document_id=scope_document.id and geo_g.project_id=scope_document.project_id
          and geo_g.org_id=scope_document.org_id and geo_g.schema_digest=${filters.geoSchemaDigest}
          and geo_f.field_path=${geoProjectionFieldPointer(filters.geo.field)}
          and ${spatialPredicate(filters.geo,sql`geo_f.geom`)})`);
    }
    // Literal substring: caller text must not act as LIKE wildcards and widen the match.
    if (filters.filenameContains) conditions.push(sql`scope_document.filename ilike ${`%${escapeLikePattern(filters.filenameContains)}%`} escape '\\'`);
    if (filters.filenameEquals !== undefined) conditions.push(sql`scope_document.filename = ${filters.filenameEquals}`);
    if (filters.mimeTypes?.length) conditions.push(sql`scope_document.mime_type = any(${sql.array(filters.mimeTypes)})`);
    if (filters.tags?.length) conditions.push(sql`exists (select 1 from document_tags tagged where tagged.document_id = scope_document.id and tagged.tag = any(${sql.array(filters.tags)}))`);
    return sql`exists (select 1 from documents scope_document where scope_document.id = ${id} and ${andSqlFragments(conditions)})`;
  };
  function evidencePredicate(target: "chunk" | "graph-chunk" | "page" | "progressive-page", includeDocument = true): SqlFragment {
    const alias = target === "chunk" ? "c" : target === "graph-chunk" ? "chunk" : target === "page" ? "p" : "progressive_pages";
    const column = (name: string): SqlFragment => sql`${sql(alias)}.${sql(name)}`;
    const conditions: SqlFragment[] = includeDocument ? [documentPredicate(column("document_id"))] : [];
    if (args.runId) conditions.push(sql`${column("run_id")} = ${args.runId}`);
    if (filters.runId) conditions.push(sql`${column("run_id")} = ${filters.runId}`);
    if (filters.pageRange?.from !== undefined) conditions.push(sql`${column("page_number")} >= ${filters.pageRange.from}`);
    if (filters.pageRange?.to !== undefined) conditions.push(sql`${column("page_number")} <= ${filters.pageRange.to}`);
    if (filters.dateRange?.from !== undefined) conditions.push(sql`${column("created_at")} >= ${filters.dateRange.from}::timestamptz`);
    if (filters.dateRange?.to !== undefined) conditions.push(sql`${column("created_at")} <= ${filters.dateRange.to}::timestamptz`);
    if (target === "chunk" || target === "graph-chunk") {
      if (filters.language) conditions.push(sql`${column("metadata")} ->> 'language' = ${filters.language}`);
      if (filters.headingPath?.length) conditions.push(sql`${column("heading_path")} @> ${sql.array(filters.headingPath)}`);
    } else if (filters.language || filters.headingPath?.length) conditions.push(sql`false`);
    return andSqlFragments(conditions);
  }
  return {
    vectorDocument: () => {
      const document = documentPredicate(sql`d.id`);
      // Only probe chunks when the request actually restricts chunk evidence.
      // Document-only scopes need no extra per-document chunk lookup before ANN.
      const hasChunkFilters = args.runId || filters.runId || filters.language || filters.headingPath?.length
        || filters.pageRange?.from !== undefined || filters.pageRange?.to !== undefined
        || filters.dateRange?.from !== undefined || filters.dateRange?.to !== undefined;
      return hasChunkFilters
        ? sql`${document} and exists (select 1 from document_chunks c where c.document_id = d.id and ${evidencePredicate("chunk", false)})`
        : document;
    },
    chunk: () => evidencePredicate("chunk"),
    graphChunk: () => evidencePredicate("graph-chunk"),
    page: () => evidencePredicate("page"),
    progressivePage: () => evidencePredicate("progressive-page"),
    supportsPages: !filters.language && !filters.headingPath?.length,
  };
}
