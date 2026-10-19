import path from "node:path";

import { env } from "../config.js";

const complexRemoteMimeTypes = new Set([
  "text/html",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "application/epub+zip",
  "application/x-latex",
  "text/x-tex",
  "image/tiff"
]);

const complexRemoteExtensions = new Set([
  ".html",
  ".htm",
  ".mhtml",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".rtf",
  ".epub",
  ".tex",
  ".tif",
  ".tiff"
]);

export type RemoteIngestSourceKind = "url" | "connector";

function normalizeMimeType(value: string | null | undefined): string | null {
  const normalized = value?.split(";")[0]?.trim().toLowerCase() ?? null;
  return normalized && normalized !== "application/octet-stream" ? normalized : null;
}

function sourceKindLabel(kind: RemoteIngestSourceKind): string {
  switch (kind) {
    case "connector":
      return "Connector source";
    default:
      return "Remote source";
  }
}

export function isComplexRemoteIngestFormat(mimeType: string | null | undefined, filename: string): boolean {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (normalizedMimeType && complexRemoteMimeTypes.has(normalizedMimeType)) {
    return true;
  }

  return complexRemoteExtensions.has(path.extname(filename).toLowerCase());
}

export function explainRemoteIngestBlock(args: {
  kind: RemoteIngestSourceKind;
  filename: string;
  mimeType: string | null | undefined;
}): string {
  const normalizedMimeType = normalizeMimeType(args.mimeType) ?? "unknown";
  return `${sourceKindLabel(args.kind)} ${args.filename} requires the full parser surface (${normalizedMimeType}). Remote ingest is lean-only by default; direct upload the file or set REMOTE_INGEST_COMPLEX_FORMATS_ENABLED=true to opt into complex remote formats.`;
}

export function assertRemoteIngestParserSurface(args: {
  kind: RemoteIngestSourceKind;
  filename: string;
  mimeType: string | null | undefined;
}): void {
  if (env.remoteIngestComplexFormatsEnabled) {
    return;
  }

  if (isComplexRemoteIngestFormat(args.mimeType, args.filename)) {
    throw new Error(explainRemoteIngestBlock(args));
  }
}
