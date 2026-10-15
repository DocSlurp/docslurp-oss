type DocumentFileMetadata = {
  mimeType?: string | null;
};

const trustedExtensionsByMimeType: Record<string, string> = {
  "application/epub+zip": ".epub",
  "application/json": ".json",
  "application/x-ndjson": ".jsonl",
  "application/msword": ".doc",
  "application/pdf": ".pdf",
  "application/rtf": ".rtf",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/xml": ".xml",
  "application/zip": ".zip",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/plain": ".txt",
  "text/tab-separated-values": ".tsv",
  "text/xml": ".xml",
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
