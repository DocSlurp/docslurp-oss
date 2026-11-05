import { instrumentS3Client } from "@docslurp/shared/observability";
import { createHash } from "node:crypto";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { env as apiEnv } from "../config.js";
import {
  decodeTextBytes,
  estimatedPdfPages,
  fileFactsFor,
  s3ClientConfig,
  TEXT_PAGE_MIME_PREFIXES,
  textPageCount,
  type FileEncoding,
  type IntakePageEvidence,
  type FileFacts,
} from "@docslurp/shared";

export type SourceMetadata = {
  pageCount: number;
  sourceSha256: string;
  /** What the bytes are, sniffed once here; the document is stored (and routed and billed) under `fileFacts.mimeType`. */
  fileFacts: FileFacts;
  /** How `pageCount` was obtained; intakePageCountSource turns it into documents.page_count_source. */
  pageEvidence: IntakePageEvidence;
};

/** The uploaded file cannot be read as the format it claims (corrupt, truncated or password-protected). A client error, not a server fault. */
export class UnreadableSourceError extends Error {
  readonly code = "unreadable_source";
  readonly statusCode = 422;
  constructor(readonly filename: string, readonly detail: string, what = "a PDF") {
    super(`${filename} could not be read as ${what}: ${detail}`);
    this.name = "UnreadableSourceError";
  }
}

/** Every file of a request that skips unreadable files was unreadable; carries each one. */
export class AllSourcesUnreadableError extends UnreadableSourceError {
  constructor(readonly errors: readonly UnreadableSourceError[]) {
    super(errors[0]!.filename, errors[0]!.detail);
    if (errors.length > 1) this.message = `None of the ${errors.length} files could be read: ${errors.map((error) => error.filename).join(", ")}`;
    this.name = "AllSourcesUnreadableError";
  }
}

const pageCountS3Client = instrumentS3Client(new S3Client(s3ClientConfig(apiEnv.storage)), apiEnv.storage.endpoint);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function estimateNonPdfPageCount(
  contentType: string,
  bytes: Uint8Array,
  encoding?: FileEncoding | null,
): number {
  return nonPdfPageCount(contentType, bytes, encoding).pageCount;
}

/** Single-frame raster formats whose magic bytes make the file one page (a TIFF's frames are counted by the OCR boundary). */
const SINGLE_FRAME_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);

/**
 * Intake's page count of a non-PDF file and the evidence behind it. Only the text rule over the whole text, or an image format
 * the magic bytes confirm, is counted evidence; a declared type alone never is.
 */
export function nonPdfPageCount(
  contentType: string,
  bytes: Uint8Array,
  encoding?: FileEncoding | null,
  sniffedMimeType?: string | null,
): { pageCount: number; pageEvidence: IntakePageEvidence } {
  if (bytes.length === 0) return { pageCount: 1, pageEvidence: "none" };

  // The quote rules (isUploadTextFile, quoteFilePages) and the offline estimator count text pages the same way.
  if (!TEXT_PAGE_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
    const image = sniffedMimeType != null && sniffedMimeType === contentType && SINGLE_FRAME_IMAGE_TYPES.has(sniffedMimeType);
    return { pageCount: 1, pageEvidence: image ? "image-header" : "none" };
  }

  // Decoded by the file's own encoding (a UTF-16 CSV is not UTF-8), with HTML markup removed. Only the first
  // TEXT_MEASURE_SAMPLE_BYTES are decoded and the count is scaled by the file's size, so a large or hostile file costs
  // the API a bounded amount of work; that scaled count is an estimate.
  const markup = contentType.startsWith("text/html");
  if (bytes.length <= TEXT_MEASURE_SAMPLE_BYTES) {
    return { pageCount: textPageCount(decodeTextBytes(bytes, encoding), { markup }), pageEvidence: "text-rule" };
  }
  const sampled = textPageCount(decodeTextBytes(bytes.subarray(0, TEXT_MEASURE_SAMPLE_BYTES), encoding), { markup });
  return { pageCount: Math.max(1, Math.ceil(sampled * (bytes.length / TEXT_MEASURE_SAMPLE_BYTES))), pageEvidence: "text-sample" };
}

/** Bytes of a text file the API decodes to count its pages. */
const TEXT_MEASURE_SAMPLE_BYTES = 2_000_000;

async function downloadSourceBytes(sourceKey: string): Promise<Uint8Array> {
  const response = await pageCountS3Client.send(
    new GetObjectCommand({
      Bucket: apiEnv.s3Bucket,
      Key: sourceKey,
    }),
  );

  const bytes = await response.Body?.transformToByteArray();
  return bytes ?? new Uint8Array();
}

export async function resolveSourceMetadata(file: {
  mimeType: string;
  sourceKey: string;
  filename: string;
}): Promise<SourceMetadata> {
  const bytes = await downloadSourceBytes(file.sourceKey);
  const sourceSha256 = sha256Hex(bytes);
  // Header depth: magic bytes in the first few KB plus the declared type. ZIP and OLE containers are not opened and text is
  // not classified here; the worker's quarantine stage inspects them before any parser and persists the full facts.
  const fileFacts = fileFactsFor(bytes, { filename: file.filename, declaredMimeType: file.mimeType }, { depth: "header" });
  // A declaration the magic bytes contradict (text declared as a PDF, a PNG declared as a DOCX) is refused for this file
  // alone (partial ingest) instead of reaching a parser that would trust the label.
  if (fileFacts.mismatch === "unresolved") {
    throw new UnreadableSourceError(
      file.filename,
      `contents are ${fileFacts.sniffedMimeType ?? "unrecognized"}, not the declared ${fileFacts.declaredMimeType ?? file.mimeType}`,
      "the declared type",
    );
  }
  const mimeType = fileFacts.mimeType;
  if (mimeType === "application/pdf") {
    // The API never parses customer PDF bytes (no pdfinfo or other native parser in this process): the page count is an
    // estimate from the size, stored as `assumed` (shown as `estimated`). The worker measures the real count in its boundary
    // before any stage uses it or anything bills; an unreadable PDF fails there.
    return { pageCount: estimatedPdfPages(bytes.length), pageEvidence: "size-estimate", sourceSha256, fileFacts };
  }

  return { ...nonPdfPageCount(mimeType, bytes, fileFacts.encoding, fileFacts.sniffedMimeType), sourceSha256, fileFacts };
}
