import { sha256Hex } from "./hash.js";

export const MAX_SOURCE_PATH_LENGTH = 1024;
export const MIN_RETAINED_VERSIONS = 1;
export const MAX_RETAINED_VERSIONS = 100;

/**
 * Canonical form of a source path (or filename) for version identity: NFC, ASCII-lowercased (A-Z only, to match SQL regardless of collation), `\` as `/`,
 * repeated separators collapsed, leading/trailing separators and whitespace trimmed. Throws on `..`
 * segments or paths longer than 1024 characters.
 */
export function normalizeSourcePath(path: string): string {
  if (path.length > MAX_SOURCE_PATH_LENGTH) throw new Error(`Path exceeds ${MAX_SOURCE_PATH_LENGTH} characters`);
  // Mirrors SQL docslurp_version_key: trim only '/', space, tab, CR, LF (never Unicode whitespace like NBSP).
  const normalized = path
    .replace(/\\/g, "/")
    .normalize("NFC")
    .replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
    .replace(/\/{2,}/g, "/")
    .replace(/^[/ \t\r\n]+|[/ \t\r\n]+$/g, "");
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error("Path must not contain '..' segments");
  }
  if (normalized.length > MAX_SOURCE_PATH_LENGTH) throw new Error(`Path exceeds ${MAX_SOURCE_PATH_LENGTH} characters`);
  return normalized;
}

/**
 * Identity of a document across re-uploads: the connector's `canonicalId` when given, else a hash of the
 * workspace, normalized folder and normalized filename. The same filename in two folders gets two keys.
 */
export function documentVersionKey(args: {
  workspaceId: string;
  path: string;
  filename: string;
  canonicalId?: string | null;
}): string {
  if (args.canonicalId) return args.canonicalId;
  const path = normalizeSourcePath(args.path);
  const name = normalizeSourcePath(args.filename);
  return `path:${sha256Hex(`${args.workspaceId}\n${path}/${name}`).slice(0, 32)}`;
}

/** Versions kept per document chain when neither the workspace nor the org overrides it. */
export const DEFAULT_RETAINED_VERSIONS = 2;

/**
 * Versions kept per document: workspace override, then org setting, then DEFAULT_RETAINED_VERSIONS. The same for
 * every org: storage is billed per GB, so retention is not gated by funding.
 */
export function effectiveRetainedVersions(args: {
  orgSetting: number | null;
  workspaceSetting: number | null;
}): number {
  const raw = args.workspaceSetting ?? args.orgSetting ?? DEFAULT_RETAINED_VERSIONS;
  const whole = Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_RETAINED_VERSIONS;
  return Math.min(MAX_RETAINED_VERSIONS, Math.max(MIN_RETAINED_VERSIONS, whole));
}
