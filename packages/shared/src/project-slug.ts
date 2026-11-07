/**
 * Project slugs: readable, URL-safe project identifiers such as
 * `amber-falcon-ridge`. The database generates a three-word slug for every
 * project (generate_project_slug); users may rename it, and every slug a
 * project has used keeps resolving to it, like renamed GitHub repositories.
 * UUIDs remain valid absolute references.
 */

import { foldFullWidthAscii, normalizeExtractedText } from "./text-normalization.js";

export const PROJECT_SLUG_MAX_LENGTH = 63;

/**
 * Fixed path segments under /v1/projects and /app/projects. A slug may
 * never equal one, and the slug resolver never treats one as a project
 * reference. Add new collection-level project routes here.
 */
export const PROJECT_ROUTE_SEGMENTS: ReadonlySet<string> = new Set(["board", "templates", "invites"]);

/** Words a project slug can never take. */
export const RESERVED_PROJECT_SLUGS: ReadonlySet<string> = new Set([
  ...PROJECT_ROUTE_SEGMENTS,
  "default", "new", "settings", "api", "app", "admin", "projects", "search", "docs",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isProjectUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Lowercases, strips accents, and joins words with single hyphens. */
export function slugifyProjectName(value: string): string {
  return foldFullWidthAscii(normalizeExtractedText(value))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROJECT_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}

/** Returns why a slug is unusable, or null when it is valid. */
export function projectSlugProblem(slug: string): string | null {
  if (slug.length < 3 || slug.length > PROJECT_SLUG_MAX_LENGTH) {
    return `Project slugs must be 3-${PROJECT_SLUG_MAX_LENGTH} characters`;
  }
  if (!SLUG_PATTERN.test(slug)) return "Project slugs may only contain lowercase letters, digits and single hyphens";
  if (RESERVED_PROJECT_SLUGS.has(slug)) return `"${slug}" is reserved`;
  if (isProjectUuid(slug)) return "Project slugs cannot look like project IDs";
  return null;
}

/** Longest `project` request value accepted (a display name, slug or UUID). */
export const PROJECT_INPUT_MAX_LENGTH = 256;
/** Longest project display name; longer `project` values are cut to it when an upload creates one. */
export const PROJECT_NAME_MAX_LENGTH = 120;

/**
 * What a public `project` request value refers to. Every request that targets
 * a project takes one string: a project UUID, a slug (current or former), or
 * a name, which is matched by its slug, so "Legal Contracts", "legal-contracts"
 * and "  LÉGAL—contracts! " all mean the same project.
 *
 * - `default`: omitted, blank, or the reserved "default" alias.
 * - `id`: a project UUID.
 * - `slug`: anything else; `name` is the trimmed input as typed, used as the
 *   display name when an upload creates the project.
 * - `invalid`: nothing usable is left after slugifying (e.g. "!!!").
 */
export type ProjectInputRef =
  | { kind: "default" }
  | { kind: "id"; id: string }
  | { kind: "slug"; slug: string; name: string }
  | { kind: "invalid"; input: string; message: string };

export function parseProjectInput(value: string | null | undefined): ProjectInputRef {
  const input = value?.trim() ?? "";
  if (!input) return { kind: "default" };
  if (isProjectUuid(input)) return { kind: "id", id: input.toLowerCase() };
  const slug = slugifyProjectName(input);
  if (!slug) {
    return { kind: "invalid", input, message: `project "${input}" has no letters or digits; pass a project ID, slug or name` };
  }
  if (slug === "default") return { kind: "default" };
  return { kind: "slug", slug, name: input.slice(0, PROJECT_NAME_MAX_LENGTH).trim() };
}
