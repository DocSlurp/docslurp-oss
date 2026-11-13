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
import { chartExportActive, chartExportConfigOf } from "../chart-export/config.js";
import { CHART_INLINE_SLOT, chartExportInlineEnabled, chartInlineSlotValue, inlineHasWork, inlinePages, type InlineChartRequest } from "../chart-export/inline.js";
import { chartExportVmUsageEvent, deterministicSourceKind } from "../chart-export/vm-extractor.js";
import { applyParseSource, clearParseSource, originalSourceForQuarantine } from "../lib/parse-source.js";

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
              // The scanned bytes must be the bytes the server hashed. Their hash is what the decision binds parsers of the
              // upload to (council R8-L1), so a swap after this scan is refused even for a row without a server hash.
              const scannedSha256 = sha256Bytes(bytes);
              verifyStagedSource(original, scannedSha256);
              // The API only glanced at this file; this is the first full look, before any parser.
              // One inspection of the bytes (in the parser VM in production) serves the intake check and the scan.
              const charts = inlineChartRequest(state.run.pipeline, document.mimeType, process.env, document.pageCount);
              const inspection = await inspectQuarantine({ bytes, filename: document.filename, tempFile, runner: this.runner, policy: this.config, ...(charts ? { charts } : {}), ...(signal ? { signal } : {}) });
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
              // Fail closed (council R7-H1): every accepted document gets this build's parse decision on its own row (its scanned
              // copy, or the upload it scanned) before the verdict is recorded, and a refused one loses any decision. Nothing
              // parses a document without one (lib/parse-source.ts).
              const accepted = artifact.decision === "accepted";
              const decision = { copy: parseCopy, scannedSha256 };
              if (state.store?.setDocumentParseSource) {
                if (!(await state.store.setDocumentParseSource(state.run.id, document.id, accepted ? decision : null))) {
                  throw new Error(`parse decision of document ${document.id} was not recorded`);
                }
              } else if (parseCopy || (document.parseSourceDecision !== undefined && document.parseSourceDecision !== "unscanned-allowed")) {
                // A loaded document (or a copy to point at) needs the decision persisted: later activities reload it.
                throw new Error("parse decision cannot be recorded: the store cannot persist it");
              }
              if (accepted) applyParseSource(document, decision);
              else clearParseSource(document);
              // Inline charts stay only on an accepted document whose verified type is still the kind they were read as.
              const verifiedMime = verified && !verified.refused ? verified.facts.mimeType : document.mimeType;
              if (accepted && charts && inspection.charts && deterministicSourceKind(verifiedMime) === charts.kind) {
                artifact.chartInline = { ...inspection.charts, kind: charts.kind };
                // The inline worker's time (start-up included) is parser-VM time spent on chart export: a cost-only event,
                // like the standalone guest's, attributed to the document. The quarantine command's own VM metering already
                // carries the provider cost, so it rolls up as included, never twice, and is never a customer charge.
                if (inspection.charts.status !== "skipped") {
                  state.usageLedger.enqueue(chartExportVmUsageEvent({ documentId: document.id, wallTimeMs: inspection.charts.ms, reason: "inline", inputs: 1, outcome: inspection.charts.status === "ok" ? "ok" : "refused", stage: "quarantine" }));
                }
                console.log(`[chart-export] inline document=${document.id} kind=${charts.kind} status=${inspection.charts.status} ${inspection.charts.status === "ok" ? `visuals=${inspection.charts.result.visuals.length} ms=${inspection.charts.ms}` : `reason=${inspection.charts.reason}`}`);
              }

              await this.storage.putArtifactJson(key, artifact);
              const artifactUri = this.storage.uri(key);
              // A free signal later stages see without a read: the slot exists only when the inline answer has something
              // to export (or must go to the standalone guest). It points at this artifact; no other file is written.
              // The value says which: `#chart-inline=work` or `=none`. Quarantine re-runs in every run, so the slot is rewritten
              // each time and a stale "work" from an earlier run cannot survive (the ledger has no delete).
              if (artifact.chartInline) state.artifactLedger.recordDocument(document.id, CHART_INLINE_SLOT, chartInlineSlotValue(artifactUri, inlineHasWork(artifact.chartInline)));
              else if (state.artifactLedger.readDocument(document.id, CHART_INLINE_SLOT)) state.artifactLedger.recordDocument(document.id, CHART_INLINE_SLOT, chartInlineSlotValue(artifactUri, false));
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
        signal,
        // A document with no parse decision from this build re-runs quarantine over its completed checkpoint (one left by
        // an earlier build, or seeded by an older stored plan): it is never parsed on another scan's verdict.
        { rerunCompleted: document.parseSourceDecision === "unscanned" }
      );
    });
  }
}

/**
 * The inline chart request for a document (DOCSLURP_CHART_EXPORT_INLINE=1): only while the run's chart export tier is
 * active and the document was declared a kind the free rungs read; null otherwise (the inspection runs as before).
 */
export function inlineChartRequest(pipeline: unknown, mimeType: string, env: Readonly<Record<string, string | undefined>> = process.env, pageCount?: number): InlineChartRequest | null {
  if (!chartExportInlineEnabled(env) || !chartExportActive(pipeline, env)) return null;
  const kind = deterministicSourceKind(mimeType);
  return kind ? { kind, diagrams: chartExportConfigOf(pipeline, env).diagrams !== false, ...inlinePages(pageCount) } : null;
}
