import { EDITOR_REQUIRED_CODE, EDITOR_REQUIRED_MESSAGE } from "@docslurp/shared";

/**
 * Work that needs edit access refused for a caller who can see the project (HTTP 403, code `editor_required`, the shared
 * EDITOR_REQUIRED_MESSAGE). Services throw it; routes and the app error handler answer it the same way. Kept in its own
 * module (not organizations.ts) so test doubles of the access services need not provide it.
 */
export class EditorRequiredError extends Error {
  readonly status = 403 as const;
  readonly code = EDITOR_REQUIRED_CODE;
  constructor(message: string = EDITOR_REQUIRED_MESSAGE) { super(message); this.name = "EditorRequiredError"; }
}
