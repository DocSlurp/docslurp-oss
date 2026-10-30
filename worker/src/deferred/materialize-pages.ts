import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import type { JSONValue, Sql } from "postgres";

import {
  buildPricedAiUsageLedgerEvent,
  calculateAiUsageCostCents,
  pageCredits,
  qualityAllowsPageReading,
  qualityReadsEveryPage,
  richPagesForOutputTokens,
  type MaterializePagesInput,
  type PipelineFeatures,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import { resolveEmbeddingModel } from "../embeddings/resolver.js";
import { runLocalArtifactCommand } from "../extractors/local-artifact-adapters.js";
import { createPiiTextScanner } from "../lib/pii-redaction.js";
import type { Document, EmbeddingProfile } from "../models.js";
import { chunkTextWithMeta } from "../pipeline/chunking.js";
import {
  contiguousPageRanges,
  normalizePageNumbers,
  PdfRasterCache,
  PdfSourceCache,
} from "../pipeline/pdf-asset-cache.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { workspaceVectorLocation } from "../stages/lancedb-location.js";
import type { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { resolvePolicy } from "../stages/pii-detect.js";
import { embedTextChunks, estimateTokens, type RemoteEmbeddingUsage, type VectorBackendRecord } from "../stages/embedding-runtime.js";
import { deleteLanceDbRecords, writeLanceDbRecords } from "../stages/lancedb-writer.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { executeVisionRuntime, rejectedVisionUsageInput } from "../tools/vision-runtime.js";
import { findVisionOutputRejected } from "../tools/vision-stream.js";
import { DocumentNotFoundError } from "../db/missing-document.js";
import { billLockedMaterializedPages, lockPageRows } from "../db/page-base-fee.js";
import { markPages } from "./page-ledger.js";

/** Failure reason for a page Fast left unread because it has no text layer (kept as its page image). */
export const KEPT_AS_IMAGE_REASON = "kept-as-image";
/** Pages with fewer non-space characters than this have no usable text layer. */
export const MIN_TEXT_LAYER_CHARS = 40;
/** Chunks per embedding call. */
export const EMBED_BATCH_CHUNKS = 256;
const CHUNK_MAX_CHARS = 1800;
const OCR_DPI = 150;
const OCR_CONCURRENCY = 3;
const TEXT_LAYER_MAX_BYTES = 32 * 1024 * 1024;
const TEXT_LAYER_TIMEOUT_MS = 60_000;

export interface OcrPageResult {
  text: string;
  model: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  metadata?: Record<string, unknown>;
}

/** Side-effecting edges, injectable so tests need no poppler, vision model, embedder or LanceDB. */
export interface PageMaterializerOps {
  /** Text layer for pages first..last (inclusive), one string per page. */
  extractText(document: Document, range: { first: number; last: number }, signal?: AbortSignal): Promise<string[]>;
  /** Rasterize + vision-OCR one page. */
  ocrPage(document: Document, page: number, ctx: { runId: string; pipeline: PipelineFeatures; signal?: AbortSignal }): Promise<OcrPageResult>;
  embed(args: {
    chunks: string[];
    profile: EmbeddingProfile;
    pipeline: PipelineFeatures;
    onRemoteUsage: (usage: RemoteEmbeddingUsage) => Promise<void>;
    signal?: AbortSignal;
  }): Promise<{ vectors: number[][]; totalTokens?: number; costCents?: number }>;
  writeVectors(uri: string, table: string, records: VectorBackendRecord[], signal?: AbortSignal): Promise<void>;
  /** Deletes LanceDB rows by id (stale chunks of a re-chunked page). Missing table is a no-op. */
  deleteVectors(uri: string, table: string, ids: string[]): Promise<void>;
}

export interface PageMaterializerDeps {
  sql: Sql;
  store: Store;
  storage: ArtifactStore;
  runner: CommandRunner;
  config: Config;
  usage: PipelineUsageEventLedger;
  now?: () => number;
  /** Overrides for the external edges (tests); defaults use poppler, the vision runtime, `embedTextChunks` and LanceDB. */
  ops?: Partial<PageMaterializerOps>;
  /** Shared PDF source/raster cache; one per worker process is ideal. */
  rasterCache?: PdfRasterCache;
}

export interface MaterializePagesResult {
  indexed: number[];
  blocked: number[];
  failed: Array<{ page: number; reason: string }>;
  costCredits: number;
}

const rasterCaches = new WeakMap<object, PdfRasterCache>();

function defaultRasterCache(deps: PageMaterializerDeps): PdfRasterCache {
  if (deps.rasterCache) return deps.rasterCache;
  let cache = rasterCaches.get(deps.storage);
  if (!cache) {
    cache = new PdfRasterCache(deps.runner as never, deps.storage as never, new PdfSourceCache(deps.storage));
    rasterCaches.set(deps.storage, cache);
  }
  return cache;
}

function defaultOps(deps: PageMaterializerDeps): PageMaterializerOps {
  const raster = () => defaultRasterCache(deps);
  return {
    async extractText(document, range, signal) {
      const count = range.last - range.first + 1;
      if (document.mimeType !== "application/pdf") return Array.from({ length: count }, () => "");
      const sourcePath = await raster().sourcePath(document);
      const out = await runLocalArtifactCommand(
        "pdftotext",
        ["-f", String(range.first), "-l", String(range.last), "-layout", "-enc", "UTF-8", sourcePath, "-"],
        TEXT_LAYER_MAX_BYTES,
        TEXT_LAYER_TIMEOUT_MS,
        signal,
      );
      // pdftotext separates pages with a form feed.
      const pages = out.toString("utf8").split("\f");
      return Array.from({ length: count }, (_, i) => pages[i] ?? "");
    },
    async ocrPage(document, page, ctx) {
      // Fail closed: Fast never sends a page to a vision model.
      if (!qualityAllowsPageReading(ctx.pipeline.quality)) throw new Error(`quality fast does not read page ${page}`);
      const [artifact] = await raster().renderSelectedPages({
        document, runId: ctx.runId, pageNumbers: [page], dpi: OCR_DPI, signal: ctx.signal,
      });
      if (!artifact) throw new Error(`could not render page ${page}`);
      const imagePath = await deps.storage.downloadToTempFile(artifact.artifactKey, `page-${page}-*.png`);
      try {
        const result = await executeVisionRuntime({
          imagePath,
          mimeType: artifact.mimeType,
          outputPath: `${imagePath}.vision.json`,
          vision: ctx.pipeline.vision,
          cfg: deps.config,
          runner: deps.runner,
          privacyMode: ctx.pipeline.privacyMode,
          signal: ctx.signal,
        });
        const costCents = result.costCents ?? calculateAiUsageCostCents({
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costPer1kInputTokens: deps.config.costPer1kInputTokens,
          costPer1kOutputTokens: deps.config.costPer1kOutputTokens,
        });
        return {
          text: result.text,
          model: result.model,
          provider: result.provider ?? (result.runtime === "remote-openai" ? "openai" : "vision-runtime"),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costCents,
          metadata: { ...result.costMetadata, runtime: result.runtime, usageSource: result.usageSource, rasterArtifactUri: artifact.artifactUri },
        };
      } finally {
        await rm(`${imagePath}.vision.json`, { force: true });
        await rm(path.dirname(imagePath), { recursive: true, force: true });
      }
    },
    async embed(args) {
      return await embedTextChunks({
        chunks: args.chunks,
        profile: args.profile,
        config: deps.config,
        privacyMode: args.pipeline.privacyMode,
        runner: deps.runner,
        signal: args.signal,
        onRemoteUsage: args.onRemoteUsage,
      });
    },
    async writeVectors(uri, table, records, signal) {
      await writeLanceDbRecords(uri, table, records, signal);
    },
    async deleteVectors(uri, table, ids) {
      await deleteLanceDbRecords(uri, table, ids);
    },
  };
}

interface PreparedPage {
  page: number;
  text: string;
}

/**
 * Heading path for a page from the flat `document_maps.nodes` array
 * (`{ id, title, parentId, physicalStart, physicalEnd, ... }`): the title chain, via `parentId`,
 * of the deepest node whose physical range contains the page.
 */
export function headingPathsFromMap(nodes: unknown): (page: number) => string[] {
  type Node = { id: string; title: string; parentId: string | null; start: number; end: number };
  const byId = new Map<string, Node>();
  const ranged: Node[] = [];
  if (Array.isArray(nodes)) {
    for (const raw of nodes) {
      if (!raw || typeof raw !== "object") continue;
      const n = raw as Record<string, unknown>;
      if (typeof n.id !== "string" || typeof n.title !== "string") continue;
      const node: Node = {
        id: n.id,
        title: n.title.trim(),
        parentId: typeof n.parentId === "string" ? n.parentId : null,
        start: typeof n.physicalStart === "number" ? n.physicalStart : NaN,
        end: typeof n.physicalEnd === "number" ? n.physicalEnd : NaN,
      };
      byId.set(node.id, node);
      if (Number.isFinite(node.start) && Number.isFinite(node.end)) ranged.push(node);
    }
  }
  return (page) => {
    let best: Node | null = null;
    let bestSpan = Infinity;
    for (const node of ranged) {
      if (node.start > page || page > node.end) continue;
      const span = node.end - node.start;
      // Deepest = narrowest range; later nodes win ties (children follow parents).
      if (span <= bestSpan) { best = node; bestSpan = span; }
    }
    const path: string[] = [];
    const seen = new Set<string>();
    for (let cur = best; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) ?? null : null) {
      seen.add(cur.id);
      if (cur.title) path.unshift(cur.title);
    }
    return path;
  };
}

type PageRow = { id: string; documentId: string; runId: string; userId: string; pageNumber: number; text: string; tokenEstimate: number };
type ChunkRow = {
  id: string; documentId: string; runId: string; userId: string; chunkIndex: number; text: string;
  headingPath: string[]; pageNumber: number; tokenEstimate: number; metadata: Record<string, unknown>;
};

/** Store.insertPages on the publication transaction. */
async function insertPageRows(client: Sql, pages: PageRow[]): Promise<void> {
  if (pages.length === 0) return;
  const rows = pages.map((page) => ({
    id: page.id, document_id: page.documentId, run_id: page.runId, user_id: page.userId,
    page_number: page.pageNumber, text: page.text, token_estimate: page.tokenEstimate,
  }));
  await client`
    insert into document_pages ${client(rows, "id", "document_id", "run_id", "user_id", "page_number", "text", "token_estimate")}
    on conflict (id) do update
    set run_id = excluded.run_id, user_id = excluded.user_id, page_number = excluded.page_number,
        text = excluded.text, token_estimate = excluded.token_estimate
  `;
}

/** Store.insertChunks on the publication transaction. */
async function insertChunkRows(client: Sql, chunks: ChunkRow[]): Promise<void> {
  for (let from = 0; from < chunks.length; from += 1000) {
    const rows = chunks.slice(from, from + 1000).map((chunk) => ({
      id: chunk.id, document_id: chunk.documentId, run_id: chunk.runId, user_id: chunk.userId, chunk_index: chunk.chunkIndex,
      text: chunk.text, heading_path: chunk.headingPath, page_number: chunk.pageNumber, token_estimate: chunk.tokenEstimate,
      metadata: client.json(chunk.metadata as JSONValue), content_hash: null, pipeline_version: null,
    }));
    await client`
      insert into document_chunks ${client(rows, "id", "document_id", "run_id", "user_id", "chunk_index", "text", "heading_path",
        "page_number", "token_estimate", "metadata", "content_hash", "pipeline_version")}
      on conflict (id) do update
      set document_id = excluded.document_id, run_id = excluded.run_id, user_id = excluded.user_id,
          chunk_index = excluded.chunk_index, text = excluded.text, heading_path = excluded.heading_path,
          page_number = excluded.page_number, token_estimate = excluded.token_estimate, metadata = excluded.metadata,
          content_hash = excluded.content_hash, pipeline_version = excluded.pipeline_version
    `;
  }
}

/** Store.linkChunksToPages on the publication transaction. */
async function linkChunksToPageRows(client: Sql, documentId: string, runId: string): Promise<void> {
  await client`
    update document_chunks c
    set parent_page_id = p.id
    from document_pages p
    where c.document_id = ${documentId} and c.run_id = ${runId}
      and p.document_id = ${documentId} and p.run_id = ${runId}
      and c.page_number = p.page_number and c.parent_page_id is null
  `;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

/**
 * Parse -> PII-check -> chunk -> embed -> index the requested pages of one document.
 * The caller owns the claim (`claimPages`); this marks each page `indexed`, `blocked-pii`
 * or `failed`. Chunk ids, which are also the LanceDB row ids, are generation-specific:
 * `${documentId}:p${page}:g${generation}:c${i}`, with a fresh generation per call (see step 5).
 */
export async function materializePageRange(
  deps: PageMaterializerDeps,
  input: MaterializePagesInput & { document: Document; pipeline: PipelineFeatures; run: WorkflowState["run"] },
): Promise<MaterializePagesResult> {
  const ops: PageMaterializerOps = { ...defaultOps(deps), ...deps.ops };
  const { document, pipeline, run, documentId } = input;
  const result: MaterializePagesResult = { indexed: [], blocked: [], failed: [], costCredits: 0 };
  const pages = normalizePageNumbers(input.pages, document.pageCount);
  if (pages.length === 0) return result;

  const failed = new Map<number, string>();
  const released: number[] = [];
  const prepared = new Map<number, PreparedPage>();
  /** Pages a model read with non-empty content, and the Rich pages each read is worth. */
  const modelReads = new Map<number, number>();
  /** Customer credits of each page's read (Rich charges buffered in the ledger). */
  const readCents = new Map<number, number>();
  /** Read text of pages this call read with no PII match, kept on the page row if the page then fails. */
  const keptReads = new Map<number, string>();
  let spentCents = 0;
  /** This publication's id generation: its chunk and vector ids are never written by another call. */
  const generation = randomBytes(6).toString("hex");

  // 0. Pages an earlier run read (one Rich charge, committed) and then failed after the read: index the kept read,
  // with no model call and no new charge (billLockedMaterializedPages stamps them without one). Retention purge,
  // a PII block and a human correction clear read_text; a purged run's documents never reuse one either way.
  const storedReads = new Map((await deps.sql<{ page_number: number; read_text: string }[]>`
    select s.page_number, s.read_text from document_page_states s
    join documents d on d.id = s.document_id
    join workspace_runs r on r.id = d.run_id
    where s.document_id = ${documentId} and s.page_number = any(${pages}::int[])
      and s.read_billed_run is not null and s.read_text is not null and s.state <> 'blocked-pii'
      and r.artifacts_purged_at is null
  `).map((row) => [row.page_number, row.read_text]));

  // 1. Text layer per contiguous range, then OCR only pages without one.
  const texts = new Map<number, string>();
  for (const range of contiguousPageRanges(pages)) {
    try {
      const rangeTexts = await ops.extractText(document, range);
      rangeTexts.forEach((text, i) => texts.set(range.first + i, text));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Text layer unavailable: treat every page as needing OCR.
      for (let p = range.first; p <= range.last; p += 1) texts.set(p, "");
      console.warn(`[materialize] text layer failed for ${documentId} p${range.first}-${range.last}: ${reason}`);
    }
  }
  // Quality decides which pages a model reads, as in the eager pipeline: Fast reads none (pages without a text layer
  // stay unread, kept as page images that render on demand), Good reads every page, Auto only pages without text.
  const readsPages = qualityAllowsPageReading(pipeline.quality);
  const readsEveryPage = qualityReadsEveryPage(pipeline.quality);
  const ocrPages: number[] = [];
  const keptUnread: number[] = [];
  for (const page of pages) {
    const stored = storedReads.get(page);
    if (stored !== undefined) {
      prepared.set(page, { page, text: stored });
      continue;
    }
    const text = texts.get(page) ?? "";
    const hasTextLayer = text.replace(/\s+/g, "").length >= MIN_TEXT_LAYER_CHARS;
    // Text-layer pages bill as Fast pages (charged by billLockedMaterializedPages as they turn indexed).
    if (readsEveryPage) ocrPages.push(page);
    else if (hasTextLayer) prepared.set(page, { page, text });
    else if (readsPages) ocrPages.push(page);
    else keptUnread.push(page);
  }
  for (const page of keptUnread) failed.set(page, KEPT_AS_IMAGE_REASON);
  const budgetCents = input.maxCredits > 0 ? input.maxCredits : Infinity; // 1 credit = 1 cent
  await mapLimit(ocrPages, OCR_CONCURRENCY, async (page) => {
    if (spentCents >= budgetCents) {
      released.push(page);
      failed.set(page, "credit-limit");
      return;
    }
    try {
      const ocr = await ops.ocrPage(document, page, { runId: input.runId, pipeline });
      const event = deps.usage.record({
        provider: ocr.provider ?? "vision-runtime",
        model: ocr.model,
        metric: "page-analysis",
        amount: 1,
        unit: "page",
        costCents: ocr.costCents,
        inputTokens: ocr.inputTokens,
        outputTokens: ocr.outputTokens,
        metadata: { ...ocr.metadata, documentId, pageNumber: page, materializedBy: input.reason, sessionId: input.sessionId },
      });
      // Customer credits: an OCR-read page bills Rich (the usage ledger charges it); provider cost is ours.
      void event;
      const richPages = richPagesForOutputTokens(ocr.outputTokens);
      const cost = pageCredits("rich", richPages);
      spentCents += cost;
      readCents.set(page, cost);
      if (ocr.text.replace(/\s+/g, "").length === 0) failed.set(page, "empty-page");
      else {
        prepared.set(page, { page, text: ocr.text });
        modelReads.set(page, richPages);
      }
    } catch (error) {
      // A page rejected on every attempt was still billed: record the summed spend and count it against the budget.
      const rejected = findVisionOutputRejected(error);
      if (rejected) {
        const usage = rejectedVisionUsageInput(rejected, rejected.costCents ?? calculateAiUsageCostCents({
          inputTokens: rejected.inputTokens,
          outputTokens: rejected.outputTokens,
          costPer1kInputTokens: deps.config.costPer1kInputTokens,
          costPer1kOutputTokens: deps.config.costPer1kOutputTokens,
        }), "vision-runtime");
        const event = deps.usage.record({
          ...usage,
          metadata: { ...usage.metadata, documentId, pageNumber: page, materializedBy: input.reason, sessionId: input.sessionId },
        });
        spentCents += event?.costCents ?? usage.costCents;
      }
      failed.set(page, error instanceof Error ? error.message : String(error));
    }
  });

  // 2. PII check with the workspace policy.
  const policy = resolvePolicy(pipeline);
  const scan = policy.enabled && policy.patterns.length > 0
    ? createPiiTextScanner(policy.patterns, policy.allowlistPatterns)
    : null;
  const blocked: number[] = [];
  /** Pages with any PII match: their read is never kept, so a retry re-reads under the policy in force then. */
  const piiMatched = new Set<number>();
  if (scan) {
    for (const entry of [...prepared.values()]) {
      const scanned = scan(entry.text, entry.page);
      if (scanned.matches.length === 0) continue;
      piiMatched.add(entry.page);
      if (policy.action === "block_indexing") {
        prepared.delete(entry.page);
        blocked.push(entry.page);
      } else if (policy.action === "redact_artifacts") {
        entry.text = scanned.redacted;
      }
    }
  }

  // 3. Chunk, with map headings when a document map exists.
  const mapRows = await deps.sql<{ nodes: unknown }[]>`select nodes from document_maps where document_id = ${documentId}`;
  const headingFor = headingPathsFromMap(mapRows[0]?.nodes);
  const chunks: Array<{ id: string; page: number; index: number; text: string; headingPath: string[] }> = [];
  for (const entry of [...prepared.values()].sort((a, b) => a.page - b.page)) {
    const mapHeading = headingFor(entry.page);
    let i = 0;
    for (const meta of chunkTextWithMeta(entry.text, CHUNK_MAX_CHARS)) {
      chunks.push({
        id: `${documentId}:p${entry.page}:g${generation}:c${i}`,
        page: entry.page,
        index: (entry.page - 1) * 1000 + i,
        text: meta.text,
        headingPath: meta.headingPath.length > 0 ? meta.headingPath : mapHeading,
      });
      i += 1;
    }
    if (i === 0) {
      prepared.delete(entry.page);
      failed.set(entry.page, "empty-page");
    } else if (modelReads.has(entry.page) && !piiMatched.has(entry.page)) {
      // A redacted read is not kept: a later block_indexing policy could not find the PII it removed.
      keptReads.set(entry.page, entry.text);
    }
  }

  // 4. Embed (batched). Nothing is published yet: pages, chunks and vectors are written in step 5, only for pages
  // this run still holds.
  const profile = resolveEmbeddingModel(deps.config, pipeline);
  let dims = profile.dimensions;
  const vectors: number[][] = [];
  if (chunks.length > 0) {
    try {
      for (let from = 0; from < chunks.length; from += EMBED_BATCH_CHUNKS) {
        const batch = chunks.slice(from, from + EMBED_BATCH_CHUNKS);
        let recordedRemote = false;
        const embedded = await ops.embed({
          chunks: batch.map((c) => c.text),
          profile,
          pipeline,
          onRemoteUsage: async ({ inputTokens, chunks: n, costCents, costMetadata }) => {
            recordedRemote = true;
            const priced = buildPricedAiUsageLedgerEvent({
              provider: profile.provider, model: profile.model, metric: "embedding-tokens", inputTokens,
              ...(costCents !== undefined ? { costCents, metadata: costMetadata } : {}),
            }, { fallback: { costPer1kInputTokens: deps.config.costPer1kInputTokens, costPer1kOutputTokens: 0 } });
            deps.usage.record({
              provider: profile.provider, model: profile.model, metric: "embedding-tokens",
              amount: inputTokens, unit: "token", inputTokens, costCents: priced.costCents,
              metadata: { ...priced.metadata, documentId, runtime: "remote", dimensions: profile.dimensions, chunks: n,
                tokenSource: "api", materializedBy: input.reason, sessionId: input.sessionId },
            });
          },
        });
        if (embedded.vectors.length !== batch.length) throw new Error("embedding provider returned a different number of vectors");
        vectors.push(...embedded.vectors);
        if (!recordedRemote) {
          const tokens = embedded.totalTokens ?? batch.reduce((sum, c) => sum + estimateTokens(c.text), 0);
          deps.usage.record({
            provider: profile.provider, model: profile.model, metric: "embedding-tokens",
            amount: tokens, unit: "token", inputTokens: tokens,
            costCents: profile.runtime === "remote" ? undefined : 0,
            metadata: { documentId, runtime: profile.runtime, dimensions: profile.dimensions, chunks: batch.length,
              tokenSource: embedded.totalTokens !== undefined ? "api" : "estimate", materializedBy: input.reason, sessionId: input.sessionId },
          });
        }
      }
      dims = vectors[0]?.length ?? dims;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const page of [...prepared.keys()]) failed.set(page, reason);
      prepared.clear();
    }
  }

  // 5. Publish and bill, fenced on the claim. One transaction locks the range's ledger rows (`for update`) and
  // publishes only the pages this run still holds (`claimed_by_run = runId`): their LanceDB vectors, document_pages,
  // document_chunks, stale-chunk cleanup, the state transition and (query/backfill) the billing decision. A page this
  // run lost publishes nothing, cleans up nothing and is billed by its owner. Another run cannot claim, publish or
  // bill these pages while the rows are locked.
  //
  // Vector ordering: LanceDB is outside Postgres. Vectors are upserted under the row locks, after the claim check and
  // before the commit. Their ids are this call's generation (`${documentId}:p${page}:g${generation}:c${i}`), written
  // by no other run or attempt, so deleting them can never remove another publication's vectors: not when a failed
  // write's cleanup runs after the page lock is released and a retry has republished the page, and not when a stale
  // cleanup runs late. The committed document_chunks rows name the live generation.
  //
  // Visibility: a vector is searchable only through a committed document_chunks row with its id. These records carry
  // no LanceDB hydration columns (the native backfill skips deferred chunks too), so both the Postgres and the native
  // (SEARCH_LANCEDB_NATIVE) vector paths hydrate them from document_chunks by id; vectors of an attempt that rolled
  // back are never served. They are deleted best effort, only when the transaction certainly rolled back (see the
  // catch below). Stale vectors (chunks this publication replaced) are deleted after the commit; their chunk rows went
  // with it, so they are already unsearchable.
  const rangePages = [...new Set([...pages])].sort((a, b) => a - b);
  const claimedBy = input.runId;
  const billsHere = input.reason !== "full-index";
  const location = workspaceVectorLocation(run, { model: profile.model, dimensions: dims }, deps.config.lancedb.root);
  let written: string[] = [];
  /** Customer credits of this call's committed billing decisions (billLockedMaterializedPages `credits`). */
  let chargedCredits = 0;
  let discard: string[] = [];
  let staleIds: string[] = [];
  let held = new Set<number>();
  let owned: number[] = [];
  const batches: Array<{ commit(): void }> = [];
  /** The transaction body finished: an error after this is from COMMIT, whose outcome is unknown. */
  let bodyDone = false;
  try {
    await deps.sql.begin(async (tx) => {
      const client = tx as unknown as Sql;
      // A document deleted meanwhile took its ledger rows with it: stop the range (the activity reports it), never
      // mistake the missing rows for a lost claim.
      const [exists] = await client`select 1 as one from documents where id = ${documentId} for share`;
      if (!exists) throw new DocumentNotFoundError(documentId);
      const locked = await lockPageRows(client as unknown as Sql<Record<string, unknown>>, documentId, rangePages);
      held = new Set(locked.filter((row) => row.claimed_by_run === claimedBy).map((row) => row.page_number));
      // A retained read can be cleared during extraction/embedding. Revalidate
      // it under the same page lock used by invalidation, before any vectors or
      // searchable rows are written. Never resurrect the copied old content.
      for (const row of locked) {
        if (!held.has(row.page_number) || !storedReads.has(row.page_number)) continue;
        if (row.read_text !== storedReads.get(row.page_number)) {
          prepared.delete(row.page_number);
          keptReads.delete(row.page_number);
          modelReads.delete(row.page_number);
          failed.set(row.page_number, "stored-read-invalidated");
        }
      }
      const publish = [...prepared.keys()].filter((page) => held.has(page)).sort((a, b) => a - b);
      let publishChunks = chunks.map((c, i) => ({ ...c, vector: vectors[i] })).filter((c) => held.has(c.page) && prepared.has(c.page));
      if (publishChunks.length > 0) {
        try {
          written = publishChunks.map((c) => c.id);
          await ops.writeVectors(location.uri, location.table, publishChunks.map((c) => ({
            id: c.id, documentId, chunkIndex: c.index, text: c.text, vector: c.vector!,
            metadata: { documentId, sourceKey: document.sourceKey, filename: document.filename, pageNumber: c.page },
          })));
        } catch (error) {
          // A partial write leaves ids with no chunk row of this publication: unsearchable, deleted below.
          const reason = error instanceof Error ? error.message : String(error);
          for (const page of publish) { failed.set(page, reason); prepared.delete(page); }
          discard = written;
          written = [];
          publishChunks = [];
        }
      }
      const publishedPages = [...prepared.values()].filter((p) => held.has(p.page));
      await insertPageRows(client, publishedPages.map((p) => ({
        id: `${documentId}-page-${String(p.page).padStart(4, "0")}`, documentId, runId: document.runId, userId: document.userId,
        pageNumber: p.page, text: p.text, tokenEstimate: estimateTokens(p.text),
      })));
      await insertChunkRows(client, publishChunks.map((c) => ({
        id: c.id, documentId, runId: document.runId, userId: document.userId, chunkIndex: c.index,
        text: c.text, headingPath: c.headingPath, pageNumber: c.page, tokenEstimate: estimateTokens(c.text),
        metadata: { pageNumber: c.page, materializedBy: input.reason, deferred: true, generation },
      })));
      if (publishChunks.length > 0) await linkChunksToPageRows(client, documentId, document.runId);

      // Stale chunks of re-chunked pages (and blocked pages that were indexed before), on held pages only.
      const cleanPages = [...new Set([...publishedPages.map((p) => p.page), ...blocked])].filter((page) => held.has(page));
      if (cleanPages.length > 0) {
        const keep = new Set(publishChunks.map((c) => c.id));
        // Every earlier generation of the page (and the pre-generation `:p<page>:c<i>` ids).
        const patterns = cleanPages.map((p) => `${documentId}:p${p}:%`);
        const existing = await client<{ id: string }[]>`
          select id from document_chunks where document_id = ${documentId} and id like any(${patterns}::text[])
        `;
        staleIds = existing.map((r) => r.id).filter((id) => !keep.has(id));
        if (staleIds.length > 0) await client`delete from document_chunks where document_id = ${documentId} and id = any(${staleIds}::text[])`;
      }

      // Ledger transitions, each fenced to pages this run still holds. A page's cost_credits is the customer charge
      // its billing decision committed (set below by billLockedMaterializedPages); 0 until then, and for full-index
      // pages, which the run completion fee bills.
      const moved = await markPages(client, documentId, publishedPages.map((p) => p.page), "indexed",
        { costCredits: 0, embeddingModel: profile.model, claimedBy });
      const ownedBlocked = blocked.filter((page) => held.has(page));
      if (ownedBlocked.length > 0) await markPages(client, documentId, ownedBlocked, "blocked-pii", { failureReason: "pii-policy", claimedBy });
      const byReason = new Map<string, number[]>();
      for (const [page, reason] of failed) {
        if (!held.has(page) || released.includes(page)) continue;
        byReason.set(reason, [...(byReason.get(reason) ?? []), page]);
      }
      for (const [reason, group] of byReason) await markPages(client, documentId, group, "failed", { failureReason: reason, claimedBy });
      const ownedReleased = released.filter((page) => held.has(page));
      if (ownedReleased.length > 0) await markPages(client, documentId, ownedReleased, "unseen", { claimedBy });
      owned = moved.sort((a, b) => a - b);
      // markPages cleared the kept reads of pages it indexed or blocked.

      const lost = rangePages.filter((page) => !held.has(page));
      if (billsHere) {
        // A genuine model read of a page this run lost is recorded on the page row: the page's one charge is Rich
        // whichever run publishes it (billLockedMaterializedPages), and only through that run's decision.
        const lostReads = lost.filter((page) => modelReads.has(page));
        if (lostReads.length > 0) {
          await client`
            update document_page_states s
            set model_read_run = coalesce(s.model_read_run, ${claimedBy}),
                model_read_pages = coalesce(s.model_read_pages, r.pages)
            from unnest(${lostReads}::int[], ${lostReads.map((page) => modelReads.get(page)!)}::int[]) as r(page, pages)
            where s.document_id = ${documentId} and s.page_number = r.page
          `;
        }
        // Held pages this call read (a pending Rich charge) that did not index: the read is the page's one charge.
        // Pages with any PII match (blocked or redacted) keep no text.
        const movedSet = new Set(moved);
        const failedReads = new Map([...held]
          .filter((page) => readCents.has(page) && !movedSet.has(page) && !released.includes(page))
          .map((page) => [page, blocked.includes(page) ? null : keptReads.get(page) ?? null]));
        const outcome = await billLockedMaterializedPages(client as unknown as Sql<Record<string, unknown>>, {
          runId: claimedBy, documentId, requested: publishedPages.map((p) => p.page).sort((a, b) => a - b), moved: movedSet,
          ledger: deps.usage, modelReads: new Map(lostReads.map((page) => [page, modelReads.get(page)!])), failedReads,
        });
        if (outcome.richBatch) batches.push(outcome.richBatch);
        chargedCredits = outcome.credits;
      }
      // Reads of pages this run lost (failed, empty or published elsewhere) stay provider usage: their pending Rich
      // charges are dropped, never persisted as a customer charge. Owned pages keep theirs (a read page that then
      // failed still bills Rich).
      if (lost.length > 0) {
        const lostSet = new Set(lost);
        const dropped = deps.usage.takeRichPageCharges(documentId, (page) => lostSet.has(page));
        if (dropped.events.length > 0) {
          console.warn(`[materialize] run=${claimedBy} document=${documentId} lost pages ${lost.join(",")}; dropped their pending Rich charges (provider usage only)`);
        }
        batches.push(dropped);
      }
      bodyDone = true;
    });
  } catch (error) {
    // A failed write's ids never got a chunk row. The ids written in full are this generation's own; delete them only
    // when the transaction certainly rolled back (the body threw). An error from COMMIT itself (a dropped connection)
    // may follow a commit that landed, whose chunk rows name these ids: they stay, unsearchable if it did roll back.
    const rollback = bodyDone ? discard : [...written, ...discard];
    if (bodyDone && written.length > 0) {
      console.warn(`[materialize] commit outcome unknown for ${documentId} (${error instanceof Error ? error.message : String(error)}); kept ${written.length} vectors of generation ${generation}`);
    }
    if (rollback.length > 0) {
      await ops.deleteVectors(location.uri, location.table, rollback).catch(async (cleanup: unknown) => {
        console.warn(`[materialize] vector rollback failed for ${documentId}: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`);
        await queueOrphanVectors(deps.sql, run, documentId, { model: profile.model, dimensions: dims }, rollback);
      });
    }
    // Vectors kept because COMMIT's outcome is unknown: the sweep deletes those no committed chunk row names.
    if (bodyDone && written.length > 0) await queueOrphanVectors(deps.sql, run, documentId, { model: profile.model, dimensions: dims }, written);
    throw error;
  }
  for (const batch of batches) batch.commit();
  const unpublished = [...staleIds.filter(() => Boolean(run.orgId && run.workspaceId)), ...discard];
  if (unpublished.length > 0) {
    await ops.deleteVectors(location.uri, location.table, unpublished).catch(async (error: unknown) => {
      console.warn(`[materialize] stale vector cleanup failed for ${documentId}: ${error instanceof Error ? error.message : String(error)}`);
      await queueOrphanVectors(deps.sql, run, documentId, { model: profile.model, dimensions: dims }, unpublished);
    });
  }

  // 6. Result: only what this run published and owns.
  const lostPages = rangePages.filter((page) => !held.has(page));
  if (lostPages.length > 0) {
    console.warn(`[materialize] run=${input.runId} document=${documentId} lost its claim on pages ${lostPages.join(",")}; published and billed nothing for them`);
  }
  result.indexed = owned;
  result.blocked = blocked.filter((page) => held.has(page)).sort((a, b) => a - b);
  for (const [page, reason] of [...failed].sort((a, b) => a[0] - b[0])) {
    if (held.has(page)) result.failed.push({ page, reason });
  }
  // Customer credits of the call: only the charges its billing decisions committed. A page an earlier read already
  // paid for (read_billed_run), reads dropped to provider usage and embedding batches (provider cost) add nothing.
  // Full-index pages are billed by the run completion fee.
  result.costCredits = Math.round(chargedCredits * 10_000) / 10_000;
  return result;
}

/** Delay before the sweep checks queued vector ids, so an in-flight COMMIT has settled. */
const ORPHAN_VECTOR_GRACE_MINUTES = 15;

/**
 * Hands vector ids whose delete failed (or whose commit outcome is unknown) to storage_cleanup_queue
 * (`vector_rows`). The sweep deletes, in the workspace's own LanceDB database, only the ids no document_chunks
 * row names (superseded-purge.ts drainStorageCleanupQueue), so a live publication's vectors are never removed.
 * Best effort: a failure is logged; such vectors stay unsearchable (no chunk row hydrates them).
 */
export async function queueOrphanVectors(
  sql: Sql,
  scope: { orgId?: string | null; workspaceId?: string | null },
  documentId: string,
  space: { model: string; dimensions: number },
  ids: string[],
): Promise<void> {
  if (ids.length === 0 || !scope.orgId || !scope.workspaceId) return;
  const target = `${documentId}#${randomBytes(8).toString("hex")}`;
  const payload = { workspaceId: scope.workspaceId, documentId, embeddingModel: space.model, dimension: space.dimensions, ids };
  try {
    await sql`
      insert into storage_cleanup_queue (kind, org_id, target, payload, reason, not_before)
      values ('vector_rows', ${scope.orgId}, ${target}, ${sql.json(payload as never)}, 'materialize-orphan-vectors',
        now() + (${ORPHAN_VECTOR_GRACE_MINUTES} * interval '1 minute'))
    `;
  } catch (error) {
    console.warn(`[materialize] could not queue ${ids.length} orphan vectors of ${documentId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
