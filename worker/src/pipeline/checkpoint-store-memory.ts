/*
 * In-memory adapters of the ports a run's stages write through (pipeline.ts CheckpointStore), for tests and tools without a
 * database. Each records what it was asked to write so a test can assert on it; none models the Postgres adapters' SQL. Build
 * a whole store with `memoryCheckpointStore(overrides)` and replace only the ports or checkpoints a test is about.
 */
import type { DerivedDocumentTitle, FileFacts, PrivacyAuditEntry } from "@docslurp/shared";

import type { DocumentAssets } from "../db/document-asset-ledger.js";
import type { DocumentContentWriter, RunScope } from "../db/document-content.js";
import type { DocumentRecords, DocumentRowScope } from "../db/document-records.js";
import type { FleetBudgets } from "../db/fleet-budgets.js";
import type { GeoAttempt } from "../db/geo-final-source.js";
import type { OcrEscalationLog, OcrEscalationReadRow } from "../db/ocr-escalation-reads.js";
import type { EmbeddingReuseRef } from "../embeddings/embedding-reuse.js";
import type { GraphChunk } from "../graph/extract.js";
import type { KnowledgeGraphStore } from "../graph/knowledge-graph-store.js";
import type { ParseSourceDecisionRecord } from "../lib/parse-source.js";
import type { ProjectRunEvent } from "../models.js";
import type { PageFactUpsert } from "./page-facts.js";
import { MemoryPageBasisLedger } from "./page-basis-memory.js";
import type { CheckpointStore, WorkflowState } from "./pipeline.js";
import type { RunMilestone, RunMilestoneHit } from "./run-milestones.js";

type ChunkRow = Parameters<DocumentContentWriter["insertChunks"]>[1][number];
type PageRow = Parameters<DocumentContentWriter["insertPages"]>[1][number];
type PropositionRow = Parameters<DocumentContentWriter["insertPropositions"]>[1][number];
type SummaryRow = Parameters<DocumentContentWriter["insertSummary"]>[1];

/**
 * Search content rows, keyed as their tables are (chunks and pages by id, page facts by document and page). Rows must be the
 * write scope's document and run, as the Postgres adapter requires; it does not model documents' organizations.
 */
export class MemoryDocumentContent implements DocumentContentWriter {
  readonly chunks = new Map<string, ChunkRow>();
  readonly pages = new Map<string, PageRow>();
  readonly propositions: PropositionRow[] = [];
  readonly summaries = new Map<string, SummaryRow>();
  readonly pageFacts = new Map<string, PageFactUpsert>();
  /** Documents whose chunks were linked to their pages, per run. */
  readonly linkedDocuments: Array<{ documentId: string; runId: string }> = [];
  readonly lexicalSearchable = new Set<string>();
  /** Embedding reuse refs per organization and key. */
  readonly reuseRefs = new Map<string, EmbeddingReuseRef>();

  async insertChunks(scope: DocumentRowScope, chunks: ChunkRow[]): Promise<void> {
    inScope(scope, chunks);
    for (const chunk of chunks) this.chunks.set(chunk.id, chunk);
  }

  async staleDocumentChunkIds({ documentId }: DocumentRowScope, keepChunkIds: readonly string[]): Promise<string[]> {
    const keep = new Set(keepChunkIds);
    return [...this.chunks.values()].filter((chunk) => chunk.documentId === documentId && !keep.has(chunk.id)).map((chunk) => chunk.id);
  }

  async deleteStaleDocumentChunks(scope: DocumentRowScope, keepChunkIds: readonly string[]): Promise<string[]> {
    const stale = await this.staleDocumentChunkIds(scope, keepChunkIds);
    for (const id of stale) this.chunks.delete(id);
    return stale;
  }

  /** The prune, then the marker: the Postgres adapter's one transaction, as its two halves in order. */
  async finalizeDocumentChunks(scope: DocumentRowScope, keepChunkIds: readonly string[], markSearchable: boolean): Promise<void> {
    await this.deleteStaleDocumentChunks(scope, keepChunkIds);
    if (markSearchable) await this.markDocumentLexicalSearchable(scope);
  }

  async markDocumentLexicalSearchable({ documentId }: DocumentRowScope): Promise<void> {
    this.lexicalSearchable.add(documentId);
  }

  async insertPages(scope: DocumentRowScope, pages: PageRow[]): Promise<void> {
    inScope(scope, pages);
    for (const page of pages) this.pages.set(page.id, page);
  }

  async linkChunksToPages({ documentId, runId }: DocumentRowScope): Promise<void> {
    this.linkedDocuments.push({ documentId, runId });
  }

  async insertPropositions(scope: DocumentRowScope, rows: PropositionRow[]): Promise<void> {
    inScope(scope, rows);
    this.propositions.push(...rows);
  }

  async insertSummary(scope: DocumentRowScope, summary: SummaryRow): Promise<void> {
    inScope(scope, [summary]);
    this.summaries.set(summary.id, summary);
  }

  async upsertPageFacts(scope: RunScope, rows: readonly PageFactUpsert[]): Promise<void> {
    for (const row of rows.filter((candidate) => candidate.runId === scope.runId)) {
      const key = `${row.documentId}:${row.pageNumber}`;
      this.pageFacts.set(key, { ...this.pageFacts.get(key), ...row });
    }
  }

  async findEmbeddingReuseRefs(orgId: string, keys: readonly string[]): Promise<EmbeddingReuseRef[]> {
    return keys.flatMap((key) => this.reuseRefs.get(`${orgId}:${key}`) ?? []);
  }

  async recordEmbeddingReuseRefs(orgId: string, refs: readonly EmbeddingReuseRef[]): Promise<void> {
    for (const ref of refs) this.reuseRefs.set(`${orgId}:${ref.key}`, ref);
  }

  async forgetEmbeddingReuseRefs(orgId: string, artifactUri: string, keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      if (this.reuseRefs.get(`${orgId}:${key}`)?.artifactUri === artifactUri) this.reuseRefs.delete(`${orgId}:${key}`);
    }
  }
}

function inScope(scope: DocumentRowScope, rows: ReadonlyArray<{ documentId: string; runId: string }>): void {
  if (rows.some((row) => row.documentId !== scope.documentId || row.runId !== scope.runId)) {
    throw new Error(`content rows outside their write scope document=${scope.documentId} run=${scope.runId}`);
  }
}

/** One document's row facts, as far as stages settle them. */
export interface MemoryDocumentRecord {
  orgId: string | null;
  runId: string;
  bytes: number;
  title?: DerivedDocumentTitle;
  fileFacts?: FileFacts;
  parseSource?: ParseSourceDecisionRecord | null;
  /** The document's PII outcome withholds artifacts (it redacted or blocked). */
  piiWithholds?: boolean;
  withheldArtifactUris?: string[];
}

/** Document rows by id. A read or write outside the document's run or organization matches no row. */
export class MemoryDocumentRecords implements DocumentRecords {
  private row(scope: DocumentRowScope): MemoryDocumentRecord | undefined {
    const row = this.documents.get(scope.documentId);
    return row && row.runId === scope.runId && scope.orgId !== null && row.orgId === scope.orgId ? row : undefined;
  }

  readonly documents = new Map<string, MemoryDocumentRecord>();
  readonly geoAttempts: GeoAttempt[] = [];

  /** Adds (or replaces) a document row. */
  add(documentId: string, record: Partial<MemoryDocumentRecord> & { runId: string }): MemoryDocumentRecord {
    const row: MemoryDocumentRecord = { orgId: null, bytes: 0, ...record };
    this.documents.set(documentId, row);
    return row;
  }

  async beginGeoAttempt(state: WorkflowState, documentId: string, schema: Record<string, unknown>): Promise<GeoAttempt | undefined> {
    if (!state.run.projectId || !state.run.orgId) throw new Error("Geo extraction requires tenant scope");
    void schema;
    const attempt: GeoAttempt = {
      documentId, projectId: state.run.projectId, orgId: state.run.orgId, runId: state.run.id,
      revision: String(this.geoAttempts.length + 1), schemaDigest: "memory",
    };
    this.geoAttempts.push(attempt);
    return attempt;
  }

  /** A missing document withholds (fail closed), as the Postgres adapter's does. */
  async documentPiiWithholds(scope: DocumentRowScope): Promise<boolean> {
    const row = this.row(scope);
    if (!row) return true;
    return row.piiWithholds === true || (row.withheldArtifactUris?.length ?? 0) > 0;
  }

  /** Throws when the document has no PII outcome to add to (piiWithholds unset). */
  async appendWithheldArtifactUris(scope: DocumentRowScope, uris: readonly string[]): Promise<void> {
    if (uris.length === 0) return;
    const row = this.row(scope);
    if (!row || row.piiWithholds === undefined) throw new Error("PII withheld list not updated: the document has no PII outcome");
    row.withheldArtifactUris = [...new Set([...(row.withheldArtifactUris ?? []), ...uris])].sort();
  }

  async documentScopes(documentIds: readonly string[]): Promise<Map<string, { orgId: string | null; runId: string; bytes: number }>> {
    return new Map(documentIds.flatMap((id) => {
      const row = this.documents.get(id);
      return row ? [[id, { orgId: row.orgId, runId: row.runId, bytes: row.bytes }] as const] : [];
    }));
  }

  async setDocumentFileFacts(runId: string, documentId: string, facts: FileFacts): Promise<boolean> {
    const row = this.documents.get(documentId);
    if (!row || row.runId !== runId) return false;
    row.fileFacts = facts;
    return true;
  }

  async setDocumentParseSource(runId: string, documentId: string, decision: ParseSourceDecisionRecord | null): Promise<boolean> {
    const row = this.documents.get(documentId);
    if (!row || row.runId !== runId) return false;
    row.parseSource = decision;
    return true;
  }

  async setDocumentTitleIfAbsent(scope: DocumentRowScope, title: DerivedDocumentTitle): Promise<boolean> {
    const row = this.row(scope);
    if (!row || row.title?.title.trim()) return false;
    row.title = title;
    return true;
  }
}

type AssetScope = Parameters<DocumentAssets["markAssetsPending"]>[0]["scope"];

/** Figure rows per document, and the pages Doppler left to the host per (organization, document). */
export class MemoryDocumentAssets implements DocumentAssets {
  readonly pending: Array<{ scope: AssetScope; rows: Parameters<DocumentAssets["markAssetsPending"]>[0]["rows"] }> = [];
  readonly stored: Array<{ scope: AssetScope; files: Parameters<DocumentAssets["markAssetsStored"]>[0]["files"] }> = [];
  readonly replaced: Array<{ scope: AssetScope; key: string }> = [];
  readonly hostPageImagePages = new Map<string, number[]>();

  async markAssetsPending(args: Parameters<DocumentAssets["markAssetsPending"]>[0]): Promise<{ pending: number }> {
    this.pending.push(args);
    return { pending: args.rows.length };
  }

  async markAssetsStored(args: Parameters<DocumentAssets["markAssetsStored"]>[0]): Promise<{ stored: number }> {
    this.stored.push(args);
    return { stored: args.files.length };
  }

  async replaceUnvouchedObject(args: Parameters<DocumentAssets["replaceUnvouchedObject"]>[0]): Promise<void> {
    this.replaced.push({ scope: args.scope, key: args.key });
    await args.replace();
  }

  async listHostPageImagePages(scope: { orgId: string; documentId: string }): Promise<number[]> {
    return this.hostPageImagePages.get(`${scope.orgId}:${scope.documentId}`) ?? [];
  }
}

/** A project graph per project: the documents extracted under each config hash, and the last write per document. */
export class MemoryKnowledgeGraph implements KnowledgeGraphStore {
  readonly chunks = new Map<string, GraphChunk[]>();
  readonly writes: Array<Parameters<KnowledgeGraphStore["replaceDocumentGraph"]>[0]> = [];
  readonly extracted = new Map<string, Set<string>>();
  readonly refreshes: Array<Parameters<KnowledgeGraphStore["refreshProjectCommunities"]>[0]> = [];
  scope = "Project documents";

  async loadDocumentGraphChunks(projectId: string, documentId: string): Promise<GraphChunk[]> {
    return this.chunks.get(`${projectId}:${documentId}`) ?? [];
  }

  async replaceDocumentGraph(input: Parameters<KnowledgeGraphStore["replaceDocumentGraph"]>[0]): Promise<{ nodes: number; edges: number }> {
    this.writes.push(input);
    return { nodes: 0, edges: 0 };
  }

  async refreshProjectCommunities(args: Parameters<KnowledgeGraphStore["refreshProjectCommunities"]>[0]) {
    this.refreshes.push(args);
    return { communities: 0, summarized: 0, reused: 0, inputTokens: 0, outputTokens: 0 };
  }

  async documentsWithGraph(projectId: string, configHash: string, documentIds: readonly string[]): Promise<Set<string>> {
    const done = this.extracted.get(`${projectId}:${configHash}`) ?? new Set<string>();
    return new Set(documentIds.filter((id) => done.has(id)));
  }

  async projectGraphScope(): Promise<string> {
    return this.scope;
  }
}

/** Fleet caps as counters: Fast page-image renders left per run, free chart-export VM runs left per organization. */
export class MemoryFleetBudgets implements FleetBudgets {
  /** Renders granted so far per run. */
  readonly fastPageImageRenders = new Map<string, number>();
  /** Free VM runs granted so far per organization (one hour, never reset). */
  readonly chartExportFreeVmRuns = new Map<string, number>();

  async reserveFastPageImageRenders(args: { runId: string; documentId: string; wanted: number; perRun: number }): Promise<number> {
    const used = this.fastPageImageRenders.get(args.runId) ?? 0;
    const granted = Math.max(0, Math.min(args.wanted, args.perRun - used));
    this.fastPageImageRenders.set(args.runId, used + granted);
    return granted;
  }

  async reserveChartExportFreeVmRun(args: { orgId: string; runId: string; documentId: string; perHour: number }): Promise<boolean> {
    const used = this.chartExportFreeVmRuns.get(args.orgId) ?? 0;
    if (used >= args.perHour) return false;
    this.chartExportFreeVmRuns.set(args.orgId, used + 1);
    return true;
  }
}

/** OCR escalation reads per (run, document, page), attempts numbered from 1. */
export class MemoryOcrEscalationLog implements OcrEscalationLog {
  readonly reads = new Map<string, OcrEscalationReadRow[]>();

  async ocrEscalationReads(runId: string, documentId: string, pageNumber: number): Promise<OcrEscalationReadRow[]> {
    return [...(this.reads.get(`${runId}:${documentId}:${pageNumber}`) ?? [])];
  }

  async recordOcrEscalationRead(row: Omit<OcrEscalationReadRow, "attempt"> & { runId: string; documentId: string; pageNumber: number }): Promise<number> {
    const key = `${row.runId}:${row.documentId}:${row.pageNumber}`;
    const rows = this.reads.get(key) ?? [];
    const attempt = rows.length + 1;
    rows.push({ attempt, status: row.status, text: row.text, model: row.model, usageEvents: row.usageEvents });
    this.reads.set(key, rows);
    return attempt;
  }
}

/**
 * A whole checkpoint store in memory: run and stage checkpoints are recorded (stage transitions, events, completed pages,
 * milestones, strikes, privacy audits) and every port is its in-memory adapter. Credit leases never run out.
 */
export class MemoryCheckpointStore implements CheckpointStore {
  readonly pageBasisLedger = new MemoryPageBasisLedger();
  readonly content = new MemoryDocumentContent();
  readonly records = new MemoryDocumentRecords();
  readonly assets = new MemoryDocumentAssets();
  readonly graph = new MemoryKnowledgeGraph();
  readonly budgets = new MemoryFleetBudgets();
  readonly ocrEscalation = new MemoryOcrEscalationLog();

  /** Stage transitions in order, as `${status}:${stage}` or `${status}:${documentId}:${stage}`. */
  readonly transitions: string[] = [];
  readonly events: ProjectRunEvent[] = [];
  readonly completedPages = new Map<string, Set<number>>();
  readonly milestones = new Set<string>();
  readonly strikes = new Map<string, number>();
  readonly privacyAudits: PrivacyAuditEntry[] = [];
  readonly shardObservations = new Map<string, Array<{ pages: number; ms: number; maxRssMiB?: number }>>();
  progressWrites = 0;

  async updateProgress(): Promise<void> {
    this.progressWrites += 1;
  }

  async startRunStage(_state: WorkflowState, stage: string): Promise<void> {
    this.transitions.push(`started:${stage}`);
  }

  async completeRunStage(_state: WorkflowState, stage: string): Promise<void> {
    this.transitions.push(`completed:${stage}`);
  }

  async failRunStage(_state: WorkflowState, stage: string): Promise<number> {
    this.transitions.push(`failed:${stage}`);
    return this.transitions.filter((entry) => entry === `failed:${stage}`).length;
  }

  async startDocumentStage(_state: WorkflowState, documentId: string, stage: string): Promise<void> {
    this.transitions.push(`started:${documentId}:${stage}`);
  }

  async completeDocumentStage(_state: WorkflowState, documentId: string, stage: string): Promise<void> {
    this.transitions.push(`completed:${documentId}:${stage}`);
  }

  async failDocumentStage(_state: WorkflowState, documentId: string, stage: string): Promise<void> {
    this.transitions.push(`failed:${documentId}:${stage}`);
  }

  async noteSandboxInfrastructureStrike(_state: WorkflowState, documentId: string, stage: string): Promise<number> {
    const key = `${documentId}:${stage}`;
    const strikes = (this.strikes.get(key) ?? 0) + 1;
    this.strikes.set(key, strikes);
    return strikes;
  }

  /** Null when the blamed document has no stage row in this run (no transition recorded for it). */
  async noteBlamedSandboxStrike(state: WorkflowState, documentId: string): Promise<number | null> {
    const last = [...this.transitions].reverse().find((entry) => entry.split(":")[1] === documentId);
    return last ? await this.noteSandboxInfrastructureStrike(state, documentId, last.split(":")[2]!) : null;
  }

  async appendEvent(event: ProjectRunEvent): Promise<void> {
    this.events.push(event);
  }

  creditLeaseWouldExhaust(): boolean {
    return false;
  }

  async setPageStageComplete(runId: string, documentId: string, stageName: string, pageNumber: number): Promise<void> {
    await this.setPagesStageComplete(runId, documentId, stageName, [pageNumber]);
  }

  async setPagesStageComplete(runId: string, documentId: string, stageName: string, pageNumbers: number[]): Promise<void> {
    const key = `${runId}:${documentId}:${stageName}`;
    const pages = this.completedPages.get(key) ?? new Set<number>();
    for (const page of pageNumbers) pages.add(page);
    this.completedPages.set(key, pages);
  }

  async getCompletedPages(runId: string, documentId: string, stageName: string): Promise<Set<number>> {
    return new Set(this.completedPages.get(`${runId}:${documentId}:${stageName}`) ?? []);
  }

  /** Stamps once per run and milestone; the hit reports zero seconds and pages. */
  async markRunMilestone(runId: string, milestone: RunMilestone): Promise<RunMilestoneHit | null> {
    const key = `${runId}:${milestone}`;
    if (this.milestones.has(key)) return null;
    this.milestones.add(key);
    return { seconds: 0, pages: 0 };
  }

  async recordPrivacyAudit(entries: readonly PrivacyAuditEntry[]): Promise<void> {
    this.privacyAudits.push(...entries);
  }

  async loadShardObservations(profileKey: string, limit = 200): Promise<Array<{ pages: number; ms: number; maxRssMiB?: number }>> {
    return (this.shardObservations.get(profileKey) ?? []).slice(0, limit);
  }
}

/**
 * An in-memory checkpoint store with some checkpoints or ports replaced (a `vi.fn`, a failing write, a port of its own).
 * Overrides are own properties, so the rest of the store keeps its in-memory behaviour.
 */
export function memoryCheckpointStore<T extends Partial<CheckpointStore>>(overrides: T = {} as T): MemoryCheckpointStore & T {
  return Object.assign(new MemoryCheckpointStore(), overrides);
}
