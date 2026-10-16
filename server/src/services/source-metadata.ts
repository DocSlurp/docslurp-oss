import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { env as apiEnv } from "../config.js";
import { sanitizeUploadFilename } from "../lib/filenames.js";
import { s3ClientConfig } from "@docslurp/shared";

export type SourceMetadata = {
  pageCount: number;
  sourceSha256: string;
};

/** The uploaded file cannot be read as the format it claims (corrupt, truncated or password-protected). A client error, not a server fault. */
export class UnreadableSourceError extends Error {
  readonly code = "unreadable_source";
  readonly statusCode = 422;
  constructor(readonly filename: string, readonly detail: string) {
    super(`${filename} could not be read as a PDF: ${detail}`);
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

/**
 * pdfinfo exit codes for a file it could not open (1) or decrypt (3). A null code means the process was
 * killed (our 30 s timeout or a crash on a malformed file), which is also this file's fault. Only a failure
 * to start pdfinfo at all (spawn error) is ours.
 */
const PDFINFO_UNREADABLE_EXIT_CODES = new Set<number | null>([1, 3, null]);

class PdfInfoExitError extends Error {
  constructor(readonly exitCode: number | null, detail: string) {
    super(`pdfinfo exited with ${exitCode ?? "unknown"}: ${detail}`.trim());
  }
}

const pageCountS3Client = new S3Client(s3ClientConfig(apiEnv.storage));

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parsePdfInfoPageCount(output: string): number | null {
  const match = output.match(/^Pages:\s+(\d+)/im);
  if (!match) {
    return null;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function estimateNonPdfPageCount(
  contentType: string,
  bytes: Uint8Array,
): number {
  if (bytes.length === 0) {
    return 1;
  }

  const textTypes = [
    "text/",
    "application/json",
    "application/x-ndjson",
    "application/xml",
    "application/javascript",
    "application/x-yaml",
  ];
  const shouldEstimateFromText = textTypes.some((prefix) =>
    contentType.startsWith(prefix),
  );

  if (!shouldEstimateFromText) {
    return 1;
  }

  const text = Buffer.from(bytes).toString("utf8");
  const lines = text.split(/\r?\n/).length;
  const chars = text.trim().length;
  const estimatedByLines = Math.ceil(lines / 60);
  const estimatedByChars = Math.ceil(chars / 3_500);
  return Math.max(1, estimatedByLines, estimatedByChars);
}

async function runPdfInfo(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("pdfinfo", [filePath], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      killSignal: "SIGKILL",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new PdfInfoExitError(code, stderr || stdout));
    });
  });
}

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
  if (file.mimeType === "application/pdf") {
    const directory = await mkdtemp(path.join(tmpdir(), "docslurp-pagecount-"));
    const tempFile = path.join(
      directory,
      sanitizeUploadFilename(file.filename, "document.pdf"),
    );

    try {
      await writeFile(tempFile, bytes);
      let output: string;
      try {
        output = await runPdfInfo(tempFile);
      } catch (error) {
        if (error instanceof PdfInfoExitError && PDFINFO_UNREADABLE_EXIT_CODES.has(error.exitCode)) {
          throw new UnreadableSourceError(file.filename, (error.message.replace(/^pdfinfo exited with (?:\d+|unknown):\s*/, "").split("\n")[0] || "invalid PDF").slice(0, 200));
        }
        throw error;
      }
      const pageCount = parsePdfInfoPageCount(output);
      if (pageCount === null) throw new UnreadableSourceError(file.filename, "page count unavailable; refusing to ingest an incomplete document");
      return { pageCount, sourceSha256 };
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  return {
    pageCount: estimateNonPdfPageCount(file.mimeType, bytes),
    sourceSha256,
  };
}
