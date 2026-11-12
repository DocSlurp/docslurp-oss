import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Config } from "../config.js";
import type { Stage } from "../pipeline/pipeline.js";
import { buildQuarantineStats, scanDocumentForQuarantine, assertAcceptedQuarantine, inspectQuarantine, quarantineTelemetryLine, verifyIntakeFileFacts } from "../lib/quarantine.js";
import { runDocumentStage, runDocuments, } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import {
  type ArtifactStore,
  buildArtifactStorageKey,
  cleanupTempFile,
  sourceStorageKey
} from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { quarantineScanSnapshotEnabled, type CommandRunner } from "../tools/runner.js";
import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import { sha256Bytes, verifyStagedSource } from "../sandbox/source-integrity.js";
import { applyParseSource, hasScannedParseCopy, originalSourceForQuarantine } from "../lib/parse-source.js";

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
    // Snapshot flag on: each document's checks run in their own scanner session, whose VMs are restored from the clean
    // snapshot and terminated when the document's checks finish. No VM ever serves a second document (council M1): a
    // document that compromised the daemon could otherwise answer for every later one. Off: the stage runs as before.
    const snapshot = quarantineScanSnapshotEnabled();
    const perDocument = <T>(fn: () => Promise<T>): Promise<T> => snapshot ? this.runner.withMalwareScanner(state.run.orgId, fn) : fn();
    await runDocuments(documents, state.docConcurrency, async (document) => {
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
            // Quarantine alone reads the upload itself (a retried run may already point the document at its scanned copy).
            const original = originalSourceForQuarantine(document);
            const tempFile = await this.storage.downloadSourceToTempFile(
              sourceStorageKey(original.sourceKey),
              trustedTempDownloadPattern("docslurp-quarantine-", document),
              {
                maxBytes: Math.max(
                  this.config.quarantineMaxSingleEntryBytes,
                  this.config.quarantineMaxTotalUncompressedBytes
                )
              }
            );

            const copyDir = await mkdtemp(path.join(tmpdir(), "docslurp-quarantine-copy-"));
            try {
              const bytes = await readFile(tempFile);
              // The scanned bytes must be the bytes the server hashed.
              verifyStagedSource(original, sha256Bytes(bytes));
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
                signal,
                scannedCopyDir: copyDir
              });

              // Scan what we parse (council round 6, R6-H1): an accepted encrypted PDF is parsed from the copy its scan read,
              // never the original, so no reader can resolve the file into content the scan did not see (lib/parse-source.ts).
              const copyPath = artifact.pdfDecryption?.copyPath;
              if (artifact.pdfDecryption) delete artifact.pdfDecryption.copyPath;
              let parseCopy: { key: string; sha256: string } | null = null;
              if (artifact.decision === "accepted" && artifact.pdfDecryption?.status === "decrypted") {
                if (!copyPath) throw new Error("encrypted PDF accepted without its scanned copy");
                const stored = performance.now();
                const copy = await readFile(copyPath);
                const copyKey = buildArtifactStorageKey(...runArtifactRoot(state.run, document.userId).split("/"), "quarantine", `${document.id}.scanned.pdf`);
                parseCopy = { key: copyKey, sha256: sha256Bytes(copy) };
                await this.storage.putBytes(copyKey, copy, "application/pdf");
                artifact.pdfDecryption.parseSource = { uri: this.storage.uri(copyKey), sha256: parseCopy.sha256, storeMs: Math.round(performance.now() - stored) };
              }
              if (parseCopy || hasScannedParseCopy(document)) {
                // Recorded before the verdict is: no later stage of this or another attempt may see the document without it.
                if (!state.store?.setDocumentParseSource) throw new Error("scanned parse copy cannot be recorded: the store cannot persist it");
                if (!(await state.store.setDocumentParseSource(state.run.id, document.id, parseCopy))) throw new Error(`scanned parse copy of document ${document.id} was not recorded`);
                applyParseSource(document, parseCopy);
              }

              await this.storage.putArtifactJson(key, artifact);
              const artifactUri = this.storage.uri(key);
              if (verified && !verified.refused) {
                // Persist what the bytes are over the API's provisional record; format-detect and routing read it.
                if (!state.store?.setDocumentFileFacts) throw new Error("file facts verified but the store cannot persist them");
                await state.store.setDocumentFileFacts(state.run.id, document.id, verified.facts);
                document.fileFacts = verified.facts;
                document.mimeType = verified.facts.mimeType;
              }
              const telemetry = quarantineTelemetryLine(artifact);
              if (telemetry) console.warn(telemetry);
              assertAcceptedQuarantine(artifact, artifactUri);

              return {
                artifactUri,
                stats: buildQuarantineStats(artifact)
              };
            } finally {
              await cleanupTempFile(tempFile);
              await rm(copyDir, { recursive: true, force: true });
            }
          });
        },
        signal
      );
    });
  }
}
