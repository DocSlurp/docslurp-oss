/**
 * Server keys with `ingest` keep a project's content current without a
 * dashboard session: reprocess runs, delete or retag documents and act on
 * ingest-report findings (the same work a re-upload could do). Client keys
 * never can: they sit in page source. Routes still check the key's
 * organization and project restriction per resource, and the services check
 * that the key's user can edit the project.
 */
export function apiKeyCanUpdateContent(key: { scopes: readonly string[]; keyType?: string }): boolean {
  return key.keyType === "server" && key.scopes.includes("ingest");
}

export const CONTENT_UPDATE_SCOPE_MESSAGE = "This endpoint requires a server API key with the ingest scope";
