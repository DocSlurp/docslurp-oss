import { VM_PDF_MAX_SOURCE_BYTES } from "@docslurp/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { containsPdfEncryptName } from "../lib/quarantine-bytes.js";
import { vmOnlyParsing } from "../lib/vm-only-parsing.js";
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
import { sha256Bytes, sha256File, verifyQuarantineUpload } from "../sandbox/source-integrity.js";
import { chartExportActive, chartExportConfigOf, chartExportModelsActive } from "../chart-export/config.js";
import { chartExportFreeVmCap } from "../db/chart-export-free-vm-cap.js";
import { parserImageCapability } from "../sandbox/startup.js";
import { CHART_INLINE_SLOT, chartExportInlineEnabled, chartInlineSlotValue, inlineHasWork, type InlineChartRequest, type InlineCharts } from "../chart-export/inline.js";
import { INLINE_COMMAND_BUDGET_CAPABILITY } from "../chart-export/inline-guest.js";
import { chartExportVmUsageEvent, deterministicSourceKind } from "../chart-export/vm-extractor.js";
import { applyParseSource, clearParseSource, originalSourceForQuarantine } from "../lib/parse-source.js";
import { detectDocumentFormat } from "../lib/document-format.js";
import { hostCountsTextPages, hostTextPages, needsTextPageCount, pagesFromTextInspection, recordTextPages, TextEvidenceCounter, textEvidenceWanted, textPagesRequestFor } from "../lib/text-page-count.js";

/**
 * What the host takes from the upload while it hashes it, all by fixed per-byte comparisons (never a decoder or parser):
 * the sha256, the first 1 KiB (magic numbers), whether a PDF names /Encrypt, and the text byte facts that bound the
 * guest's text page count (lib/text-page-count.ts HostTextEvidence). Keeps the header and enough overlap for a slash,
 * seven escaped name bytes and a delimiter.
 */
export async function quarantineSourceEvidence(file: string, options: { countText?: (header: Uint8Array) => boolean } = {}) {
  const hash = createHash("sha256");
  // The text facts are counted only when `countText` says so from the first chunk's header (a provisional text-rule format,
  // or a header no binary magic number claims): a PDF or media file pays only for its hash.
  let text: TextEvidenceCounter | null | undefined;
  let bytes = Buffer.alloc(0);
  let tail: Buffer = Buffer.alloc(0);
  let encryptName = false;
  for await (const chunk of createReadStream(file)) {
    const data = chunk as Buffer;
    hash.update(data);
    if (text === undefined) text = !options.countText || options.countText(data.subarray(0, 1024)) ? new TextEvidenceCounter() : null;
    text?.update(data);
    if (bytes.length < 1024) bytes = Buffer.concat([bytes, data.subarray(0, 1024 - bytes.length)]);
    if (!encryptName && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
      const window = Buffer.concat([tail, data]);
      // Appending an ordinary name byte avoids treating the end of a chunk as a delimiter.
      encryptName = window.includes("/Encrypt") || containsPdfEncryptName(Buffer.concat([window, Buffer.from("x")]));
      tail = Buffer.from(window.subarray(-32));
    }
  }
  // An empty file has no chunk: its (empty) text facts are still counted.
  return { bytes, scannedSha256: hash.digest("hex"), encryptName: encryptName || containsPdfEncryptName(tail), text: text === null ? null : (text ?? new TextEvidenceCounter()).result() };
}

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
    const perDocument = <T>(fn: () => Promise<T>): Promise<T> => snapshot ? this.runner.withMalwareScanner(fn) : fn();
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
                  document.mimeType === "application/pdf" ? VM_PDF_MAX_SOURCE_BYTES : 0,
                  this.config.quarantineMaxSingleEntryBytes,
                  this.config.quarantineMaxTotalUncompressedBytes
                )
              }
            );

            const copyDir = await mkdtemp(path.join(tmpdir(), "docslurp-quarantine-copy-"));
            try {
              const provisional = detectDocumentFormat(document).format;
              const evidence = vmOnlyParsing()
                ? await quarantineSourceEvidence(tempFile, { countText: (header) => textEvidenceWanted(header, document.filename, provisional) })
                : undefined;
              const bytes = evidence?.bytes ?? await readFile(tempFile);
              // The scanned bytes must be the bytes the server hashed. Their hash is what the decision binds parsers of the
              // upload to (council R8-L1), so a swap after this scan is refused even for a row without a server hash.
              const scannedSha256 = evidence?.scannedSha256 ?? sha256Bytes(bytes);
              // The upload has no parse decision yet (this scan records it), so the parsers' decision gate, which refuses
              // an object without one in production, does not apply; the hash binding and the unreadable-key refusal do.
              verifyQuarantineUpload(original, scannedSha256);
              // The API only glanced at this file; this is the first full look, before any parser.
              // One inspection of the bytes (in the parser VM in production) serves the intake check and the scan.
              // Inline charts need an image whose guest charges them against this command's budget, and (free tier) a grant
              // from the org's free-VM cap. Either missing: no chart request; a counted refusal stands in for the answer.
              const wanted = inlineChartRequest(state.run.pipeline, document.mimeType, process.env);
              const inlineRefusal = wanted ? await inlineChartAdmission({ pipeline: state.run.pipeline, documentId: document.id, runId: state.run.id, orgId: state.run.orgId ?? null, budgets: state.store?.budgets }) : null;
              const charts = inlineRefusal ? null : wanted;
              // The text page count rides on the same inspection (DocSlurp/app issue 599): no second command, download or staging.
              // Under the VM-only floor the guest is asked only when this host cannot count the file itself (pure-ASCII plain
              // text it counts from its own byte facts) and has those facts to check the answer against.
              const textRequest = evidence && (evidence.text === null || hostCountsTextPages(evidence.text, provisional))
                ? null : textPagesRequestFor(document, provisional);
              const inspection = await inspectQuarantine({ bytes, filename: document.filename, tempFile, runner: this.runner, policy: this.config, ...(charts ? { charts } : {}), ...(signal ? { signal } : {}), ...(textRequest ? { text: textRequest, ...(evidence?.text ? { textEvidence: evidence.text } : {}) } : {}) });
              const verified = verifyIntakeFileFacts(document, inspection);
              const artifact = await scanDocumentForQuarantine({
                inspection,
                documentId: document.id,
                filename: document.filename,
                declaredMimeType: verified?.scanDeclaredMimeType ?? document.mimeType,
                bytes,
                hostEncryptName: evidence?.encryptName,
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
                const copyKey = buildArtifactStorageKey(...runArtifactRoot(state.run, document.userId).split("/"), "quarantine", `${document.id}.scanned.pdf`);
                parseCopy = { key: copyKey, sha256: await sha256File(copyPath) };
                await this.storage.streamToStorage(copyKey, createReadStream(copyPath), "application/pdf");
                artifact.pdfDecryption.parseSource = { uri: this.storage.uri(copyKey), sha256: parseCopy.sha256, storeMs: Math.round(performance.now() - stored) };
              }
              // Fail closed (council R7-H1): every accepted document gets this build's parse decision on its own row (its scanned
              // copy, or the upload it scanned) before the verdict is recorded, and a refused one loses any decision. Nothing
              // parses a document without one (lib/parse-source.ts).
              const accepted = artifact.decision === "accepted";
              const decision = { copy: parseCopy, scannedSha256 };
              if (state.store) {
                if (!(await state.store.records.setDocumentParseSource(state.run.id, document.id, accepted ? decision : null))) {
                  throw new Error(`parse decision of document ${document.id} was not recorded`);
                }
              } else if (parseCopy || (document.parseSourceDecision !== undefined && document.parseSourceDecision !== "unscanned-allowed")) {
                // A loaded document (or a copy to point at) needs the decision persisted: later activities reload it.
                throw new Error("parse decision cannot be recorded: the state has no store");
              }
              if (accepted) applyParseSource(document, decision);
              else clearParseSource(document);
              // Inline charts stay only on an accepted document whose verified type is still the kind they were read as.
              const verifiedMime = verified && !verified.refused ? verified.facts.mimeType : document.mimeType;
              const chartAnswer: InlineCharts | undefined = inlineRefusal ?? (charts ? inspection.charts : undefined);
              if (accepted && wanted && chartAnswer && deterministicSourceKind(verifiedMime) === wanted.kind) {
                artifact.chartInline = { ...chartAnswer, kind: wanted.kind };
                // The inline worker's time (start-up included) is parser-VM time spent on chart export: a cost-only event,
                // like the standalone guest's, attributed to the document. The quarantine command's own VM metering already
                // carries the provider cost, so it rolls up as included, never twice, and is never a customer charge.
                if (!inlineRefusal && chartAnswer.status !== "skipped") {
                  // `ms` is the guest's own measure (council r4 L3): attribution only; the event is cost-only, included, never
                  // billable, and the quarantine command's VM time is metered with the command itself.
                  state.usageLedger.enqueue(chartExportVmUsageEvent({ documentId: document.id, wallTimeMs: chartAnswer.ms, reason: "inline", inputs: 1, outcome: chartAnswer.status === "ok" ? "ok" : "refused", stage: "quarantine" }));
                }
                console.log(`[chart-export] inline document=${document.id} kind=${wanted.kind} status=${chartAnswer.status} ${chartAnswer.status === "ok" ? `visuals=${chartAnswer.result.visuals.length} deferred_svgs=${(chartAnswer.result.deferred ?? []).reduce((n, d) => n + d.count, 0)} overflow=${chartAnswer.result.overflow ?? 0} ms=${chartAnswer.ms}` : `reason=${chartAnswer.reason}`}`);
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
                if (!state.store) throw new Error("file facts verified but the state has no store to persist them");
                await state.store.records.setDocumentFileFacts(state.run.id, document.id, verified.facts);
                document.fileFacts = verified.facts;
                document.mimeType = verified.facts.mimeType;
              }
              const telemetry = quarantineTelemetryLine(artifact);
              if (telemetry) console.warn(telemetry);
              assertAcceptedQuarantine(artifact, artifactUri);

              // A text file intake only estimated (from its size): record the inspection's count now, on the verified type,
              // before any later stage uses it or anything bills. Persisted only: format-detect makes the spend decision (pauses an
              // unfunded run) on every attempt, so a resume never repeats this download, inspection and scan.
              const { format } = detectDocumentFormat(document);
              let textPages: { pages: number; estimate: number } | null = null;
              if (needsTextPageCount(document, format)) {
                if (hostCountsTextPages(evidence?.text, format)) {
                  // Pure-ASCII plain text: the host's own count by the shared rule; no guest answer is used, at any size.
                  textPages = await recordTextPages(state, document, hostTextPages(evidence!.text!), evidence!.text!.bytes, "quarantine");
                } else if (textRequest) {
                  // An inspection without the answer (an image older than this worker) is retried, never decoded on the host.
                  const pages = pagesFromTextInspection(inspection.text, format);
                  // Not measured here (HTML only recognised after this inspection, a file over the measuring limit):
                  // format-detect measures or refuses it.
                  if (pages !== null) textPages = await recordTextPages(state, document, pages, inspection.text!.bytes, "quarantine");
                }
              }

              return {
                artifactUri,
                stats: { ...buildQuarantineStats(artifact), ...(textPages ? { textPages: textPages.pages, textPagesEstimate: textPages.estimate } : {}) }
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

const warned = new Set<string>();

/**
 * Whether a wanted inline chart request may go to the guest, or the counted refusal that stands in for its answer
 * (council #387): `image-unsupported` when the parser image's guest does not charge the step against the quarantine
 * command's budget (its contract lacks the capability); `free-vm-cap` when a free-tier document gets no grant from the
 * org's hourly free-VM cap (the same grant a standalone fallback of this document then reuses, so one document never
 * spends it twice). No store or no org: refused (fail closed). The billed `models` tier passes spend admission instead.
 * A refusal is recorded like any refused inline answer: a counted deferral, and no standalone VM run for the source.
 */
export async function inlineChartAdmission(args: {
  pipeline: unknown;
  documentId: string;
  runId: string;
  orgId: string | null;
  /** The fleet budgets of the run's store; none (an unbound state) refuses a free run (fail closed). */
  budgets: Pick<import("../db/fleet-budgets.js").FleetBudgets, "reserveChartExportFreeVmRun"> | undefined;
  env?: Readonly<Record<string, string | undefined>>;
  hasCapability?: (capability: string) => boolean | "present" | "missing" | "sandbox-not-ready";
}): Promise<InlineCharts | null> {
  const env = args.env ?? process.env;
  const raw = (args.hasCapability ?? parserImageCapability)(INLINE_COMMAND_BUDGET_CAPABILITY);
  const state = raw === true ? "present" : raw === false ? "missing" : raw;
  if (state !== "present") {
    // Each cause logged once per process, in its own words: an image that lacks the guest, or no sandbox known yet.
    if (!warned.has(state)) {
      console.warn(state === "sandbox-not-ready"
        ? "[chart-export] inline charts refused: parser sandbox not ready (none registered or initialized), so its capabilities are unknown"
        : `[chart-export] inline charts refused: the parser image does not report ${INLINE_COMMAND_BUDGET_CAPABILITY} (DOCSLURP_CHART_EXPORT_INLINE=1 needs an image with core #387's guest)`);
      warned.add(state);
    }
    return { status: "refused", reason: "image-unsupported", ms: 0 };
  }
  if (chartExportModelsActive(args.pipeline, env)) return null;
  const reserve = args.budgets?.reserveChartExportFreeVmRun.bind(args.budgets);
  let granted = false;
  if (reserve && args.orgId) {
    try {
      granted = await reserve({ orgId: args.orgId, runId: args.runId, documentId: args.documentId, perHour: chartExportFreeVmCap(env) });
    } catch (error) {
      console.warn(`[chart-export] inline free VM reservation failed document=${args.documentId} error=${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  if (granted) return null;
  console.log(`[chart-export] inline charts skipped document=${args.documentId} reason=org-free-vm-cap`);
  return { status: "refused", reason: "free-vm-cap", ms: 0 };
}

/**
 * The inline chart request for a document (DOCSLURP_CHART_EXPORT_INLINE=1): only while the run's chart export tier is
 * active and the document was declared a kind the free rungs read; null otherwise (the inspection runs as before).
 */
export function inlineChartRequest(pipeline: unknown, mimeType: string, env: Readonly<Record<string, string | undefined>> = process.env): InlineChartRequest | null {
  if (!chartExportInlineEnabled(env) || !chartExportActive(pipeline, env)) return null;
  const kind = deterministicSourceKind(mimeType);
  return kind ? { kind, diagrams: chartExportConfigOf(pipeline, env).diagrams !== false } : null;
}
