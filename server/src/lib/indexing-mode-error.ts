import type { Context } from "hono";
import { apiStatusError } from "./api-error.js";
import type { IndexingModeError } from "../services/workspace-indexing-mode.js";

/**
 * Native envelope for a deferred-indexing refusal. The envelope's `code` stays in
 * the closed vocabulary (derived from the status); the specific reason
 * (`credits_required_for_full_index`, `visual_mode_privacy`, ...) rides along as
 * `details.category` so clients can branch on it.
 */
export function indexingModeErrorResponse(c: Context, error: IndexingModeError): Response {
  return apiStatusError(c, error.status, error.message, { details: { category: error.code } });
}
