import type { Context } from "hono";
import { apiStatusError } from "./api-error.js";
import type { IndexingModeError } from "../services/project-indexing-mode.js";

/**
 * Native envelope for a deferred-indexing refusal. The envelope's `code` stays in
 * the closed vocabulary (derived from the status); the specific reason
 * (`visual_mode_privacy`, ...) rides along as
 * `details.category` so clients can branch on it.
 */
export function indexingModeErrorResponse(c: Context, error: IndexingModeError): Response {
  // The editor-only refusal is the shared `editor_required` code, like every other route's.
  return apiStatusError(c, error.status, error.message, { ...(error.code === "editor_required" ? { code: error.code } : {}), details: { category: error.code } });
}
