import { sha256Hex } from "./hash.js";
import { getPlan } from "./billing.js";

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

/**
 * Versions kept per document: free is always 1 when billing is enforced; paid uses workspace override, then org
 * setting, then the plan default. A deployment that does not bill (`billingEnforced` false) honours the settings
 * on every plan and defaults to the paid plan default, so self-hosted installs are never locked to one version.
 */
export function effectiveRetainedVersions(args: {
  planId: string | null;
  orgSetting: number | null;
  workspaceSetting: number | null;
  billingEnforced: boolean;
}): number {
  const plan = args.billingEnforced ? getPlan(args.planId) : getPlan("silver");
  if (plan.id === "free") return 1;
  const raw = args.workspaceSetting ?? args.orgSetting ?? plan.defaultRetainedVersions;
  const whole = Number.isFinite(raw) ? Math.trunc(raw) : plan.defaultRetainedVersions;
  return Math.min(MAX_RETAINED_VERSIONS, Math.max(MIN_RETAINED_VERSIONS, whole));
}
