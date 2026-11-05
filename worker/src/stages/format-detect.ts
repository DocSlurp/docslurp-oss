import type { Document } from "../models.js";
import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import type { ArtifactStore } from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { detectFileFormat, type NormalizedFormat } from "@docslurp/shared";

/**
 * The format intake persisted from the sniffed bytes (documents.file_facts) when there is one; otherwise the stored MIME type
 * and extension, for documents ingested before intake sniffed.
 */
function detectFormat(document: Document): { format: NormalizedFormat; detectedBy: "intake-file-facts" | "mime-and-extension" } {
  const persisted = document.fileFacts?.format;
  if (persisted && persisted !== "unknown") return { format: persisted, detectedBy: "intake-file-facts" };
  return { format: detectFileFormat({ filename: document.filename, mimeType: document.mimeType }), detectedBy: "mime-and-extension" };
}

export class FormatDetectStage implements Stage {
  readonly name = "format-detect";

  constructor(private readonly storage: ArtifactStore) {}

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    for (const document of healthyDocuments(state)) {
      const key = `${runArtifactRoot(state.run, document.userId)}/format-detect/${document.id}.json`;
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

          const { format: normalizedFormat, detectedBy } = detectFormat(document);

          await this.storage.putJson(key, {
            documentId: document.id,
            filename: document.filename,
            declaredMimeType: document.mimeType,
            normalizedFormat,
            detectedBy,
            fileFacts: document.fileFacts ?? null,
          });

          state.artifactLedger.recordDocument(document.id, "normalizedFormat", normalizedFormat);

          return {
            artifactUri: this.storage.uri(key),
            stats: {
              normalizedFormat,
              detectedBy,
              mimeVerdict: document.fileFacts?.mismatch ?? null,
            },
          };
        },
        signal
      );
    }
  }
}
