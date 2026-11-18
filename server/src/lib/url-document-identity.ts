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
  return isSafeUrlName(name, host) ? sourceKey : sourceKeyWithName(sourceKey, `${host}${extensionForMimeType(mimeType ?? "")}`);
}

/** Whether `name` is the safe `<host>-<index><ext>` form for `host`. */
function isSafeUrlName(name: string, host: string): boolean {
  return new RegExp(`^${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+\\.[a-z0-9]+$`, "i").test(name);
}

/**
 * A URL-origin document's filename as responses show it: unchanged in the safe
 * `<host>-<index><ext>` form, otherwise `<host><ext>` (a legacy name taken
 * from the URL's path). Display only.
 */
export function publicUrlFilename(filename: string, sourceUrl: URL, mimeType: string | null | undefined): string {
  return isSafeUrlName(filename, sourceUrl.hostname) ? filename : `${sourceUrl.hostname}${extensionForMimeType(mimeType ?? "")}`;
}

/** Documents whose filename the read boundary replaced, so a list can make the replacements unique. */
const redactedNames = new WeakSet<object>();

/** Whether `document` carries a read-boundary filename. */
export function hasRedactedFilename(document: object): boolean {
  return redactedNames.has(document);
}

/** Marks `document` as carrying a read-boundary filename (call on the mapped response object). */
export function markRedactedFilename<T extends object>(document: T, redacted: boolean): T {
  if (redacted) redactedNames.add(document);
  return document;
}

/**
 * Makes read-boundary filenames unique within one response: a second document
 * presented as `<host><ext>` becomes `<host>-<n><ext>` (the first free n).
 * Other filenames are never changed. Returns the same array.
 */
export function withUniqueRedactedFilenames<T extends { filename: string }>(documents: T[]): T[] {
  const used = new Set(documents.filter((document) => !redactedNames.has(document)).map((document) => document.filename));
  for (const document of documents) {
    if (!redactedNames.has(document)) continue;
    if (!used.has(document.filename)) { used.add(document.filename); continue; }
    const dot = document.filename.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [document.filename.slice(0, dot), document.filename.slice(dot)] : [document.filename, ""];
    let n = 1;
    while (used.has(`${stem}-${n}${ext}`)) n++;
    document.filename = `${stem}-${n}${ext}`;
    used.add(document.filename);
  }
  return documents;
}

/**
 * The public read boundary for a stored document's identity (document, run,
 * project, forensics and delete responses): a URL-origin document's legacy
 * canonical ID, source key and filename are redacted at read time; any other
 * document is unchanged. No data migration.
 */
export function publicDocumentIdentity(row: { canonical_id?: string | null; source_key: string; filename?: string; mime_type?: string | null; metadata?: unknown }): { canonicalId: string | null; sourceKey: string; filename: string; filenameRedacted: boolean } {
  const sourceUrl = documentSourceUrl(row.metadata);
  const filename = row.filename ?? "";
  if (!sourceUrl) return { canonicalId: row.canonical_id ?? null, sourceKey: row.source_key, filename, filenameRedacted: false };
  const publicName = publicUrlFilename(filename, sourceUrl, row.mime_type);
  return {
    canonicalId: publicUrlCanonicalId(row.canonical_id, sourceUrl),
    sourceKey: publicUrlSourceKey(row.source_key, sourceUrl, row.mime_type),
    filename: publicName,
    filenameRedacted: publicName !== filename,
  };
}
