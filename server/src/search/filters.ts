/**
 * Parse and validate search filter predicates for metadata-filtered ANN search.
 */

export interface SearchFilters {
  documentId?: string;
  documentIds?: string[];
  runId?: string;
  workspaceId?: string;
  filenameContains?: string;
  mimeTypes?: string[];
  tags?: string[];
  pageRange?: { from?: number; to?: number };
  language?: string;
  headingPath?: string[];
  dateRange?: { from?: string; to?: string };
}

/**
 * Parse search filters from HTTP query params.
 *
 * Expected params: documentId, runId, pageFrom, pageTo, language, heading, dateFrom, dateTo
 */
export function parseFilters(query: Record<string, string>): SearchFilters {
  const filters: SearchFilters = {};

  if (query.documentId) filters.documentId = query.documentId;
  if (query.runId) filters.runId = query.runId;
  if (query.workspaceId) filters.workspaceId = query.workspaceId;
  if (query.filenameContains) filters.filenameContains = query.filenameContains;
  if (query.language) filters.language = query.language;
  if (query.mimeTypes) {
    filters.mimeTypes = query.mimeTypes.split(",").map((value) => value.trim()).filter(Boolean);
  }
  if (query.tags) {
    filters.tags = query.tags.split(",").map((value) => value.trim()).filter(Boolean);
  }

  if (query.heading) {
    filters.headingPath = query.heading.split("/").filter(Boolean);
  }

  const pageFrom = query.pageFrom ? Number(query.pageFrom) : undefined;
  const pageTo = query.pageTo ? Number(query.pageTo) : undefined;
  if (pageFrom !== undefined || pageTo !== undefined) {
    filters.pageRange = {
      from: Number.isFinite(pageFrom) ? pageFrom : undefined,
      to: Number.isFinite(pageTo) ? pageTo : undefined,
    };
  }

  if (query.dateFrom || query.dateTo) {
    filters.dateRange = {
      from: query.dateFrom || undefined,
      to: query.dateTo || undefined,
    };
  }

  return filters;
}

/**
 * Build a SQL WHERE clause fragment for metadata and text retrieval queries.
 * Returns the clause and corresponding parameter array.
 */
export function buildWhereClause(filters: SearchFilters): {
  sql: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.documentIds && filters.documentIds.length > 0) {
    const placeholders = filters.documentIds.map(() => `$${idx++}`).join(", ");
    conditions.push(`document_id IN (${placeholders})`);
    params.push(...filters.documentIds);
  } else if (filters.documentId) {
    conditions.push(`document_id = $${idx++}`);
    params.push(filters.documentId);
  }

  if (filters.runId) {
    conditions.push(`run_id = $${idx++}`);
    params.push(filters.runId);
  }

  if (filters.workspaceId) {
    conditions.push(`document_id in (select id from documents where workspace_id = $${idx++})`);
    params.push(filters.workspaceId);
  }

  if (filters.filenameContains) {
    conditions.push(`document_id in (select id from documents where filename ilike $${idx++})`);
    params.push(`%${filters.filenameContains}%`);
  }

  if (filters.mimeTypes && filters.mimeTypes.length > 0) {
    const placeholders = filters.mimeTypes.map(() => `$${idx++}`).join(", ");
    conditions.push(`document_id in (select id from documents where mime_type in (${placeholders}))`);
    params.push(...filters.mimeTypes);
  }

  if (filters.tags && filters.tags.length > 0) {
    const placeholders = filters.tags.map(() => `$${idx++}`).join(", ");
    conditions.push(
      `document_id in (
        select document_id
        from document_tags
        where tag in (${placeholders})
      )`
    );
    params.push(...filters.tags);
  }

  if (filters.pageRange?.from !== undefined && filters.pageRange?.to !== undefined) {
    conditions.push(`page_number BETWEEN $${idx} AND $${idx + 1}`);
    params.push(filters.pageRange.from, filters.pageRange.to);
    idx += 2;
  } else if (filters.pageRange?.from !== undefined) {
    conditions.push(`page_number >= $${idx++}`);
    params.push(filters.pageRange.from);
  } else if (filters.pageRange?.to !== undefined) {
    conditions.push(`page_number <= $${idx++}`);
    params.push(filters.pageRange.to);
  }

  if (filters.language) {
    conditions.push(`language = $${idx++}`);
    params.push(filters.language);
  }

  if (filters.headingPath && filters.headingPath.length > 0) {
    conditions.push(`heading_path @> $${idx++}`);
    params.push(filters.headingPath);
  }

  if (filters.dateRange?.from !== undefined && filters.dateRange?.to !== undefined) {
    conditions.push(`created_at BETWEEN $${idx} AND $${idx + 1}`);
    params.push(filters.dateRange.from, filters.dateRange.to);
    idx += 2;
  } else if (filters.dateRange?.from !== undefined) {
    conditions.push(`created_at >= $${idx++}`);
    params.push(filters.dateRange.from);
  } else if (filters.dateRange?.to !== undefined) {
    conditions.push(`created_at <= $${idx++}`);
    params.push(filters.dateRange.to);
  }

  return {
    sql: conditions.length > 0 ? conditions.join(" AND ") : "1=1",
    params,
  };
}
