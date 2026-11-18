import { MIME_BY_EXTENSION, bareMimeType, canonicalMimeType } from "@docslurp/shared";
import { isUrlShapedCanonicalId, opaqueCanonicalIdForUrl, tryCanonicalIdForUrl } from "./canonical-id.js";

const UUID_PREFIXED = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/i;

/** The first extension whose canonical MIME type is `mimeType` (`.pdf`), or `.bin`. */
export function extensionForMimeType(mimeType: string): string {
  const canonical = canonicalMimeType(mimeType) ?? bareMimeType(mimeType);
  return Object.entries(MIME_BY_EXTENSION).find(([, mime]) => mime === canonical)?.[0] ?? ".bin";
}

/** The URL a document was fetched from (`metadata.sourceUrl`, set by URL intake), or null. */
export function documentSourceUrl(metadata: unknown): URL | null {
  const value = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).sourceUrl : undefined;
  if (typeof value !== "string") return null;
  try { return new URL(value); } catch { return null; }
}

/**
 * A URL-origin document's canonical ID as responses show it. The server's
 * legacy default (the URL itself, which can carry a signed query) becomes
 * `url:` + sha256; a caller's own ID, or one already opaque, is kept. Never throws.
 */
export function publicUrlCanonicalId(canonicalId: string | null | undefined, sourceUrl: URL): string | null {
  if (!canonicalId) return null;
  if (!isUrlShapedCanonicalId(canonicalId)) return canonicalId;
  const serverDefault = tryCanonicalIdForUrl(sourceUrl.href);
  return serverDefault !== null && canonicalId === serverDefault ? opaqueCanonicalIdForUrl(canonicalId) : canonicalId;
}

/**
 * A storage key with its final, filename-bearing segment replaced by `name`
 * (keeping the server's `<uuid>-` prefix), so a URL-derived filename never
 * shows in a response.
 */
export function sourceKeyWithName(sourceKey: string, name: string): string {
  const slash = sourceKey.lastIndexOf("/");
  const directory = sourceKey.slice(0, slash + 1);
  const match = UUID_PREFIXED.exec(sourceKey.slice(slash + 1));
  return `${directory}${match ? `${match[1]}-` : ""}${name}`;
}

/**
 * A URL-origin document's source key as responses show it: unchanged when its
 * final segment is already the safe `<host>-<index><ext>` form, otherwise the
 * segment becomes `<host><ext>` (a legacy key named after the URL's path).
 */
export function publicUrlSourceKey(sourceKey: string, sourceUrl: URL, mimeType: string | null | undefined): string {
  const segment = sourceKey.slice(sourceKey.lastIndexOf("/") + 1);
  const name = UUID_PREFIXED.exec(segment)?.[2] ?? segment;
  const host = sourceUrl.hostname;
  const safe = new RegExp(`^${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+\\.[a-z0-9]+$`, "i");
  return safe.test(name) ? sourceKey : sourceKeyWithName(sourceKey, `${host}${extensionForMimeType(mimeType ?? "")}`);
}

/**
 * The public read boundary for a stored document's identity (document, run and
 * project responses): a URL-origin document's legacy canonical ID and source
 * key are redacted at read time; any other document is unchanged. No data migration.
 */
export function publicDocumentIdentity(row: { canonical_id?: string | null; source_key: string; mime_type?: string | null; metadata?: unknown }): { canonicalId: string | null; sourceKey: string } {
  const sourceUrl = documentSourceUrl(row.metadata);
  if (!sourceUrl) return { canonicalId: row.canonical_id ?? null, sourceKey: row.source_key };
  return { canonicalId: publicUrlCanonicalId(row.canonical_id, sourceUrl), sourceKey: publicUrlSourceKey(row.source_key, sourceUrl, row.mime_type) };
}
