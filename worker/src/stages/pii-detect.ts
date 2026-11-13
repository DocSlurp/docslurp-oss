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
import { createPiiTextScanner, isStructuralKey, redactCanonicalDocument, redactJsonText, type PiiTextScanner } from "../lib/pii-redaction.js";
import {
  applyPlanToCanonical,
  applyPlanToJson,
  applyPlanToText,
  locateMatches,
  perPageArtifactServable,
  planPiiWithholding,
  type CanonicalBlockLike,
} from "../lib/pii-page-withholding.js";
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
    /** UTF-8 byte offset within the scanned text (a canonical block's text, the markdown, ...), not the file. */
    byteOffset: number;
    /** UTF-16 code-unit index within the same scanned text. */
    charOffset: number;
    length: number;
    source: PiiTextSource;
  }>;
  sourcesScanned: PiiTextSource[];
  action: string;
  blocked: boolean;
  /** `pages`/`sections`: the document completes with these withheld; `document`: it is blocked. */
  withholding?: "none" | "pages" | "sections" | "document";
  withheldPages?: number[];
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
  /**
   * What is withheld (packages/shared/src/pii-withholding.ts): `pages` (the document completes; `withheldPages` are
   * replaced and refused), `sections` (unpaged), `document` (status pii_blocked) or `none`.
   */
  scope: "none" | "pages" | "sections" | "document";
  withheldPages: number[];
  withheldSectionCount: number;
  pageCount: number;
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

/** A scan could not look at text it was supposed to check. The stage fails; "no PII found" is not an answer. */
export class PiiScanIncompleteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PiiScanIncompleteError";
  }
}

export function resolvePolicy(pipeline: WorkflowState["run"]["pipeline"]): PiiPolicy {
  const raw = pipeline.piiPolicy;
  // A pattern this worker does not know (a newer API configured it) must stop the scan, not be dropped:
  // dropping it would index documents the project asked to have checked for it.
  const unknown = raw.enabled ? (raw.patterns ?? []).filter((p) => !piiPatternTypeSchema.options.includes(p as PiiPatternType)) : [];
  if (unknown.length > 0) {
    throw new PiiScanIncompleteError(`PII policy names patterns this worker cannot detect: ${unknown.join(", ")}`);
  }
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
      const pii = outcome.matchCount > 0 || outcome.scope !== "none"
        ? {
            scope: outcome.scope,
            ...(outcome.scope === "pages" ? { withheldPages: outcome.withheldPages, withheldPageCount: outcome.withheldPages.length } : {}),
            ...(outcome.scope === "sections" ? { withheldSectionCount: outcome.withheldSectionCount } : {}),
            pageCount: outcome.pageCount,
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
    let markdown: TextArtifact | null;
    let html: TextArtifact | null;
    let canonical: JsonArtifact | null;
    let contract: JsonArtifact | null;
    let fallbackText: string;
    try {
      markdown = await this.readTextArtifact("markdown", ledger.readDocument(document.id, "markdown"), "text/markdown");
      html = await this.readTextArtifact("html", ledger.read(`${document.id}:html`), "text/html; charset=utf-8", ".html");
      canonical = await this.readJsonArtifact("canonical-document", ledger.readDocument(document.id, "canonical-document"));
      contract = await this.readJsonArtifact("extraction-contract", ledger.readDocument(document.id, "extraction-contract"));

      // With no extracted markdown or canonical document, embed falls back to the
      // source text; scan exactly that so nothing reaches the index unscanned.
      // A failure to extract it is not "no text": it fails the stage.
      fallbackText = !markdown && !canonical
        ? await extractTextForEmbedding(document, this.runner, this.storage, undefined, signal, undefined)
            .then((result) => result.text)
            .catch((error: unknown) => {
              throw new PiiScanIncompleteError(`PII scan could not read the source text of ${document.id}`, { cause: error });
            })
        : "";
    } catch (error) {
      // Summary evidence was cut from the unscanned text; no later stage may use it.
      if (error instanceof PiiScanIncompleteError) {
        await refreshSummaryEvidence({
          storage: this.storage, ledger, document, text: null, sourceUri: ledger.readDocument(document.id, "markdown"),
        }).catch(() => undefined);
      }
      throw error;
    }

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

    const plan = planPiiWithholding(policy.action, {
      pageCount: document.pageCount,
      canonical: canonicalResult
        ? { matches: canonicalResult.matches, changedPages: canonicalResult.changedPages, blocks: canonicalBlocks(canonical?.value) }
        : null,
      markdown: markdown && markdownResult ? { text: markdown.text, matches: markdownResult.matches } : null,
      fallback: fallbackResult ? { text: fallbackText, matches: fallbackResult.matches } : null,
      html: htmlResult ? { matches: htmlResult.matches } : null,
      contract: contractResult ? { matches: contractResult.matches } : null,
    }, anyMatch);
    // Pages hit, for redaction and review: per-page artifacts of the other pages stay servable.
    const located = anyMatch && document.pageCount > 1
      ? locateMatches({
          pageCount: document.pageCount,
          canonical: canonicalResult ? { matches: canonicalResult.matches, changedPages: canonicalResult.changedPages, blocks: [] } : null,
          markdown: markdown && markdownResult ? { text: markdown.text, matches: markdownResult.matches } : null,
          fallback: fallbackResult ? { text: fallbackText, matches: fallbackResult.matches } : null,
          html: htmlResult ? { matches: htmlResult.matches } : null,
          contract: contractResult ? { matches: contractResult.matches } : null,
        })
      : null;

    const blocked = plan.scope === "document";
    const withholding = plan.scope === "pages" || plan.scope === "sections";
    const redacted = policy.action === "redact_artifacts" && anyMatch && !blocked;
    const reviewRequired = policy.action === "flag_for_review" && anyMatch;
    if (blocked && plan.reason.startsWith("unattributed")) {
      // Fail closed: a hit that cannot be placed on a page withholds the document.
      console.warn(`[pii] document-withheld document=${document.id} reason=${plan.reason}`);
    }
    const patternTypes = [...new Set([
      ...primary.map((match) => match.patternType),
      ...(markdownResult?.matches ?? []).map((match) => match.patternType),
      ...(htmlResult?.matches ?? []).map((match) => match.patternType),
      ...(contractResult?.matches ?? []).map((match) => match.patternType),
    ])].sort();

    // Rewrite every artifact a later stage or the API reads, in place, so their
    // URIs (already recorded on the run) now resolve to redacted (or withheld) text.
    const redactedArtifacts: string[] = [];
    const servableUris = new Set<string>();
    const rewrite = redacted || withholding;
    for (const artifact of rewrite ? [markdown, canonical, contract] : [markdown, html, canonical, contract]) {
      if (!artifact) continue;
      servableUris.add(this.storage.uri(artifact.key));
      const slotUri = artifact.slot === "html"
        ? ledger.read(`${document.id}:html`)
        : ledger.readDocument(document.id, artifact.slot);
      if (slotUri) servableUris.add(slotUri);
    }
    if (redacted && html) {
      // Redaction rewrites the HTML rendering too; page and section withholding withhold it (it has no page breaks).
      servableUris.add(this.storage.uri(html.key));
      const slotUri = ledger.read(`${document.id}:html`);
      if (slotUri) servableUris.add(slotUri);
    }
    let currentMarkdown: string | null = markdown?.text ?? null;
    if (rewrite) {
      if (canonical && canonicalResult && (canonicalResult.changed || withholding)) {
        const next = withholding
          ? applyPlanToCanonical(plan, canonicalResult.document, canonicalResult.changedBlockIndexes)
          : canonicalResult.document;
        await this.storage.putJson(canonical.key, next);
        redactedArtifacts.push(canonical.slot);
      }
      if (markdown && markdownResult && (markdownResult.matches.length > 0 || withholding)) {
        const base = withholding && plan.scope === "sections" ? markdown.text : markdownResult.redacted;
        currentMarkdown = withholding ? applyPlanToText(plan, base, markdownResult.matches) : base;
        await this.storage.streamText(markdown.key, currentMarkdown, markdown.contentType);
        redactedArtifacts.push(markdown.slot);
      }
      if (redacted && html && htmlResult && htmlResult.matches.length > 0) {
        await this.storage.streamText(html.key, htmlResult.redacted, html.contentType);
        redactedArtifacts.push(html.slot);
      }
      if (contract && contractResult && (contractResult.matches.length > 0 || withholding)) {
        const next = plan.scope === "pages" ? applyPlanToJson(plan, contractResult.value, isStructuralKey) : contractResult.value;
        await this.storage.putJson(contract.key, next);
        redactedArtifacts.push(contract.slot);
      }
      if (fallbackResult && (fallbackResult.matches.length > 0 || withholding)) {
        // Embed, summary and page index read the markdown slot before the source file.
        const key = `${runArtifactRoot(state.run, document.userId)}/pii/${document.id}.redacted.md`;
        currentMarkdown = withholding
          ? applyPlanToText(plan, plan.scope === "sections" ? fallbackText : fallbackResult.redacted, fallbackResult.matches)
          : fallbackResult.redacted;
        await this.storage.streamText(key, currentMarkdown, "text/markdown");
        ledger.recordDocument(document.id, "markdown", this.storage.uri(key));
        redactedArtifacts.push("markdown");
        servableUris.add(this.storage.uri(key));
      }
      // Summary evidence holds excerpts of the pre-scan extraction. Rebuild it
      // from the markdown now in the slot (or delete it when that text is
      // unreadable) so withheld text never reaches the summary model or
      // survives in storage.
      const evidence = await refreshSummaryEvidence({
        storage: this.storage, ledger, document,
        text: currentMarkdown, sourceUri: ledger.readDocument(document.id, "markdown"),
      });
      if (evidence !== "absent") redactedArtifacts.push("summary-evidence");
    }

    // Per-page artifacts written before this stage (page images, renders, figures) stay servable for pages known to be
    // clean; everything else written before it (parser candidates, raw vision output, the source file, the HTML) is
    // withheld whenever anything is. Under block_document (or a page that cannot be placed) nothing is served.
    const withheldPageSet = new Set(plan.scope === "pages" ? plan.pages : []);
    const hitPages = located && located.unattributed.length === 0 ? located.pages : null;
    const cleanPage = (page: number): boolean => {
      if (page < 1 || page > document.pageCount) return false;
      if (plan.scope === "pages") return !withheldPageSet.has(page);
      if (redacted) return hitPages !== null && !hitPages.has(page);
      return false;
    };
    const withheldArtifactUris = blocked || redacted || withholding
      ? this.withheldArtifactUris(state, document, blocked ? new Set() : servableUris, blocked ? () => false : cleanPage)
      : [];

    const withheldPageList = plan.scope === "pages" ? plan.pages : [];
    const reason = blocked
      ? policy.action === "block_document" || plan.reason === "every-page-withheld"
        ? `PII policy blocked indexing: ${matchCount} match${matchCount === 1 ? "" : "es"} (${patternTypes.join(", ")})`
        : `PII policy blocked indexing: a match could not be placed on a page (${plan.reason})`
      : plan.scope === "pages"
        ? `PII policy withheld ${withheldPageList.length} page${withheldPageList.length === 1 ? "" : "s"}`
        : plan.scope === "sections"
          ? `PII policy withheld ${plan.sectionCount} section${plan.sectionCount === 1 ? "" : "s"}`
          : null;

    await this.sink.recordDetections(document.id, state.run.id, primary, redacted);
    await this.sink.setDocumentOutcome(document.id, {
      runId: state.run.id,
      scope: plan.scope,
      withheldPages: withheldPageList,
      withheldSectionCount: plan.scope === "sections" ? plan.sectionCount : 0,
      pageCount: document.pageCount,
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
        charOffset: m.charOffset,
        length: m.length,
        source: m.source,
      })),
      sourcesScanned,
      action: policy.action,
      blocked,
      withholding: plan.scope,
      withheldPages: withheldPageList,
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
        withholding: plan.scope === "document" ? "document" : plan.scope,
        withheldPages: withheldPageList,
        ...(plan.scope === "sections" ? { withheldSectionCount: plan.sectionCount } : {}),
        ...(reason ? { reason } : {}),
      },
    };
  }

  /**
   * Every artifact URI recorded for this document so far, minus the ones known to be clean: the rewritten text
   * artifacts and the per-page artifacts (page images, renders, figures) of clean pages. A URI recorded under several
   * slots is served only when every one of them is clean.
   */
  private withheldArtifactUris(
    state: WorkflowState,
    document: Document,
    servable: Set<string>,
    cleanPage: (page: number) => boolean,
  ): string[] {
    const verdicts = new Map<string, boolean>();
    const add = (uri: string, clean: boolean) => verdicts.set(uri, (verdicts.get(uri) ?? true) && clean);
    const prefix = `${document.id}:`;
    for (const [slot, uri] of Object.entries(state.artifactLedger.all())) {
      if (slot.startsWith(prefix) && slot !== `${prefix}pii-detect` && uri.includes("://")) {
        add(uri, perPageArtifactServable(slot.slice(prefix.length), cleanPage));
      }
    }
    for (const stage of state.documentStages.get(document.id)?.values() ?? []) {
      if (stage.stageName !== this.name && stage.artifactUri) add(stage.artifactUri, false);
    }
    add(this.storage.uri(document.sourceKey), false);
    return [...verdicts].filter(([uri, clean]) => !clean && !servable.has(uri)).map(([uri]) => uri).sort();
  }

  /**
   * Reads an artifact the scan must cover. An artifact that is not recorded is simply absent
   * (null); one that is recorded but cannot be read, parsed or decoded throws, because skipping it
   * would let its text reach the index unscanned.
   */
  private async readTextArtifact(
    slot: string,
    uri: string | undefined,
    contentType: string,
    requiredExtension?: string,
  ): Promise<TextArtifact | null> {
    if (!uri || (requiredExtension && !uri.endsWith(requiredExtension))) return null;
    let key = keyFromStorageUri(uri, this.storage.bucket);
    if (!key) throw new PiiScanIncompleteError(`PII scan cannot resolve the ${slot} artifact location`);
    try {
      let bytes = await this.storage.getBytes(key);
      if (key.endsWith(".json")) {
        // A markdown manifest points at the text it selected.
        const manifest = JSON.parse(bytes.toString("utf8")) as { textArtifactUri?: string };
        const textKey = manifest.textArtifactUri ? keyFromStorageUri(manifest.textArtifactUri, this.storage.bucket) : null;
        if (!textKey) throw new Error("manifest names no readable text artifact");
        key = textKey;
        bytes = await this.storage.getBytes(key);
      }
      if (!isUtf8(bytes)) throw new Error("artifact is not valid UTF-8");
      return { slot, key, text: bytes.toString("utf8"), contentType };
    } catch (error) {
      throw new PiiScanIncompleteError(`PII scan could not read the ${slot} artifact`, { cause: error });
    }
  }

  private async readJsonArtifact(slot: string, uri: string | undefined): Promise<JsonArtifact | null> {
    if (!uri) return null;
    const key = keyFromStorageUri(uri, this.storage.bucket);
    if (!key) throw new PiiScanIncompleteError(`PII scan cannot resolve the ${slot} artifact location`);
    try {
      return { slot, key, value: await this.storage.getJson<unknown>(key) };
    } catch (error) {
      throw new PiiScanIncompleteError(`PII scan could not read the ${slot} artifact`, { cause: error });
    }
  }

  async close(): Promise<void> {
    await this.sink.close();
  }
}

function canonicalBlocks(value: unknown): CanonicalBlockLike[] {
  const blocks = value && typeof value === "object" ? (value as { blocks?: unknown }).blocks : null;
  return Array.isArray(blocks) ? (blocks as CanonicalBlockLike[]) : [];
}
