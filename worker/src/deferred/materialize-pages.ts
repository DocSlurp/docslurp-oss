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
  ocrCostCents: number;
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
 * or `failed`. Chunk ids are `${documentId}:p${page}:c${i}`, so a replay upserts the same rows.
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
  let spentCents = 0;

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
    const text = texts.get(page) ?? "";
    const hasTextLayer = text.replace(/\s+/g, "").length >= MIN_TEXT_LAYER_CHARS;
    // Text-layer pages bill as Fast pages (charged by recordMaterializedPageFee as they turn indexed).
    if (readsEveryPage) ocrPages.push(page);
    else if (hasTextLayer) prepared.set(page, { page, text, ocrCostCents: pageCredits("fast", 1) });
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
        prepared.set(page, { page, text: ocr.text, ocrCostCents: cost });
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
  if (scan) {
    for (const entry of [...prepared.values()]) {
      const scanned = scan(entry.text, entry.page);
      if (scanned.matches.length === 0) continue;
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
        id: `${documentId}:p${entry.page}:c${i}`,
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
    }
  }

  // 4. Embed (batched). Nothing is published yet: pages, chunks and vectors are written in step 5, only for pages
  // this run still holds.
  let embeddingCents = 0;
  const costByPage = new Map<number, number>();
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
            const event = deps.usage.record({
              provider: profile.provider, model: profile.model, metric: "embedding-tokens",
              amount: inputTokens, unit: "token", inputTokens, costCents: priced.costCents,
              metadata: { ...priced.metadata, documentId, runtime: "remote", dimensions: profile.dimensions, chunks: n,
                tokenSource: "api", materializedBy: input.reason, sessionId: input.sessionId },
            });
            embeddingCents += event?.costCents ?? priced.costCents;
          },
        });
        if (embedded.vectors.length !== batch.length) throw new Error("embedding provider returned a different number of vectors");
        vectors.push(...embedded.vectors);
        if (!recordedRemote) {
          const tokens = embedded.totalTokens ?? batch.reduce((sum, c) => sum + estimateTokens(c.text), 0);
          const event = deps.usage.record({
            provider: profile.provider, model: profile.model, metric: "embedding-tokens",
            amount: tokens, unit: "token", inputTokens: tokens,
            costCents: profile.runtime === "remote" ? undefined : 0,
            metadata: { documentId, runtime: profile.runtime, dimensions: profile.dimensions, chunks: batch.length,
              tokenSource: embedded.totalTokens !== undefined ? "api" : "estimate", materializedBy: input.reason, sessionId: input.sessionId },
          });
          embeddingCents += event?.costCents ?? 0;
        }
      }
      dims = vectors[0]?.length ?? dims;
      const perChunkCents = embeddingCents / chunks.length;
      for (const c of chunks) costByPage.set(c.page, (costByPage.get(c.page) ?? 0) + perChunkCents);
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
  // before the commit, so a run that lost its claim never writes a vector id another run published (ids are
  // `${documentId}:p${page}:c${i}`, shared by every run). Search only returns a vector whose id has a committed
  // document_chunks row (server vectorSearch hydrates by id), so vectors of an attempt that then rolls back are never
  // visible; they are deleted best effort, and the page stays this run's claim for the retry, which upserts the same
  // ids. Stale vectors (chunks this publication replaced) are deleted after the commit; their chunk rows are gone
  // with it, so they are already unsearchable.
  const rangePages = [...new Set([...pages])].sort((a, b) => a - b);
  const claimedBy = input.runId;
  const billsHere = input.reason !== "full-index";
  const location = workspaceVectorLocation(run, { model: profile.model, dimensions: dims }, deps.config.lancedb.root);
  let written: string[] = [];
  let staleIds: string[] = [];
  let held = new Set<number>();
  let owned: number[] = [];
  const batches: Array<{ commit(): void }> = [];
  try {
    await deps.sql.begin(async (tx) => {
      const client = tx as unknown as Sql;
      // A document deleted meanwhile took its ledger rows with it: stop the range (the activity reports it), never
      // mistake the missing rows for a lost claim.
      const [exists] = await client`select 1 as one from documents where id = ${documentId} for share`;
      if (!exists) throw new DocumentNotFoundError(documentId);
      const locked = await lockPageRows(client as unknown as Sql<Record<string, unknown>>, documentId, rangePages);
      held = new Set(locked.filter((row) => row.claimed_by_run === claimedBy).map((row) => row.page_number));
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
          const reason = error instanceof Error ? error.message : String(error);
          for (const page of publish) { failed.set(page, reason); prepared.delete(page); }
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
        metadata: { pageNumber: c.page, materializedBy: input.reason, deferred: true },
      })));
      if (publishChunks.length > 0) await linkChunksToPageRows(client, documentId, document.runId);

      // Stale chunks of re-chunked pages (and blocked pages that were indexed before), on held pages only.
      const cleanPages = [...new Set([...publishedPages.map((p) => p.page), ...blocked])].filter((page) => held.has(page));
      if (cleanPages.length > 0) {
        const keep = new Set(publishChunks.map((c) => c.id));
        const patterns = cleanPages.map((p) => `${documentId}:p${p}:c%`);
        const existing = await client<{ id: string }[]>`
          select id from document_chunks where document_id = ${documentId} and id like any(${patterns}::text[])
        `;
        staleIds = existing.map((r) => r.id).filter((id) => !keep.has(id));
        if (staleIds.length > 0) await client`delete from document_chunks where document_id = ${documentId} and id = any(${staleIds}::text[])`;
      }

      // Ledger transitions, each fenced to pages this run still holds.
      const indexedByCost = new Map<number, number[]>();
      for (const entry of publishedPages) {
        const credits = Math.round(((entry.ocrCostCents + (costByPage.get(entry.page) ?? 0))) * 10_000) / 10_000;
        indexedByCost.set(credits, [...(indexedByCost.get(credits) ?? []), entry.page]);
      }
      const moved: number[] = [];
      for (const [credits, group] of indexedByCost) {
        moved.push(...await markPages(client, documentId, group, "indexed", { costCredits: credits, embeddingModel: profile.model, claimedBy }));
      }
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
        const outcome = await billLockedMaterializedPages(client as unknown as Sql<Record<string, unknown>>, {
          runId: claimedBy, documentId, requested: publishedPages.map((p) => p.page).sort((a, b) => a - b), moved: new Set(moved),
          ledger: deps.usage, modelReads: new Map(lostReads.map((page) => [page, modelReads.get(page)!])),
        });
        if (outcome.richBatch) batches.push(outcome.richBatch);
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
    });
  } catch (error) {
    if (written.length > 0) {
      // The transaction rolled back: these ids have no committed chunk row, so they are unsearchable; drop them.
      await ops.deleteVectors(location.uri, location.table, written).catch((cleanup: unknown) => {
        console.warn(`[materialize] vector rollback failed for ${documentId}: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`);
      });
    }
    throw error;
  }
  for (const batch of batches) batch.commit();
  if (staleIds.length > 0 && run.orgId && run.workspaceId) {
    await ops.deleteVectors(location.uri, location.table, staleIds).catch((error: unknown) => {
      console.warn(`[materialize] stale vector cleanup failed for ${documentId}: ${error instanceof Error ? error.message : String(error)}`);
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
  // Customer credits of the call: every OCR-read page it still owned (Rich, including pages that then failed) and
  // every text-layer page that indexed (Fast). Embedding batches are provider cost (0 credits).
  const ocrSet = new Set(ocrPages);
  const ownedReadCents = [...held].reduce((sum, page) => sum + (readCents.get(page) ?? 0), 0);
  const fastIndexed = result.indexed.filter((page) => !ocrSet.has(page)).length;
  result.costCredits = Math.round((ownedReadCents + embeddingCents + pageCredits("fast", fastIndexed)) * 10_000) / 10_000;
  return result;
}
