import { rm } from "node:fs/promises";
import path from "node:path";

import type { Sql } from "postgres";

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
import { isMissingDocumentError } from "../db/missing-document.js";
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
    // Text-layer pages bill as Fast pages (charged by recordMaterializedPageFee).
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
      const cost = pageCredits("rich", richPagesForOutputTokens(ocr.outputTokens));
      spentCents += cost;
      if (ocr.text.replace(/\s+/g, "").length === 0) failed.set(page, "empty-page");
      else prepared.set(page, { page, text: ocr.text, ocrCostCents: cost });
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

  // 4. Embed (batched), persist, index.
  let embeddingCents = 0;
  const costByPage = new Map<number, number>();
  const profile = resolveEmbeddingModel(deps.config, pipeline);
  let dims = profile.dimensions;
  if (chunks.length > 0) {
    try {
      const vectors: number[][] = [];
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

      const dbChunks = chunks.map((c) => ({
        id: c.id, documentId, runId: document.runId, userId: document.userId, chunkIndex: c.index,
        text: c.text, headingPath: c.headingPath, pageNumber: c.page, tokenEstimate: estimateTokens(c.text),
        metadata: { pageNumber: c.page, materializedBy: input.reason, deferred: true },
      }));
      await deps.store.insertPages([...prepared.values()].map((p) => ({
        id: `${documentId}-page-${String(p.page).padStart(4, "0")}`, documentId, runId: document.runId, userId: document.userId,
        pageNumber: p.page, text: p.text, tokenEstimate: estimateTokens(p.text),
      })));
      await deps.store.insertChunks(dbChunks);
      await deps.store.linkChunksToPages(documentId, document.runId);

      const location = workspaceVectorLocation(run, { model: profile.model, dimensions: dims }, deps.config.lancedb.root);
      await ops.writeVectors(location.uri, location.table, chunks.map((c, i) => ({
        id: c.id, documentId, chunkIndex: c.index, text: c.text, vector: vectors[i]!,
        metadata: { documentId, sourceKey: document.sourceKey, filename: document.filename, pageNumber: c.page },
      })));

      const perChunkCents = embeddingCents / chunks.length;
      for (const c of chunks) costByPage.set(c.page, (costByPage.get(c.page) ?? 0) + perChunkCents);
    } catch (error) {
      // A deleted document is not a page failure: let the activity stop the whole range cleanly.
      if (isMissingDocumentError(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      for (const page of [...prepared.keys()]) failed.set(page, reason);
      prepared.clear();
    }
  }

  // 4b. Drop stale chunks of re-chunked pages (and blocked pages that were indexed before).
  const cleanPages = [...new Set([...prepared.keys(), ...blocked])];
  if (cleanPages.length > 0) {
    try {
      const keep = new Set(prepared.size > 0 ? chunks.filter((c) => prepared.has(c.page)).map((c) => c.id) : []);
      const patterns = cleanPages.map((p) => `${documentId}:p${p}:c%`);
      const existing = await deps.sql<{ id: string }[]>`
        select id from document_chunks where document_id = ${documentId} and id like any(${patterns}::text[])
      `;
      const stale = existing.map((r) => r.id).filter((id) => !keep.has(id));
      if (stale.length > 0) {
        if (run.orgId && run.workspaceId) {
          const loc = workspaceVectorLocation(run, { model: profile.model, dimensions: dims }, deps.config.lancedb.root);
          await ops.deleteVectors(loc.uri, loc.table, stale);
        }
        await deps.sql`delete from document_chunks where document_id = ${documentId} and id = any(${stale}::text[])`;
      }
    } catch (error) {
      console.warn(`[materialize] stale chunk cleanup failed for ${documentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 5. Ledger: one statement per distinct outcome/cost.
  const indexedByCost = new Map<number, number[]>();
  for (const entry of prepared.values()) {
    const credits = Math.round(((entry.ocrCostCents + (costByPage.get(entry.page) ?? 0))) * 10_000) / 10_000;
    result.indexed.push(entry.page);
    indexedByCost.set(credits, [...(indexedByCost.get(credits) ?? []), entry.page]);
  }
  result.indexed.sort((a, b) => a - b);
  result.blocked = blocked.sort((a, b) => a - b);
  for (const [page, reason] of [...failed].sort((a, b) => a[0] - b[0])) result.failed.push({ page, reason });
  // Customer credits of the call: every OCR-read page (Rich, including pages that then failed) and
  // every text-layer page that indexed (Fast). Embedding batches are provider cost (0 credits).
  const fastIndexed = result.indexed.filter((page) => !ocrPages.includes(page)).length;
  result.costCredits = Math.round((spentCents + embeddingCents + pageCredits("fast", fastIndexed)) * 10_000) / 10_000;

  const writes: Promise<void>[] = [];
  for (const [credits, group] of indexedByCost) {
    writes.push(markPages(deps.sql, documentId, group, "indexed", {
      costCredits: credits, embeddingModel: profile.model,
      // Full-index pages are charged by the run's completion fee (recordPageBaseFee), not stamped here.
      feeRun: input.reason === "full-index" ? undefined : input.runId,
    }));
  }
  if (blocked.length > 0) writes.push(markPages(deps.sql, documentId, blocked, "blocked-pii", { failureReason: "pii-policy" }));
  const hardFailed = result.failed.filter((f) => !released.includes(f.page));
  const byReason = new Map<string, number[]>();
  for (const f of hardFailed) byReason.set(f.reason, [...(byReason.get(f.reason) ?? []), f.page]);
  for (const [reason, group] of byReason) writes.push(markPages(deps.sql, documentId, group, "failed", { failureReason: reason }));
  if (released.length > 0) writes.push(markPages(deps.sql, documentId, released, "unseen"));
  // A single postgres connection serializes these; awaiting together keeps code simple.
  await Promise.all(writes);
  return result;
}
