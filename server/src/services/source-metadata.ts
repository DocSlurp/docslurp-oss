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

      reject(
        new Error(
          `pdfinfo exited with ${code ?? "unknown"}: ${stderr || stdout}`.trim(),
        ),
      );
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
      const output = await runPdfInfo(tempFile);
      const pageCount = parsePdfInfoPageCount(output);
      if (pageCount === null) throw new Error("PDF page count unavailable; refusing to ingest an incomplete document");
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
