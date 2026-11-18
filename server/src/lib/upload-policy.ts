import type { Context } from "hono";
import { bareMimeType, isSupportedFileType, resolveSupportedMimeType, SUPPORTED_UPLOAD_MIME_TYPES } from "@docslurp/shared";

import { env } from "../config.js";
import { apiErrorResponse, bodyBudgetBusyResponse } from "./api-error.js";
import { boundedBodyLimit } from "./bounded-body-limit.js";

/** Intake accepts exactly the formats in the shared table the worker, the quote and the estimator card read. */
function normalizeMimeType(value: string | null | undefined): string | null {
  const bare = bareMimeType(value);
  return bare && bare !== "application/octet-stream" ? bare : null;
}

export function isSupportedUploadMimeType(mimeType: string | null | undefined, filename?: string): boolean {
  return isSupportedFileType(normalizeMimeType(mimeType), filename);
}

export function resolveUploadMimeType(mimeType: string | null | undefined, filename: string): string {
  const resolved = resolveSupportedMimeType(normalizeMimeType(mimeType), filename);
  if (resolved) return resolved;
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

/** Envelope message and details for a multipart (/v1/uploads/bulk) request over MAX_MULTIPART_UPLOAD_BYTES. */
export function multipartTooLarge(maxBytes: number) {
  const mb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
  return {
    message:
      `Multipart uploads to /v1/uploads/bulk are limited to ${mb} MB per request. ` +
      "Upload larger files with a direct upload session: POST /v1/uploads/direct/sessions, " +
      "PUT each file to the returned URLs, then POST /v1/uploads/direct/sessions/{sessionId}/confirm. " +
      "The SDK (client.upload) and CLI (docslurp upload) do this automatically.",
    details: {
      maxBytes,
      directUpload: {
        createSession: "/v1/uploads/direct/sessions",
        maxFileBytes: env.maxUploadBytes,
      },
    },
  };
}

/**
 * Body limit for /v1/uploads/bulk that answers 413 with the direct-upload hint.
 * Counts the bytes actually received: Hono's limiter trusts a declared
 * Content-Length, and an in-process Request can carry a stream longer than it.
 * The route's parseBody buffers the whole body anyway, so buffering here first
 * costs no more than the cap.
 */
export function multipartBodyLimit(maxBytes: number) {
  return boundedBodyLimit(maxBytes, (c) => {
    const { message, details } = multipartTooLarge(maxBytes);
    return apiErrorResponse(c, 413, "payload_too_large", message, details);
  }, { onTimeout: multipartTimeoutResponse, onBusy: bodyBudgetBusyResponse });
}

/**
 * A bulk upload that did not finish within its read deadline (slow but steady
 * links included): 408 with the direct-upload hint, whose public copy points
 * clients there (publicApiErrorMessage).
 */
function multipartTimeoutResponse(c: Context): Response {
  const { details } = multipartTooLarge(0);
  c.header("Connection", "close");
  return apiErrorResponse(c, 408, "invalid_request",
    "The upload did not arrive in time. Upload large files or slow connections with a direct upload session: POST /v1/uploads/direct/sessions.",
    { directUpload: details.directUpload });
}

export function listSupportedUploadMimeTypes(): string[] {
  return [...SUPPORTED_UPLOAD_MIME_TYPES];
}
