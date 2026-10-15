/**
 * Workspace slugs: readable, URL-safe workspace identifiers such as
 * `amber-falcon-ridge`. The database generates a three-word slug for every
 * workspace (generate_workspace_slug); users may rename it, and every slug a
 * workspace has used keeps resolving to it, like renamed GitHub repositories.
 * UUIDs remain valid absolute references.
 */

export const WORKSPACE_SLUG_MAX_LENGTH = 63;

/**
 * Fixed path segments under /v1/workspaces and /app/workspaces. A slug may
 * never equal one, and the slug resolver never treats one as a workspace
 * reference. Add new collection-level workspace routes here.
 */
export const WORKSPACE_ROUTE_SEGMENTS: ReadonlySet<string> = new Set(["board", "templates", "invites"]);

/** Words a workspace slug can never take. */
export const RESERVED_WORKSPACE_SLUGS: ReadonlySet<string> = new Set([
  ...WORKSPACE_ROUTE_SEGMENTS,
  "default", "new", "settings", "api", "app", "admin", "workspaces", "search", "docs",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isWorkspaceUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Lowercases, strips accents, and joins words with single hyphens. */
export function slugifyWorkspaceName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, WORKSPACE_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}

/** Returns why a slug is unusable, or null when it is valid. */
export function workspaceSlugProblem(slug: string): string | null {
  if (slug.length < 3 || slug.length > WORKSPACE_SLUG_MAX_LENGTH) {
    return `Workspace slugs must be 3-${WORKSPACE_SLUG_MAX_LENGTH} characters`;
  }
  if (!SLUG_PATTERN.test(slug)) return "Workspace slugs may only contain lowercase letters, digits and single hyphens";
  if (RESERVED_WORKSPACE_SLUGS.has(slug)) return `"${slug}" is reserved`;
  if (isWorkspaceUuid(slug)) return "Workspace slugs cannot look like workspace IDs";
  return null;
}
