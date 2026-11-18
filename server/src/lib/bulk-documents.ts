import type { Context } from "hono";
import { z } from "zod";
import { BULK_DOCUMENTS_MAX, publicApiErrorMessage } from "@docslurp/shared";
import { apiErrorResponse } from "./api-error.js";

/**
 * A document id as a bulk request may name it: the id shape documents use (a UUID; seeded and test ids are short
 * slugs), at most 64 characters. Anything else is a 400 from the schema, before any lookup or change, so no id can
 * reach an index or an audit record oversized or malformed.
 */
export const bulkDocumentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, "documentIds entries must be document ids");

/** The bulk routes' `documentIds`: one or more well-formed ids (the per-request limit is answered with its own copy). */
export const bulkDocumentIdsSchema = z.array(bulkDocumentIdSchema).min(1);

/** A 400 with reviewed copy when a bulk request names more than BULK_DOCUMENTS_MAX documents; null otherwise. */
export function bulkDocumentsLimitResponse(c: Context, documentIds: readonly string[]): Response | null {
  if (documentIds.length <= BULK_DOCUMENTS_MAX) return null;
  const details = { policy: "bulk_documents_limit", limit: BULK_DOCUMENTS_MAX };
  return apiErrorResponse(c, 400, "invalid_request", publicApiErrorMessage("invalid_request", details), details);
}

/**
 * The audit record's resource id for a bulk change: the ids themselves for a short list, else the first
 * BULK_AUDIT_LISTED and a count. Ids are at most 64 characters (bulkDocumentIdSchema), so it stays far below the
 * audit log's index row limit; the full list goes in the record's metadata (`documentIds`).
 */
const BULK_AUDIT_LISTED = 20;
export function bulkAuditResourceId(documentIds: readonly string[]): string {
  if (documentIds.length <= BULK_AUDIT_LISTED) return documentIds.join(",");
  return `${documentIds.slice(0, BULK_AUDIT_LISTED).join(",")},+${documentIds.length - BULK_AUDIT_LISTED} more`;
}
