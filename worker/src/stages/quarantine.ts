import { readFile } from "node:fs/promises";

import type { Config } from "../config.js";
import type { Stage } from "../pipeline/pipeline.js";
import { buildQuarantineStats, scanDocumentForQuarantine, assertAcceptedQuarantine, verifyIntakeFileFacts } from "../lib/quarantine.js";
import { runDocumentStage, runDocuments, } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import {
  type ArtifactStore,
  buildArtifactStorageKey,
  cleanupTempFile,
  sourceStorageKey
} from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import type { CommandRunner } from "../tools/runner.js";
import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import { sha256Bytes, verifyStagedSource } from "../sandbox/source-integrity.js";

export class QuarantineStage implements Stage {
  readonly name = "quarantine";

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore,
    private readonly config: Config
  ) {}

  async run(state: import("../pipeline/pipeline.js").WorkflowState, signal?: AbortSignal): Promise<void> {
    if (!this.config.quarantineEnabled) {
      return;
    }

    await runDocuments(healthyDocuments(state), state.docConcurrency, async (document) => {
      const key = buildArtifactStorageKey(...runArtifactRoot(state.run, document.userId).split("/"), "quarantine", `${document.id}.json`);
      const artifactSlot = `${document.id}:quarantine`;

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "document quarantine checks completed",
        async () => {
          if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
          }

          const tempFile = await this.storage.downloadSourceToTempFile(
            sourceStorageKey(document.sourceKey),
            trustedTempDownloadPattern("docslurp-quarantine-", document),
            {
              maxBytes: Math.max(
                this.config.quarantineMaxSingleEntryBytes,
                this.config.quarantineMaxTotalUncompressedBytes
              )
            }
          );

          try {
            const bytes = await readFile(tempFile);
            // The scanned (and later parsed) bytes must be the bytes the server hashed.
            verifyStagedSource(document, sha256Bytes(bytes));
            // The API only glanced at this file; this is the first full look, before any parser.
            const verified = verifyIntakeFileFacts(document, bytes);
            const artifact = await scanDocumentForQuarantine({
              documentId: document.id,
              filename: document.filename,
              declaredMimeType: verified?.scanDeclaredMimeType ?? document.mimeType,
              bytes,
              tempFile,
              runner: this.runner,
              policy: this.config,
              signal
            });

            await this.storage.putArtifactJson(key, artifact);
            const artifactUri = this.storage.uri(key);
            if (verified && !verified.refused) {
              // Persist what the bytes are over the API's provisional record; format-detect and routing read it.
              if (!state.store?.setDocumentFileFacts) throw new Error("file facts verified but the store cannot persist them");
              await state.store.setDocumentFileFacts(state.run.id, document.id, verified.facts);
              document.fileFacts = verified.facts;
              document.mimeType = verified.facts.mimeType;
            }
            assertAcceptedQuarantine(artifact, artifactUri);

            return {
              artifactUri,
              stats: buildQuarantineStats(artifact)
            };
          } finally {
            await cleanupTempFile(tempFile);
          }
        },
        signal
      );
    });
  }
}
