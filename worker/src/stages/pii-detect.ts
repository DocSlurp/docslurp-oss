import { instrumentPostgres } from "@docslurp/shared/observability";
import { dbTraceStatementHook } from "../lib/db-trace.js";
import { isUtf8 } from "node:buffer";

import postgres from "postgres";

import type { Config } from "../config.js";
import type { Document } from "../models.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import { runDocumentStage, runDocuments, } from "../pipeline/checkpoints.js";
import { healthyDocuments } from "../pipeline/document-health.js";
import { isPiiBlockedDocument } from "../pipeline/pii-gate.js";
import type { CommandRunner } from "../tools/runner.js";
import { type ArtifactStore, keyFromStorageUri } from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import {
  PII_BLOCKED_DOCUMENT_STATUS,
  type PiiMatch,
  type PiiPolicy,
  type PiiPatternType,
  piiPatternTypeSchema,
} from "@docslurp/shared";
import { createPiiTextScanner, redactCanonicalDocument, redactJsonText, type PiiTextScanner } from "../lib/pii-redaction.js";
import { measureOp, pushPerfMetric } from "../lib/perf-context.js";
import { extractTextForEmbedding } from "./embedding-runtime.js";
import { refreshSummaryEvidence } from "./summary-evidence-refresh.js";

export interface PiiDetectionArtifact {
  documentId: string;
  policy: PiiPolicy;
  matchCount: number;
  matches: Array<{
    patternType: string;
    matchedPrefix: string;
    pageNumber: number | null;
    byteOffset: number;
    length: number;
    source: PiiTextSource;
  }>;
  sourcesScanned: PiiTextSource[];
  action: string;
  blocked: boolean;
  reviewRequired: boolean;
  redacted: boolean;
  redactedArtifacts: string[];
}

/** Text the pipeline serves or indexes downstream of this stage. */
export type PiiTextSource = "canonical-document" | "markdown" | "html" | "extraction-contract" | "source-text";

/** Database writes the stage makes; injectable so tests can run it against PGlite. */
export interface PiiDetectionSink {
  recordDetections(documentId: string, runId: string, matches: PiiMatch[], redacted: boolean): Promise<void>;
  setDocumentOutcome(documentId: string, outcome: PiiDocumentOutcome): Promise<void>;
  close(): Promise<void>;
}

export type PiiDocumentOutcome = {
  runId: string;
  action: PiiPolicy["action"];
  matchCount: number;
  patternTypes: string[];
  blocked: boolean;
  reviewRequired: boolean;
  redacted: boolean;
  reason: string | null;
  /**
   * Artifacts the API must refuse to serve for this document: everything
   * written before this stage that it did not scan clean or redact (parser
   * candidates, raw vision output, page images, parser JSON, the source file).
   */
  withheldArtifactUris: string[];
};

export function resolvePolicy(pipeline: WorkflowState["run"]["pipeline"]): PiiPolicy {
  const raw = pipeline.piiPolicy;
  return {
    enabled: raw.enabled,
    patterns: (raw.patterns ?? []).filter((p): p is PiiPatternType =>
      piiPatternTypeSchema.options.includes(p as PiiPatternType)
    ),
    action: raw.action as PiiPolicy["action"],
    allowlistPatterns: raw.allowlistPatterns ?? [],
  };
}

export function createPostgresPiiDetectionSink(databaseUrl: string): PiiDetectionSink {
  const db = instrumentPostgres(postgres(databaseUrl, {
    max: Math.max(1, Number.parseInt(process.env.WORKER_PII_DB_POOL_MAX ?? "2", 10) || 2),
    // Transaction-mode poolers (Neon pooler, PgBouncer) cannot route prepared statements.
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  }), databaseUrl, { onStatement: dbTraceStatementHook() });
  return {
    async recordDetections(documentId, runId, matches, redacted) {
      // A rescan of the same run replaces its detections instead of duplicating them.
      await db.begin(async (tx) => {
        const client = tx as unknown as typeof db;
        await client`delete from pii_detections where document_id = ${documentId} and run_id = ${runId}`;
        if (matches.length === 0) return;
        await client`
          insert into pii_detections ${client(
            matches.map((match) => ({
              document_id: documentId,
              run_id: runId,
              pattern_type: match.patternType,
              matched_prefix: match.matchedPrefix,
              page_number: match.pageNumber,
              byte_offset: match.byteOffset,
              redacted,
            })),
            "document_id",
            "run_id",
            "pattern_type",
            "matched_prefix",
            "page_number",
            "byte_offset",
            "redacted",
          )}
        `;
      });
    },
    async setDocumentOutcome(documentId, outcome) {
      const pii = outcome.matchCount > 0
        ? {
            action: outcome.action,
            runId: outcome.runId,
            matchCount: outcome.matchCount,
            patternTypes: outcome.patternTypes,
            blocked: outcome.blocked,
            reviewRequired: outcome.reviewRequired,
            redacted: outcome.redacted,
            reason: outcome.reason,
            withheldArtifactUris: outcome.withheldArtifactUris,
            detectedAt: new Date().toISOString(),
          }
        : null;
      if (outcome.blocked) {
        await db`
          update documents
          set status = ${PII_BLOCKED_DOCUMENT_STATUS},
              metadata = (coalesce(metadata, '{}'::jsonb) - 'piiBlocked') || jsonb_build_object('pii', ${db.json(pii)}::jsonb),
              updated_at = now()
          where id = ${documentId}
        `;
        return;
      }
      // Not blocked (or a rescan lifted an earlier block): record the outcome, keep the stage status.
      const metadata = pii
        ? db`(coalesce(metadata, '{}'::jsonb) - 'piiBlocked') || jsonb_build_object('pii', ${db.json(pii)}::jsonb)`
        : db`coalesce(metadata, '{}'::jsonb) - 'pii' - 'piiBlocked'`;
      await db`
        update documents
        set status = case when status = ${PII_BLOCKED_DOCUMENT_STATUS} then 'processing' else status end,
            metadata = ${metadata},
            updated_at = now()
        where id = ${documentId}
      `;
    },
    async close() {
      await db.end();
    },
  };
}

type TextArtifact = { slot: string; key: string; text: string; contentType: string };
type JsonArtifact = { slot: string; key: string; value: unknown };

export class PiiDetectStage implements Stage {
  readonly name = "pii-detect";

  private readonly sink: PiiDetectionSink;

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: ArtifactStore,
    private readonly config: Config,
    sink?: PiiDetectionSink,
  ) {
    this.sink = sink ?? createPostgresPiiDetectionSink(this.config.databaseUrl);
  }

  async run(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    const policy = resolvePolicy(state.run.pipeline);
    if (!policy.enabled || policy.patterns.length === 0) {
      return;
    }
    const scan = createPiiTextScanner(policy.patterns, policy.allowlistPatterns);

    await runDocuments(healthyDocuments(state), state.docConcurrency, async (document) => {
      const artifactSlot = `${document.id}:pii-detect`;
      const artifactKey = `${runArtifactRoot(state.run, document.userId)}/pii/${document.id}.json`;

      await runDocumentStage(
        state,
        document,
        this.name,
        artifactSlot,
        "pii detection completed",
        async () => {
          if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
          }
          return await this.scanDocument(state, document, policy, scan, artifactKey, signal);
        },
        signal
      );

      // Keep the in-memory status aligned for any stage that runs in this process.
      if (isPiiBlockedDocument(state, document)) {
        document.status = PII_BLOCKED_DOCUMENT_STATUS;
      }
    });
  }

  private async scanDocument(
    state: WorkflowState,
    document: Document,
    policy: PiiPolicy,
    scan: PiiTextScanner,
    artifactKey: string,
    signal?: AbortSignal,
  ) {
    const ledger = state.artifactLedger;
    const markdown = await this.readTextArtifact("markdown", ledger.readDocument(document.id, "markdown"), "text/markdown");
    const html = await this.readTextArtifact("html", ledger.read(`${document.id}:html`), "text/html; charset=utf-8", ".html");
    const canonical = await this.readJsonArtifact("canonical-document", ledger.readDocument(document.id, "canonical-document"));
    const contract = await this.readJsonArtifact("extraction-contract", ledger.readDocument(document.id, "extraction-contract"));

    // With no extracted markdown or canonical document, embed falls back to the
    // source text; scan exactly that so nothing reaches the index unscanned.
    const fallbackText = !markdown && !canonical
      ? await extractTextForEmbedding(document, this.runner, this.storage, undefined, signal, undefined)
          .then((result) => result.text)
          .catch(() => "")
      : "";

    const sourcesScanned: PiiTextSource[] = [];
    const findings = await measureOp(
      "pii-scan-latency",
      async () => {
        const canonicalResult = canonical
          ? redactCanonicalDocument(canonical.value as { blocks?: unknown }, scan)
          : null;
        const markdownResult = markdown ? scan(markdown.text) : null;
        const htmlResult = html ? scan(html.text) : null;
        const contractResult = contract ? redactJsonText(contract.value, scan) : null;
        const fallbackResult = fallbackText ? scan(fallbackText) : null;
        if (canonicalResult) sourcesScanned.push("canonical-document");
        if (markdownResult) sourcesScanned.push("markdown");
        if (htmlResult) sourcesScanned.push("html");
        if (contractResult) sourcesScanned.push("extraction-contract");
        if (fallbackResult) sourcesScanned.push("source-text");
        return { canonicalResult, markdownResult, htmlResult, contractResult, fallbackResult };
      },
      { metadata: { documentId: document.id } }
    );
    const { canonicalResult, markdownResult, htmlResult, contractResult, fallbackResult } = findings;

    // Detections are reported once, from the most precise source: canonical
    // blocks carry page numbers; otherwise the markdown or source text.
    const tagged = (matches: PiiMatch[], source: PiiTextSource) => matches.map((match) => ({ ...match, source }));
    const primary = canonicalResult && (canonicalResult.matches.length > 0 || !markdownResult)
      ? tagged(canonicalResult.matches, "canonical-document")
      : markdownResult
        ? tagged(markdownResult.matches, "markdown")
        : fallbackResult
          ? tagged(fallbackResult.matches, "source-text")
          : [];
    // Any source with a hit triggers the policy, even if the primary had none
    // (e.g. a value only in a table cell or the HTML rendering).
    const secondaryCounts = [
      canonicalResult?.changed ? 1 : 0,
      markdownResult?.matches.length ?? 0,
      htmlResult?.matches.length ?? 0,
      contractResult?.matches.length ?? 0,
    ];
    const matchCount = primary.length > 0 ? primary.length : Math.max(...secondaryCounts);
    const anyMatch = matchCount > 0;

    pushPerfMetric({
      metric: "pii-match-count",
      value: matchCount,
      unit: "matches",
      metadata: { documentId: document.id, action: policy.action },
    });

    const blocked = policy.action === "block_indexing" && anyMatch;
    const redacted = policy.action === "redact_artifacts" && anyMatch;
    const reviewRequired = policy.action === "flag_for_review" && anyMatch;
    const patternTypes = [...new Set([
      ...primary.map((match) => match.patternType),
      ...(markdownResult?.matches ?? []).map((match) => match.patternType),
      ...(htmlResult?.matches ?? []).map((match) => match.patternType),
      ...(contractResult?.matches ?? []).map((match) => match.patternType),
    ])].sort();

    // Rewrite every artifact a later stage or the API reads, in place, so their
    // URIs (already recorded on the run) now resolve to redacted text.
    const redactedArtifacts: string[] = [];
    const servableUris = new Set<string>();
    for (const artifact of [markdown, html, canonical, contract]) {
      if (!artifact) continue;
      servableUris.add(this.storage.uri(artifact.key));
      const slotUri = artifact.slot === "html"
        ? ledger.read(`${document.id}:html`)
        : ledger.readDocument(document.id, artifact.slot);
      if (slotUri) servableUris.add(slotUri);
    }
    if (redacted) {
      if (canonical && canonicalResult?.changed) {
        await this.storage.putJson(canonical.key, canonicalResult.document);
        redactedArtifacts.push(canonical.slot);
      }
      if (markdown && markdownResult && markdownResult.matches.length > 0) {
        await this.storage.streamText(markdown.key, markdownResult.redacted, markdown.contentType);
        redactedArtifacts.push(markdown.slot);
      }
      if (html && htmlResult && htmlResult.matches.length > 0) {
        await this.storage.streamText(html.key, htmlResult.redacted, html.contentType);
        redactedArtifacts.push(html.slot);
      }
      if (contract && contractResult && contractResult.matches.length > 0) {
        await this.storage.putJson(contract.key, contractResult.value);
        redactedArtifacts.push(contract.slot);
      }
      if (fallbackResult && fallbackResult.matches.length > 0) {
        // Embed, summary and page index read the markdown slot before the source file.
        const key = `${runArtifactRoot(state.run, document.userId)}/pii/${document.id}.redacted.md`;
        await this.storage.streamText(key, fallbackResult.redacted, "text/markdown");
        ledger.recordDocument(document.id, "markdown", this.storage.uri(key));
        redactedArtifacts.push("markdown");
        servableUris.add(this.storage.uri(key));
      }
      // Summary evidence holds excerpts of the pre-redaction extraction. Rebuild
      // it from the redacted markdown now in the slot (or delete it when that
      // text is unreadable) so unredacted text never reaches the summary model
      // or survives in storage.
      const currentMarkdown = fallbackResult && fallbackResult.matches.length > 0
        ? fallbackResult.redacted
        : markdown
          ? (markdownResult && markdownResult.matches.length > 0 ? markdownResult.redacted : markdown.text)
          : null;
      const evidence = await refreshSummaryEvidence({
        storage: this.storage, ledger, document,
        text: currentMarkdown, sourceUri: ledger.readDocument(document.id, "markdown"),
      });
      if (evidence !== "absent") redactedArtifacts.push("summary-evidence");
    }

    // Under redact_artifacts the scanned sources are now clean (redacted or
    // matchless) and stay servable; under block_indexing nothing written
    // before this stage is served.
    const withheldArtifactUris = blocked || redacted
      ? this.withheldArtifactUris(state, document, redacted ? servableUris : new Set())
      : [];

    const reason = blocked
      ? `PII policy blocked indexing: ${matchCount} match${matchCount === 1 ? "" : "es"} (${patternTypes.join(", ")})`
      : null;

    await this.sink.recordDetections(document.id, state.run.id, primary, redacted);
    await this.sink.setDocumentOutcome(document.id, {
      runId: state.run.id,
      action: policy.action,
      matchCount: anyMatch ? matchCount : 0,
      patternTypes,
      blocked,
      reviewRequired,
      redacted,
      reason,
      withheldArtifactUris,
    });
    if (blocked) document.status = PII_BLOCKED_DOCUMENT_STATUS;

    const artifact: PiiDetectionArtifact = {
      documentId: document.id,
      policy,
      matchCount: anyMatch ? matchCount : 0,
      matches: primary.map((m) => ({
        patternType: m.patternType,
        matchedPrefix: m.matchedPrefix,
        pageNumber: m.pageNumber,
        byteOffset: m.byteOffset,
        length: m.length,
        source: m.source,
      })),
      sourcesScanned,
      action: policy.action,
      blocked,
      reviewRequired,
      redacted,
      redactedArtifacts,
    };

    await this.storage.putJson(artifactKey, artifact);

    return {
      artifactUri: this.storage.uri(artifactKey),
      stats: {
        matchCount: artifact.matchCount,
        patternTypes,
        sourcesScanned,
        blocked,
        reviewRequired,
        redacted,
        redactedArtifacts,
        withheldArtifactCount: withheldArtifactUris.length,
        ...(reason ? { reason } : {}),
      },
    };
  }

  /** Every artifact URI recorded for this document so far, minus the ones known to be clean. */
  private withheldArtifactUris(state: WorkflowState, document: Document, servable: Set<string>): string[] {
    const uris = new Set<string>();
    const prefix = `${document.id}:`;
    for (const [slot, uri] of Object.entries(state.artifactLedger.all())) {
      if (slot.startsWith(prefix) && slot !== `${prefix}pii-detect` && uri.includes("://")) uris.add(uri);
    }
    for (const stage of state.documentStages.get(document.id)?.values() ?? []) {
      if (stage.stageName !== this.name && stage.artifactUri) uris.add(stage.artifactUri);
    }
    uris.add(this.storage.uri(document.sourceKey));
    return [...uris].filter((uri) => !servable.has(uri)).sort();
  }

  private async readTextArtifact(
    slot: string,
    uri: string | undefined,
    contentType: string,
    requiredExtension?: string,
  ): Promise<TextArtifact | null> {
    if (!uri || (requiredExtension && !uri.endsWith(requiredExtension))) return null;
    let key = keyFromStorageUri(uri, this.storage.bucket);
    if (!key) return null;
    try {
      let bytes = await this.storage.getBytes(key);
      if (key.endsWith(".json")) {
        // A markdown manifest points at the text it selected.
        const manifest = JSON.parse(bytes.toString("utf8")) as { textArtifactUri?: string };
        const textKey = manifest.textArtifactUri ? keyFromStorageUri(manifest.textArtifactUri, this.storage.bucket) : null;
        if (!textKey) return null;
        key = textKey;
        bytes = await this.storage.getBytes(key);
      }
      if (!isUtf8(bytes)) return null;
      return { slot, key, text: bytes.toString("utf8"), contentType };
    } catch {
      return null;
    }
  }

  private async readJsonArtifact(slot: string, uri: string | undefined): Promise<JsonArtifact | null> {
    if (!uri) return null;
    const key = keyFromStorageUri(uri, this.storage.bucket);
    if (!key) return null;
    try {
      return { slot, key, value: await this.storage.getJson<unknown>(key) };
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.sink.close();
  }
}
