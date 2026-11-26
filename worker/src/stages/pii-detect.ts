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
import { tableCellsArtifactKey } from "../pipeline/html-table-cells-cache.js";
import {
  PII_BLOCKED_DOCUMENT_STATUS,
  PII_DETECTOR_VALIDATION,
  piiCategoryIds,
  piiWithholding,
  type PiiMatch,
  type PiiPolicy,
  type PiiPatternType,
  piiPatternTypeSchema,
} from "@docslurp/shared";
import { createPiiTextScanner, isStructuralKey, redactCanonicalDocument, redactJsonText, type PiiTextScanner } from "../lib/pii-redaction.js";
import {
  applyPlanToCanonical,
  applyPlanToJson,
  applyPlanToText, withholdPagesThenRedact,
  locateMatches,
  mapTextMatchesToCanonical,
  perPageArtifactServable,
  planPiiWithholding,
  redactValuesInBlock,
  type CanonicalBlockLike,
  type PiiWithholdingPlan,
} from "../lib/pii-page-withholding.js";
import { measureOp, pushPerfMetric } from "../lib/perf-context.js";
import { documentTitleWithheld, scrubDocumentMap, type WithheldPagesForMap } from "../lib/pii-document-map.js";
import { findingsStatement } from "../lib/pii-deferred-outcome.js";
import { extractTextForEmbedding } from "./embedding-runtime.js";
import { refreshSummaryEvidence } from "./summary-evidence-refresh.js";
import { withdrawSummaryTreeForPii } from "../summary-tree/state-store.js";

export interface PiiDetectionArtifact {
  documentId: string;
  policy: PiiPolicy;
  /**
   * The kinds of PII found per page (null: no page) and the text sources they were found in. This artifact is a stage
   * artifact the document's own users can fetch, so it holds no fingerprint (an unsalted hash of a short value such as an
   * SSN can be brute-forced), no offset or length and no count of matches: those stay in pii_detections, which no tenant
   * route reads.
   */
  pages: Array<{
    pageNumber: number | null;
    categories: PiiPatternType[];
    sources: PiiTextSource[];
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
  /**
   * Titles and the document map were built before the scan: clear the titles and drop the map's nodes and terms that
   * match or come from a withheld page, and rebuild its search text (pii-document-map.ts). Optional for test sinks.
   */
  scrubTitlesAndMap?(documentId: string, withheld: WithheldPagesForMap, matches: (text: string) => boolean): Promise<void>;
  /** The kinds of PII the document's current outcome records per withheld page (carried pages keep their exact ids). */
  previousPageTypes?(documentId: string): Promise<Map<number, PiiPatternType[]>>;
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
  /**
   * Kinds of PII detected on each withheld page (`documents.metadata.pii.withheldPageTypes`, page-number keys): what
   * tenant responses say a page was withheld for. Categories only.
   */
  withheldPageTypes: Record<string, PiiPatternType[]>;
  /** Operator-only per-page findings with the detector's confidence (`pii_page_findings`); never in documents.metadata. */
  findings: PiiPageFinding[];
  blocked: boolean;
  reviewRequired: boolean;
  redacted: boolean;
  /**
   * Pages a redaction rewrote a value on (their images still show it); null when the pages are unknown, which keeps
   * every page's pixels withheld. Only with `redacted`.
   */
  redactedPages?: number[] | null;
  reason: string | null;
  /**
   * Artifacts the API must refuse to serve for this document: everything
   * written before this stage that it did not scan clean or redact (parser
   * candidates, raw vision output, page images, parser JSON, the source file).
   */
  withheldArtifactUris: string[];
};

/**
 * One operator-only finding: a kind of PII detected on a withheld page (0: no page), with the detector's confidence, or
 * null and the rule's validation basis when the detector has no score (every current detector).
 */
export type PiiPageFinding = {
  pageNumber: number;
  patternType: PiiPatternType;
  detector: "rule" | "model";
  validation: "checksum" | "structure" | "context" | "format" | "score";
  confidence: number | null;
};

/** Findings for what the outcome withholds: per withheld page, or page 0 when the categories have no page. */
export function piiPageFindings(
  pageTypes: ReadonlyMap<number, readonly PiiPatternType[]>,
  unplacedTypes: readonly PiiPatternType[],
): PiiPageFinding[] {
  const rule = (pageNumber: number, patternType: PiiPatternType): PiiPageFinding => ({
    pageNumber, patternType, detector: "rule", validation: PII_DETECTOR_VALIDATION[patternType], confidence: null,
  });
  return [
    ...[...pageTypes].sort(([a], [b]) => a - b).flatMap(([page, types]) => piiCategoryIds(types).map((type) => rule(page, type))),
    ...piiCategoryIds(unplacedTypes).map((type) => rule(0, type)),
  ];
}

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
    action: knownAction(raw.enabled, raw.action),
    allowlistPatterns: raw.allowlistPatterns ?? [],
  };
}

const PII_ACTIONS: ReadonlySet<string> = new Set(["flag_for_review", "redact_artifacts", "block_indexing", "block_document"]);

/**
 * The policy action, failing closed: an action this worker does not know (a newer API configured it) blocks the
 * document. Indexing it in full would ignore what the project asked for.
 */
function knownAction(enabled: boolean, action: unknown): PiiPolicy["action"] {
  if (typeof action === "string" && PII_ACTIONS.has(action)) return action as PiiPolicy["action"];
  if (enabled) console.warn(`[pii] unknown-policy-action action=${typeof action === "string" ? action.slice(0, 40) : typeof action} fallback=block_document`);
  return enabled ? "block_document" : "flag_for_review";
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
      const pii = outcome.matchCount > 0 || outcome.scope !== "none" || outcome.redacted
        ? {
            scope: outcome.scope,
            ...(outcome.scope === "pages" ? { withheldPages: outcome.withheldPages, withheldPageCount: outcome.withheldPages.length } : {}),
            ...(outcome.scope === "sections" ? { withheldSectionCount: outcome.withheldSectionCount } : {}),
            pageCount: outcome.pageCount,
            action: outcome.action,
            runId: outcome.runId,
            patternTypes: outcome.patternTypes,
            ...(outcome.scope === "pages" && Object.keys(outcome.withheldPageTypes).length > 0 ? { withheldPageTypes: outcome.withheldPageTypes } : {}),
            blocked: outcome.blocked,
            reviewRequired: outcome.reviewRequired,
            redacted: outcome.redacted,
            ...(outcome.redacted && outcome.redactedPages ? { redactedPages: outcome.redactedPages } : {}),
            reason: outcome.reason,
            withheldArtifactUris: outcome.withheldArtifactUris,
            detectedAt: new Date().toISOString(),
          }
        : null;
      // One transaction: the outcome, the summary-tree withdrawal, the findings and the page rows commit together. A
      // failure (a worker deployed before its migration, a database blip) leaves none of them, and the retry's rescan
      // carries what the rewritten artifacts already show (placeholders, redaction markers).
      await db.begin(async (transaction) => {
        const tx = transaction as unknown as typeof db;
        // A summary tree the document already has was written from the text this outcome withholds: it stops being
        // served now and its rows and artifact are queued for strict removal (summary-tree/state-store.ts).
        if (outcome.blocked || outcome.redacted || outcome.scope === "pages" || outcome.scope === "sections") await withdrawSummaryTreeForPii(tx as never, documentId);
        // Operator-only findings (confidence and its basis): replaced per scan, scoped to the document's own organization
        // and project through the row itself. Never written to documents.metadata.
        // One primary-key-prefix delete per scan (a clean rescan clears an earlier scan's rows); the insert only when there
        // are findings.
        await findingsStatement(() => tx`delete from pii_page_findings where document_id = ${documentId}`);
        if (outcome.findings.length > 0) {
          await findingsStatement(() => tx`
            insert into pii_page_findings (document_id, org_id, project_id, run_id, page_number, pattern_type, detector, validation, confidence)
            select d.id, d.org_id, d.project_id, ${outcome.runId}, f.page_number, f.pattern_type, f.detector, f.validation, f.confidence
            from documents d
            cross join unnest(
              ${outcome.findings.map((finding) => finding.pageNumber)}::int[],
              ${outcome.findings.map((finding) => finding.patternType)}::text[],
              ${outcome.findings.map((finding) => finding.detector)}::text[],
              ${outcome.findings.map((finding) => finding.validation)}::text[],
              ${outcome.findings.map((finding) => finding.confidence)}::real[]
            ) as f(page_number, pattern_type, detector, validation, confidence)
            where d.id = ${documentId} and d.org_id is not null and d.project_id is not null
          `);
        }
        if (outcome.scope === "pages" && outcome.withheldPages.length > 0) {
          // Rows written before this scan (the map's rough text, a kept model read) of a page it withholds are removed:
          // the map scanned only its own text, and this outcome may place a hit it never saw (OCR, a cross-page span).
          const pages = [...outcome.withheldPages];
          await tx`
            update document_page_states set state = 'blocked-pii', failure_reason = 'pii-policy', updated_at = now()
            where document_id = ${documentId} and page_number = any(${pages}::int[]) and state in ('unseen', 'failed', 'parsed')
          `;
          await tx`delete from document_pages where document_id = ${documentId} and page_number = any(${pages}::int[])`;
          await tx`
            update document_page_states set read_text = null
            where document_id = ${documentId} and page_number = any(${pages}::int[]) and read_text is not null
          `;
        }
        if (outcome.blocked) {
          await tx`
            update documents
            set status = ${PII_BLOCKED_DOCUMENT_STATUS},
                metadata = (coalesce(metadata, '{}'::jsonb) - 'piiBlocked') || jsonb_build_object('pii', ${tx.json(pii)}::jsonb),
                updated_at = now()
            where id = ${documentId}
          `;
          return;
        }
        // Not blocked (or a rescan lifted an earlier block): record the outcome, keep the stage status.
        const metadata = pii
          ? tx`(coalesce(metadata, '{}'::jsonb) - 'piiBlocked') || jsonb_build_object('pii', ${tx.json(pii)}::jsonb)`
          : tx`coalesce(metadata, '{}'::jsonb) - 'pii' - 'piiBlocked'`;
        await tx`
          update documents
          set status = case when status = ${PII_BLOCKED_DOCUMENT_STATUS} then 'processing' else status end,
              metadata = ${metadata},
              updated_at = now()
          where id = ${documentId}
        `;
      });
    },
    async previousPageTypes(documentId) {
      const [row] = await db<Array<{ status: string | null; metadata: unknown }>>`select status, metadata from documents where id = ${documentId}`;
      const recorded = row ? piiWithholding(row) : null;
      return recorded?.scope === "pages" && recorded.pageTypes ? new Map([...recorded.pageTypes].map(([page, types]) => [page, [...types]])) : new Map();
    },
    async scrubTitlesAndMap(documentId, withheld, matches) {
      // One read of the document's titles and map (primary keys); a write only when something changed.
      const [row] = await db<Array<{ title: string | null; title_source: string | null; map_title: string | null; nodes: unknown; terms: unknown; has_map: boolean }>>`
        select d.metadata->>'title' as title, d.metadata->>'titleSource' as title_source, d.metadata->>'mapTitle' as map_title,
               m.nodes, m.terms, m.document_id is not null as has_map
        from documents d left join document_maps m on m.document_id = d.id
        where d.id = ${documentId}
      `;
      if (!row) return;
      const clearTitle = documentTitleWithheld(row.title, row.title_source, withheld, matches);
      const map = scrubDocumentMap({
        nodes: Array.isArray(row.nodes) ? row.nodes as Array<{ title?: unknown; physicalStart?: unknown }> : [],
        terms: Array.isArray(row.terms) ? row.terms as Array<{ term?: unknown; physicalPages?: unknown }> : [],
        title: row.map_title,
      }, withheld, matches);
      if (clearTitle || map.title !== row.map_title) {
        const drop = [...(clearTitle ? ["title", "titleSource"] : []), ...(map.title !== row.map_title ? ["mapTitle"] : [])];
        await db`update documents set metadata = coalesce(metadata, '{}'::jsonb) - ${drop}::text[] where id = ${documentId}`;
      }
      if (row.has_map && map.changed) {
        await db`
          update document_maps set nodes = ${db.json(map.nodes as never)}, terms = ${db.json(map.terms as never)},
            search_text = to_tsvector('simple', ${map.searchText}), version = version + 1, updated_at = now()
          where document_id = ${documentId}
        `;
      }
    },
    async close() {
      await db.end();
    },
  };
}

type TextArtifact = { slot: string; key: string; text: string; contentType: string };
type JsonArtifact = { slot: string; key: string; value: unknown };

const PII_PLACEHOLDER_MARKER = "withheld by the project's privacy policy";
/** What `redactPii` writes in place of a value (`[REDACTED:ssn]`). */
const REDACTION_MARKER = /\[REDACTED:[a-z0-9-]{1,40}\]/;

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

      // Stored HTML table cells hold table text from before this stage. They are never written on a PII-policy run
      // (tableCellsCacheActive); delete any that exist anyway on every redact or block run: unconditionally, before
      // anything is read or redacted, and also when a completed checkpoint is replayed (one DeleteObject). Matches or
      // not: a retry after a failed delete sees already-redacted text and finds nothing, so the delete must not depend
      // on what an attempt finds. A failed delete fails the stage, which is retried; nothing is redacted before it.
      if (policy.action !== "flag_for_review") {
        await this.storage.deleteKeys([tableCellsArtifactKey(state.run, document)]);
      }

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

    // The Markdown is scanned whole and the canonical document block by block: a label in one block and its value in
    // the next match only in the Markdown. Locate each Markdown match's value in the blocks so those blocks are
    // replaced (or redacted) too; embed, search and the canonical download read the canonical document.
    const blocks = canonicalBlocks(canonical?.value);
    const mapped = canonicalResult && markdown && markdownResult
      ? mapTextMatchesToCanonical(blocks, markdown.text, markdownResult.matches, document.pageCount)
      : undefined;
    let plan: PiiWithholdingPlan = planPiiWithholding(policy.action, {
      pageCount: document.pageCount,
      canonical: canonicalResult
        ? { matches: canonicalResult.matches, changedPages: canonicalResult.changedPages, blocks, mapped }
        : null,
      markdown: markdown && markdownResult ? { text: markdown.text, matches: markdownResult.matches } : null,
      fallback: fallbackResult ? { text: fallbackText, matches: fallbackResult.matches } : null,
      html: htmlResult ? { matches: htmlResult.matches } : null,
      contract: contractResult ? { matches: contractResult.matches } : null,
      // Read only when the text carries a placeholder (a rescan of rewritten text): one primary-key select.
      previousPageTypes: [markdown?.text, fallbackText].some((text) => text?.includes(PII_PLACEHOLDER_MARKER))
        ? await this.sink.previousPageTypes?.(document.id)
        : undefined,
    }, anyMatch);
    // Pages hit, for redaction and review: per-page artifacts of the other pages stay servable.
    const located = anyMatch && document.pageCount > 1
      ? locateMatches({
          pageCount: document.pageCount,
          canonical: canonicalResult ? { matches: canonicalResult.matches, changedPages: canonicalResult.changedPages, blocks, mapped } : null,
          markdown: markdown && markdownResult ? { text: markdown.text, matches: markdownResult.matches } : null,
          fallback: fallbackResult ? { text: fallbackText, matches: fallbackResult.matches } : null,
          html: htmlResult ? { matches: htmlResult.matches } : null,
          contract: contractResult ? { matches: contractResult.matches } : null,
        })
      : null;

    if (policy.action === "redact_artifacts" && anyMatch && mapped && mapped.unmapped.length > 0) {
      // Redaction rewrites the canonical document value by value: a Markdown match whose value no block holds in a
      // recognisable form cannot be shown to be gone from it. Fail closed.
      plan = { scope: "document", reason: "unattributed:text-match-not-in-canonical" };
    }
    const blocked = plan.scope === "document";
    const planReason = plan.scope === "document" ? plan.reason : "";
    const withholding = plan.scope === "pages" || plan.scope === "sections";
    // A rescan of text this policy already redacted in place (a retry after the outcome write failed) finds only the
    // markers. That is a carried redaction, never a clean document: the pages it was on are not known, so no page's
    // pixels and nothing the scan did not rewrite is served (as for an older outcome that did not record its pages).
    const carriedRedaction = policy.action === "redact_artifacts" && !anyMatch
      && [markdown?.text, fallbackText, canonical && !markdown ? JSON.stringify(canonical.value) : ""].some((text) => typeof text === "string" && REDACTION_MARKER.test(text));
    const redacted = policy.action === "redact_artifacts" && (anyMatch || carriedRedaction) && !blocked;
    const reviewRequired = policy.action === "flag_for_review" && anyMatch;
    if (blocked && planReason.startsWith("unattributed")) {
      // Fail closed: a hit that cannot be placed on a page withholds the document.
      console.warn(`[pii] document-withheld document=${document.id} reason=${planReason}`);
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
      const mappedBlocks = mapped?.blockIndexes ?? new Map();
      if (canonical && canonicalResult && (canonicalResult.changed || withholding || mappedBlocks.size > 0)) {
        const next = withholding
          ? applyPlanToCanonical(plan, canonicalResult.document, new Set([...canonicalResult.changedBlockIndexes, ...mappedBlocks.keys()]))
          : redactMappedValues(canonicalResult.document, mapped);
        await this.storage.putJson(canonical.key, next);
        redactedArtifacts.push(canonical.slot);
      }
      if (markdown && markdownResult && (markdownResult.matches.length > 0 || withholding)) {
        // Pages: withhold on the original text, then redact each clean page alone (a redacted span that crossed a
        // page break would otherwise drop the break and shift every later page).
        currentMarkdown = plan.scope === "pages"
          ? withholdPagesThenRedact(markdown.text, new Set(plan.pages), (page) => scan(page).redacted, markdownResult.matches, plan.pageTypes)
          : withholding ? applyPlanToText(plan, markdown.text, markdownResult.matches) : markdownResult.redacted;
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
        currentMarkdown = plan.scope === "pages"
          ? withholdPagesThenRedact(fallbackText!, new Set(plan.pages), (page) => scan(page).redacted, fallbackResult.matches, plan.pageTypes)
          : withholding ? applyPlanToText(plan, fallbackText!, fallbackResult.matches) : fallbackResult.redacted;
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
    // A redacted page's image still shows the value: under redaction a page's pixels are servable only when the scan
    // placed every match and none is on it, whether or not other pages are withheld (carried) too.
    const cleanPage = (page: number): boolean => {
      if (page < 1 || page > document.pageCount) return false;
      if (withheldPageSet.has(page)) return false;
      if (redacted) return hitPages !== null && !hitPages.has(page);
      return plan.scope === "pages";
    };
    const redactedPages = redacted && hitPages ? [...hitPages].sort((a, b) => a - b) : null;
    const withheldArtifactUris = blocked || redacted || withholding
      ? this.withheldArtifactUris(state, document, blocked ? new Set() : servableUris, blocked ? () => false : cleanPage)
      : [];

    const withheldPageList = plan.scope === "pages" ? plan.pages : [];
    // Kinds of PII per withheld page: what tenant responses say a page was withheld for. Whole-document and section
    // outcomes keep their categories document-level (patternTypes); their findings go on the page they were placed on
    // when known, else page 0.
    const withheldPageTypes = plan.scope === "pages" ? plan.pageTypes : new Map<number, PiiPatternType[]>();
    const placedTypes = blocked && located && located.unattributed.length === 0
      ? new Map([...located.types].map(([page, types]) => [page, [...types]] as const))
      : null;
    const pageFindings = plan.scope === "pages"
      ? piiPageFindings(withheldPageTypes, [])
      : blocked || plan.scope === "sections"
        ? placedTypes && placedTypes.size > 0
          ? piiPageFindings(placedTypes, [])
          : piiPageFindings(new Map(), piiCategoryIds(patternTypes))
        : [];
    const reason = blocked
      ? policy.action === "block_document" || planReason === "every-page-withheld"
        ? `PII policy blocked indexing (${patternTypes.join(", ")})`
        : `PII policy blocked indexing: a match could not be placed on a page (${planReason})`
      : plan.scope === "pages"
        ? `PII policy withheld ${withheldPageList.length} page${withheldPageList.length === 1 ? "" : "s"}`
        : plan.scope === "sections"
          ? `PII policy withheld ${plan.sectionCount} section${plan.sectionCount === 1 ? "" : "s"}`
          : carriedRedaction ? "PII policy redacted matches (carried from an earlier scan)" : null;

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
      withheldPageTypes: Object.fromEntries([...withheldPageTypes].map(([page, types]) => [String(page), types])),
      findings: pageFindings,
      blocked,
      reviewRequired,
      redacted,
      redactedPages,
      reason,
      withheldArtifactUris,
    });
    if (blocked) document.status = PII_BLOCKED_DOCUMENT_STATUS;
    if (policy.action !== "flag_for_review" && (anyMatch || plan.scope !== "none")) {
      const withheldForMap: WithheldPagesForMap = plan.scope === "pages" ? new Set(plan.pages) : plan.scope === "none" ? new Set() : "all";
      await this.sink.scrubTitlesAndMap?.(document.id, withheldForMap, (text) => scan(text).matches.length > 0);
    }

    const artifact: PiiDetectionArtifact = {
      documentId: document.id,
      policy,
      pages: categoriesByPage(primary),
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

/** Categories and sources per page (null: no page), sorted: what the tenant-fetchable artifact lists instead of matches. */
function categoriesByPage(matches: ReadonlyArray<PiiMatch & { source: PiiTextSource }>): PiiDetectionArtifact["pages"] {
  const byPage = new Map<number | null, { categories: Set<PiiPatternType>; sources: Set<PiiTextSource> }>();
  for (const match of matches) {
    const entry = byPage.get(match.pageNumber) ?? { categories: new Set(), sources: new Set() };
    entry.categories.add(match.patternType);
    entry.sources.add(match.source);
    byPage.set(match.pageNumber, entry);
  }
  return [...byPage]
    .sort(([a], [b]) => (a ?? 0) - (b ?? 0))
    .map(([pageNumber, entry]) => ({ pageNumber, categories: piiCategoryIds([...entry.categories]), sources: [...entry.sources].sort() }));
}

/** The redacted canonical document with every value the Markdown matched also redacted in the blocks holding it. */
function redactMappedValues<T extends { blocks?: unknown }>(document: T, mapped: ReturnType<typeof mapTextMatchesToCanonical> | undefined): T {
  if (!mapped || mapped.values.size === 0 || !Array.isArray(document.blocks)) return document;
  return {
    ...document,
    blocks: (document.blocks as CanonicalBlockLike[]).map((block, index) => {
      const values = mapped.values.get(index);
      return values ? redactValuesInBlock(block, values) : block;
    }),
  };
}

function canonicalBlocks(value: unknown): CanonicalBlockLike[] {
  const blocks = value && typeof value === "object" ? (value as { blocks?: unknown }).blocks : null;
  return Array.isArray(blocks) ? (blocks as CanonicalBlockLike[]) : [];
}
