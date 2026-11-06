import { FILE_FORMATS } from "@docslurp/shared";

type DocumentFileMetadata = {
  mimeType?: string | null;
};

/**
 * The temp-file extension for each MIME type: derived from FILE_FORMATS (every accepted format, canonical type and
 * aliases), so a format intake accepts always reaches its reader with its extension (ODT was missing: every ODT upload
 * failed as "pandoc unavailable", validation N4). The extras are container types that are not uploads by themselves.
 */
const trustedExtensionsByMimeType: Record<string, string> = {
  "application/xml": ".xml",
  "application/zip": ".zip",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "text/xml": ".xml",
  ...Object.fromEntries(FILE_FORMATS.flatMap((spec) => [spec.mimeType, ...(spec.aliases ?? [])].map((mime) => [mime, spec.extensions[0]!]))),
};

export function trustedTempFileExtensionForDocument(
  document: DocumentFileMetadata,
): string {
  const mimeType = document.mimeType?.split(";")[0]?.trim().toLowerCase();
  if (!mimeType) {
    return "";
  }

  return trustedExtensionsByMimeType[mimeType] ?? "";
}

export function trustedTempDownloadPattern(
  prefix: string,
  document: DocumentFileMetadata,
): string {
  return `${prefix}*${trustedTempFileExtensionForDocument(document)}`;
}
