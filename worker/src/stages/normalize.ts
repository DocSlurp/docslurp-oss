import type { Stage } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments, } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import type { CommandRunner } from "../tools/runner.js";

export class NormalizeStage implements Stage {
  readonly name = "normalize";

  constructor(private readonly runner: CommandRunner) {}

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    await runDocuments(healthyDocuments(state), state.docConcurrency, async (document) => {
      const artifactSlot = `${document.id}:normalize`;
      const normalizedFormat = state.artifactLedger.readDocument(document.id, "normalizedFormat");

      if (normalizedFormat !== undefined && normalizedFormat !== "pdf") {
        await runDocumentStage(
          state,
          document,
          this.name,
          artifactSlot,
          "skipped (non-pdf)",
          async () => {
            return {
              artifactUri: "",
              stats: {
                skipped: true,
                normalizedFormat,
              },
            };
          },
          signal
        );
        return;
      }

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "normalized source document",
        async () => {
          const artifactUri = await this.runner.summary(await this.runner.pdfInfo(document.sourceKey));
          return {
            artifactUri,
            stats: {
              sourceKey: document.sourceKey
            }
          };
        },
        signal
      );
    });
  }
}
