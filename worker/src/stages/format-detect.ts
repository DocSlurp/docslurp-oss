import type { Document } from "../models.js";
import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import type { ArtifactStore } from "../tools/storage.js";

type NormalizedFormat =
  | "pdf"
  | "markdown"
  | "plain-text"
  | "html"
  | "office-word"
  | "office-excel"
  | "office-pptx"
  | "office-other"
  | "structured-csv"
  | "structured-json"
  | "epub"
  | "latex"
  | "image"
  | "audio"
  | "video"
  | "unknown";

const mimeMap: Record<string, NormalizedFormat> = {
  "audio/mpeg": "audio", "audio/mp3": "audio", "audio/wav": "audio", "audio/x-wav": "audio",
  "audio/flac": "audio", "audio/ogg": "audio", "audio/mp4": "audio", "audio/webm": "audio",
  "video/mp4": "video", "video/webm": "video", "video/quicktime": "video", "video/x-matroska": "video",
  "application/pdf": "pdf",
  "text/markdown": "markdown",
  "text/plain": "plain-text",
  "text/html": "html",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "office-word",
  "application/rtf": "office-other",
  "text/csv": "structured-csv",
  "application/json": "structured-json",
  "application/x-ndjson": "structured-json",
  "application/epub+zip": "epub",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "office-pptx",
  "application/vnd.ms-powerpoint": "office-pptx",
  "application/x-latex": "latex",
  "text/x-tex": "latex",
  "image/png": "image",
  "image/jpeg": "image",
  "image/tiff": "image",
  "image/webp": "image",
};

const extMap: Record<string, NormalizedFormat> = {
  ".mp3": "audio", ".wav": "audio", ".flac": "audio", ".ogg": "audio", ".opus": "audio", ".m4a": "audio", ".aac": "audio",
  ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video", ".avi": "video",
  ".pdf": "pdf",
  ".md": "markdown",
  ".txt": "plain-text",
  ".html": "html",
  ".htm": "html",
  ".mhtml": "html",
  ".docx": "office-word",
  ".doc": "office-word",
  ".xlsx": "office-excel",
  ".xls": "office-excel",
  ".pptx": "office-pptx",
  ".ppt": "office-pptx",
  ".odt": "office-other",
  ".rtf": "office-other",
  ".csv": "structured-csv",
  ".tsv": "structured-csv",
  ".json": "structured-json",
  ".jsonl": "structured-json",
  ".epub": "epub",
  ".tex": "latex",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".tiff": "image",
  ".tif": "image",
  ".webp": "image",
};

function detectFormat(document: Document): NormalizedFormat {
  const mime = document.mimeType?.toLowerCase() ?? "";
  if (mimeMap[mime]) {
    return mimeMap[mime];
  }

  const filename = document.filename ?? "";
  const dot = filename.lastIndexOf(".");
  if (dot >= 0) {
    const ext = filename.slice(dot).toLowerCase();
    if (extMap[ext]) {
      return extMap[ext];
    }
  }

  return "unknown";
}

export class FormatDetectStage implements Stage {
  readonly name = "format-detect";

  constructor(private readonly storage: ArtifactStore) {}

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    for (const document of healthyDocuments(state)) {
      const key = `${document.userId}/${state.run.id}/format-detect/${document.id}.json`;
      const artifactSlot = `${document.id}:format-detect`;

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "format detected",
        async () => {
          if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
          }

          const normalizedFormat = detectFormat(document);

          await this.storage.putJson(key, {
            documentId: document.id,
            filename: document.filename,
            declaredMimeType: document.mimeType,
            normalizedFormat,
            detectedBy: "mime-and-extension",
          });

          state.artifactLedger.recordDocument(document.id, "normalizedFormat", normalizedFormat);

          return {
            artifactUri: this.storage.uri(key),
            stats: {
              normalizedFormat,
              detectedBy: "mime-and-extension",
            },
          };
        },
        signal
      );
    }
  }
}
