import type { Document } from "../models.js";
import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import type { ArtifactStore } from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { detectFileFormat, type NormalizedFormat } from "@docslurp/shared";

function detectFormat(document: Document): NormalizedFormat {
  return detectFileFormat({ filename: document.filename, mimeType: document.mimeType });
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
