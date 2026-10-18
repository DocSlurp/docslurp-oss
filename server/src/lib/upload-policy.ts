import path from "node:path";

import { bodyLimit } from "hono/body-limit";

import { env } from "../config.js";
import { apiErrorResponse } from "./api-error.js";

const supportedMimeTypes = new Set([
  "application/pdf",
  "text/markdown",
  "text/plain",
  "text/html",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "application/rtf",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/x-ndjson",
  "application/epub+zip",
  "application/x-latex",
  "text/x-tex",
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/webp",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm"
]);

const extensionFallbackMimeTypes: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".rtf": "application/rtf",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".epub": "application/epub+zip",
  ".tex": "application/x-latex",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".weba": "audio/webm",
  ".webm": "video/webm",
  ".mp4": "video/mp4"
};

function normalizeMimeType(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.split(";")[0]?.trim().toLowerCase() ?? null;
  return normalized && normalized !== "application/octet-stream" ? normalized : null;
}

export function isSupportedUploadMimeType(mimeType: string | null | undefined, filename?: string): boolean {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (normalizedMimeType && supportedMimeTypes.has(normalizedMimeType)) {
    return true;
  }

  if (!filename) {
    return false;
  }

  const fallbackMimeType = extensionFallbackMimeTypes[path.extname(filename).toLowerCase()];
  return fallbackMimeType ? supportedMimeTypes.has(fallbackMimeType) : false;
}

export function resolveUploadMimeType(mimeType: string | null | undefined, filename: string): string {
  const normalizedMimeType = normalizeMimeType(mimeType);
  if (normalizedMimeType && supportedMimeTypes.has(normalizedMimeType)) {
    return normalizedMimeType;
  }

  const fallbackMimeType = extensionFallbackMimeTypes[path.extname(filename).toLowerCase()];
  if (fallbackMimeType) {
    return fallbackMimeType;
  }

  throw new Error(`Unsupported file type for ${filename}`);
}

export function enforceUploadSize(sizeBytes: number, label: string): void {
  if (sizeBytes > env.maxUploadBytes) {
    throw new Error(`${label} exceeds MAX_UPLOAD_BYTES (${env.maxUploadBytes} bytes)`);
  }
}

export function enforceRequestContentLength(rawContentLength: string | null | undefined): void {
  if (!rawContentLength) {
    return;
  }

  const contentLength = Number(rawContentLength);
  if (Number.isFinite(contentLength) && contentLength > env.maxUploadBytes) {
    throw new Error(`Request body exceeds MAX_UPLOAD_BYTES (${env.maxUploadBytes} bytes)`);
  }
}

/** Envelope message and details for a multipart (/v1/ingest/bulk) request over MAX_MULTIPART_UPLOAD_BYTES. */
export function multipartTooLarge(maxBytes: number) {
  const mb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
  return {
    message:
      `Multipart uploads to /v1/ingest/bulk are limited to ${mb} MB per request. ` +
      "Upload larger files with a direct upload session: POST /v1/ingest/direct/sessions, " +
      "PUT each file to the returned URLs, then POST /v1/ingest/direct/sessions/{sessionId}/confirm. " +
      "The SDK (client.upload) and CLI (docslurp upload) do this automatically.",
    details: {
      maxBytes,
      directUpload: {
        createSession: "/v1/ingest/direct/sessions",
        maxFileBytes: env.maxUploadBytes,
      },
    },
  };
}

/** Body limit for /v1/ingest/bulk that answers 413 with the direct-upload hint. */
export function multipartBodyLimit(maxBytes: number) {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) => {
      const { message, details } = multipartTooLarge(maxBytes);
      return apiErrorResponse(c, 413, "payload_too_large", message, details);
    },
  });
}

export function listSupportedUploadMimeTypes(): string[] {
  return [...supportedMimeTypes].sort();
}
