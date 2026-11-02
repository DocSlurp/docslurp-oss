import type { GeoPredicate } from "@docslurp/shared";
/**
 * Parse and validate search filter predicates for metadata-filtered ANN search.
 */

export interface SearchFilters {
  geo?: GeoPredicate;
  /** Internal digest set only by authorized spatial scope resolution. */
  geoSchemaDigest?: string;
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
