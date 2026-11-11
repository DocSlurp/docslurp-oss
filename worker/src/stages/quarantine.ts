import { readFile } from "node:fs/promises";

import type { Config } from "../config.js";
import type { Stage } from "../pipeline/pipeline.js";
import { buildQuarantineStats, scanDocumentForQuarantine, assertAcceptedQuarantine, inspectQuarantine, verifyIntakeFileFacts } from "../lib/quarantine.js";
import { runDocumentStage, runDocuments, } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import {
  type ArtifactStore,
  buildArtifactStorageKey,
  cleanupTempFile,
  sourceStorageKey
} from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { quarantineScanBatchEnabled, quarantineScanSnapshotEnabled, type CommandRunner } from "../tools/runner.js";
import { SandboxPolicyError } from "../sandbox/types.js";
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

    const documents = healthyDocuments(state);
    // Q2: one scanner session for the run's whole pass. Its VMs serve this run's organization only: a document of any
    // other run is refused before anything is staged, and the session refuses commands of another organization.
    const batch = quarantineScanBatchEnabled();
    if (batch) {
      const foreign = documents.find((document) => document.runId !== state.run.id);
      if (foreign) throw new SandboxPolicyError(`quarantine batch refused: document ${foreign.id} belongs to another run`);
    }
    // Q1 alone: one scanner session (one restored VM) per document, terminated when its checks finish.
    // Both flags off: the stage runs exactly as before.
    const snapshot = quarantineScanSnapshotEnabled();
    const perDocument = <T>(fn: () => Promise<T>): Promise<T> => snapshot && !batch ? this.runner.withMalwareScanner(state.run.orgId, fn) : fn();
    const pass = () => runDocuments(documents, state.docConcurrency, async (document) => {
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

          return await perDocument(async () => {
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
              // One inspection of the bytes (in the parser VM in production) serves the intake check and the scan.
              const inspection = await inspectQuarantine({ bytes, filename: document.filename, tempFile, runner: this.runner, policy: this.config, ...(signal ? { signal } : {}) });
              const verified = verifyIntakeFileFacts(document, inspection);
              const artifact = await scanDocumentForQuarantine({
                inspection,
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
          });
        },
        signal
      );
    });
    await (batch ? this.runner.withMalwareScanner(state.run.orgId, pass) : pass());
  }
}
