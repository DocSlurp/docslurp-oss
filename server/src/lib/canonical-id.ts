export const MAX_CANONICAL_ID_LENGTH = 2048;

export class InvalidCanonicalIdError extends Error {}

/**
 * Canonical IDs name the logical source a document represents, such as a URL,
 * a site path like `/products`, or any caller-chosen key. They are compared
 * exactly (after trimming) within a workspace.
 */
export function normalizeCanonicalId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new InvalidCanonicalIdError("canonicalId must be a string");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_CANONICAL_ID_LENGTH) {
    throw new InvalidCanonicalIdError(`canonicalId must be at most ${MAX_CANONICAL_ID_LENGTH} characters`);
  }
  return trimmed;
}

/** Default identity for fetched URLs: the URL without its fragment or a trailing slash. */
export function canonicalIdForUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString().slice(0, MAX_CANONICAL_ID_LENGTH);
}

/**
 * Multipart uploads carry canonical IDs as one `canonicalId` (single file),
 * repeated `canonicalId` fields in file order, or a `canonicalIds` JSON value:
 * an array aligned with the files, or an object keyed by filename.
 */
export function canonicalIdsForFiles(
  filenames: string[],
  fields: { canonicalId?: unknown; canonicalIds?: unknown },
): Array<string | null> {
  if (Array.isArray(fields.canonicalId)) {
    // Repeated multipart `canonicalId` fields line up with the files.
    if (fields.canonicalId.length !== filenames.length) {
      throw new InvalidCanonicalIdError("Repeated canonicalId fields must match the number of files");
    }
    return fields.canonicalId.map(normalizeCanonicalId);
  }
  if (fields.canonicalId !== undefined && fields.canonicalId !== "") {
    if (filenames.length !== 1) {
      throw new InvalidCanonicalIdError("canonicalId applies to a single file; use canonicalIds for several files");
    }
    return [normalizeCanonicalId(fields.canonicalId)];
  }
  if (fields.canonicalIds === undefined || fields.canonicalIds === "") {
    return filenames.map(() => null);
  }
  let parsed: unknown = fields.canonicalIds;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new InvalidCanonicalIdError("canonicalIds must be valid JSON");
    }
  }
  if (Array.isArray(parsed)) {
    if (parsed.length !== filenames.length) {
      throw new InvalidCanonicalIdError("canonicalIds must have one entry per file");
    }
    return parsed.map(normalizeCanonicalId);
  }
  if (parsed && typeof parsed === "object") {
    const byName = parsed as Record<string, unknown>;
    const unknownNames = Object.keys(byName).filter((name) => !filenames.includes(name));
    if (unknownNames.length > 0) {
      throw new InvalidCanonicalIdError(`canonicalIds names unknown files: ${unknownNames.join(", ")}`);
    }
    return filenames.map((name) => normalizeCanonicalId(byName[name]));
  }
  throw new InvalidCanonicalIdError("canonicalIds must be an array or an object keyed by filename");
}
